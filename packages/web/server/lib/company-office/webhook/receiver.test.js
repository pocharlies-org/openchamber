import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { describe, expect, test, vi } from 'vitest';
import {
  registerJiraWebhookRoutes,
  verifySignature,
  extractIssueKey,
  createDeduper,
  createTicketQueue,
} from './receiver.js';

const SECRET = 'a-test-secret-that-is-long-enough-32b';
const sign = (body) => `sha256=${crypto.createHmac('sha256', SECRET).update(body).digest('hex')}`;
const payload = (key = 'SC-1') => JSON.stringify({
  webhookEvent: 'jira:issue_updated',
  issue: { key, fields: { issuetype: { name: 'Epic' } } },
});

const mount = ({ dispatch = vi.fn(async () => ({ action: 'noop' })), report = () => {}, extra = {} } = {}) => {
  const app = express();
  registerJiraWebhookRoutes(app, {
    secret: SECRET,
    installationId: 'inst-1',
    allowedProjectKeys: ['SC'],
    dispatch,
    report,
    ...extra,
  });
  return { app, dispatch };
};

describe('verifySignature', () => {
  test('accepts a matching sha256 signature over the raw body', () => {
    const body = payload();
    expect(verifySignature({ rawBody: Buffer.from(body), secret: SECRET, header: sign(body) })).toBe(true);
  });
  test('rejects a tampered body', () => {
    expect(verifySignature({ rawBody: Buffer.from(payload('SC-2')), secret: SECRET, header: sign(payload('SC-1')) })).toBe(false);
  });
  test('rejects a missing secret or header', () => {
    expect(verifySignature({ rawBody: Buffer.from('x'), secret: '', header: 'sha256=deadbeef' })).toBe(false);
    expect(verifySignature({ rawBody: Buffer.from('x'), secret: SECRET, header: undefined })).toBe(false);
  });
});

describe('extractIssueKey', () => {
  test('reads the key from an issue event', () => {
    expect(extractIssueKey(JSON.parse(payload('SC-42')))).toBe('SC-42');
  });
  test('null for a non-issue payload', () => {
    expect(extractIssueKey({ webhookEvent: 'comment_created' })).toBeNull();
  });
});

describe('createDeduper', () => {
  test('first key is fresh, repeat is duplicate', () => {
    let clock = 0;
    const d = createDeduper({ ttlMs: 1000, now: () => clock });
    expect(d.isDuplicate('k')).toBe(false);
    expect(d.isDuplicate('k')).toBe(true);
    clock = 1001;
    expect(d.isDuplicate('k')).toBe(false);
  });
});

describe('createTicketQueue', () => {
  test('serializes per ticket and isolates across tickets', async () => {
    const q = createTicketQueue();
    const order = [];
    const task = (ticket, label, ms) => q.enqueue(ticket, () => new Promise((r) => setTimeout(() => { order.push(label); r(); }, ms)));
    await Promise.all([task('a', 'a1', 20), task('a', 'a2', 1), task('b', 'b1', 1)]);
    // Same-ticket tasks run in enqueue order (a1 before a2); a different ticket
    // is never blocked behind a slow one, so b1 finishes before the slow a1.
    expect(order.indexOf('a1')).toBeLessThan(order.indexOf('a2'));
    expect(order.indexOf('b1')).toBeLessThan(order.indexOf('a1'));
  });
});

describe('Jira webhook receiver', () => {
  test('accepts a signed issue event and enqueues dispatch', async () => {
    const { app, dispatch } = mount();
    const body = payload('SC-7');
    const res = await request(app)
      .post('/integrations/jira/v1/webhook/inst-1')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature', sign(body))
      .set('X-Atlassian-Webhook-Identifier', 'id-1')
      .send(body)
      .expect(202);
    expect(res.body).toEqual({ status: 'accepted', ticketKey: 'SC-7' });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledWith('SC-7'));
  });

  test('rejects an invalid signature with 401 and never dispatches', async () => {
    const { app, dispatch } = mount();
    await request(app)
      .post('/integrations/jira/v1/webhook/inst-1')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature', 'sha256=deadbeef')
      .send(payload())
      .expect(401);
    expect(dispatch).not.toHaveBeenCalled();
  });

  test('deduplicates a repeated webhook identifier', async () => {
    const { app, dispatch } = mount();
    const body = payload('SC-9');
    const headers = { 'Content-Type': 'application/json', 'X-Hub-Signature': sign(body), 'X-Atlassian-Webhook-Identifier': 'dup-1' };
    await request(app).post('/integrations/jira/v1/webhook/inst-1').set(headers).send(body).expect(202);
    const second = await request(app).post('/integrations/jira/v1/webhook/inst-1').set(headers).send(body).expect(200);
    expect(second.body.status).toBe('duplicate');
    await new Promise((r) => setTimeout(r, 10));
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  test('ignores a non-issue event', async () => {
    const { app, dispatch } = mount();
    const body = JSON.stringify({ webhookEvent: 'comment_created' });
    const res = await request(app)
      .post('/integrations/jira/v1/webhook/inst-1')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature', sign(body))
      .send(body)
      .expect(200);
    expect(res.body.reason).toBe('not_issue_updated');
    expect(dispatch).not.toHaveBeenCalled();
  });

  test('ignores a project outside the allowlist', async () => {
    const { app, dispatch } = mount();
    const body = payload('OTHER-1');
    const res = await request(app)
      .post('/integrations/jira/v1/webhook/inst-1')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature', sign(body))
      .send(body)
      .expect(200);
    expect(res.body.reason).toBe('project_not_allowed');
    expect(dispatch).not.toHaveBeenCalled();
  });

  test('reports 503 when no secret is configured', async () => {
    const app = express();
    registerJiraWebhookRoutes(app, { installationId: 'inst-1', allowedProjectKeys: ['SC'], dispatch: vi.fn() });
    const body = payload();
    await request(app)
      .post('/integrations/jira/v1/webhook/inst-1')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature', sign(body))
      .send(body)
      .expect(503);
  });
});

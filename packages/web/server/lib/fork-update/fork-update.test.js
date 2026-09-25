import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { parseWorkflowRun, dispatchForkUpdate, getForkUpdateStatus } from './pipeline.js';
import { registerForkUpdateRoutes } from './routes.js';

const jsonResponse = (payload, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => payload,
  text: async () => JSON.stringify(payload),
});

const emptyResponse = (status = 204) => ({ ok: status < 400, status, text: async () => '' });

describe('parseWorkflowRun', () => {
  it('reports an in-progress run as running without reading a conclusion', () => {
    expect(parseWorkflowRun({ id: 7, status: 'in_progress', html_url: 'https://x/7' })).toEqual({
      runId: 7,
      htmlUrl: 'https://x/7',
      state: 'running',
      stage: null,
    });
  });

  it('names the step a running build is in, so the wait is not a blank box', () => {
    const parsed = parseWorkflowRun({
      id: 7,
      status: 'in_progress',
      jobs: [
        { name: 'Bundle + tarball + puerta de marcas', conclusion: 'success' },
        { name: 'Esperar la ventana de promocion', status: 'in_progress' },
      ],
    });

    expect(parsed.state).toBe('running');
    expect(parsed.stage).toBe('Esperar la ventana de promocion');
  });

  it('names the job that failed so the message is actionable', () => {
    const parsed = parseWorkflowRun({
      id: 9,
      status: 'completed',
      conclusion: 'failure',
      jobs: [
        { name: 'Rebase de la pila', conclusion: 'success' },
        { name: 'Puertas (type-check y tests)', conclusion: 'failure' },
      ],
    });

    expect(parsed.state).toBe('failed');
    expect(parsed.stage).toBe('Puertas (type-check y tests)');
  });

  it('keeps an unreadable run distinct from a failed one', () => {
    expect(parseWorkflowRun({ id: 1, status: 'completed', conclusion: 'stale' })).toEqual({
      runId: 1,
      htmlUrl: null,
      state: 'unknown',
    });
  });
});

describe('dispatchForkUpdate', () => {
  it('refuses to start anything without a credential', async () => {
    const calls = [];
    const result = await dispatchForkUpdate({
      tokenOverride: '',
      fetchImpl: async () => { calls.push(1); return emptyResponse(); },
    });

    expect(result).toEqual({ started: false, reason: 'no-credential' });
    expect(calls).toEqual([]);
  });

  it('treats 204 as started', async () => {
    const result = await dispatchForkUpdate({
      tokenOverride: 'tok',
      fetchImpl: async () => emptyResponse(204),
    });

    expect(result).toEqual({ started: true });
  });

  it('runs the workflow from the pipeline repo and builds the fork trunk', async () => {
    let sent;
    await dispatchForkUpdate({
      tokenOverride: 'tok',
      fetchImpl: async (_url, init) => { sent = JSON.parse(init.body); return emptyResponse(204); },
    });

    // The top-level ref is a branch of the pipeline repo; the app ref travels as an input.
    expect(sent.ref).toBe('main');
    expect(sent.inputs.ref).toBe('build/v2.0.1-metrics');
  });

  it('labels an expired credential instead of reporting a generic failure', async () => {
    const result = await dispatchForkUpdate({
      tokenOverride: 'tok',
      fetchImpl: async () => jsonResponse({ message: 'Bad credentials' }, 401),
    });

    expect(result).toEqual({ started: false, reason: 'not-authorized' });
  });
});

describe('getForkUpdateStatus', () => {
  it('says idle when the pipeline has never run, which is not a failure', async () => {
    const status = await getForkUpdateStatus({
      tokenOverride: 'tok',
      fetchImpl: async () => jsonResponse({ workflow_runs: [] }),
    });

    expect(status).toEqual({ state: 'idle' });
  });

  it('reports a transport failure as unreachable rather than idle', async () => {
    const status = await getForkUpdateStatus({
      tokenOverride: 'tok',
      fetchImpl: async () => { throw new Error('socket hang up'); },
    });

    expect(status.state).toBe('unreachable');
    expect(status.detail).toContain('socket hang up');
  });
});

describe('POST /api/openchamber/fork-update/dispatch', () => {
  const buildApp = (fetchImpl) => {
    const app = express();
    registerForkUpdateRoutes(app, { express, fetchImpl, tokenOverride: 'tok' });
    return app;
  };

  it('rejects an unconfirmed request before touching the pipeline', async () => {
    let dispatched = 0;
    const response = await request(buildApp(async () => { dispatched += 1; return emptyResponse(); }))
      .post('/api/openchamber/fork-update/dispatch')
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.reason).toBe('confirmation-required');
    expect(dispatched).toBe(0);
  });

  it('accepts a confirmed request with 202', async () => {
    const response = await request(buildApp(async () => emptyResponse(204)))
      .post('/api/openchamber/fork-update/dispatch')
      .send({ confirm: true });

    expect(response.status).toBe(202);
    expect(response.body.started).toBe(true);
  });

  it('explains a machine with no credential in terms of what to do', async () => {
    const app = express();
    registerForkUpdateRoutes(app, { express, fetchImpl: async () => emptyResponse(204), tokenOverride: '' });

    const response = await request(app)
      .post('/api/openchamber/fork-update/dispatch')
      .send({ confirm: true });

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch('GitHub credential');
  });
});

import { describe, expect, test } from 'vitest';
import { createHmac, webcrypto } from 'node:crypto';
import {
  signHeartbeat,
  createCompanyStatePublisher,
  createForgeHeartbeatPublisher,
  createForgeRolesLoader,
} from './forge-outbound.js';

const SECRET = 'x'.repeat(48);
const URL_OK = 'https://xxx.hello.atlassian-dev.net/x1/abc';

const publisherWith = (fetchImpl, overrides = {}) => createForgeHeartbeatPublisher({
  webTriggerUrl: URL_OK,
  secret: SECRET,
  fetchImpl,
  now: () => 1_700_000_000_000,
  ...overrides,
});

const heartbeat = { schemaVersion: 1, ticketKey: 'SC-21', sessionId: 'ses_1', state: 'busy' };

describe('heartbeat signing', () => {
  test('signs timestamp and body together so a capture cannot be replayed later', () => {
    const body = JSON.stringify(heartbeat);
    const header = signHeartbeat({ body, secret: SECRET, timestampSec: 1_700_000_000 });
    const expected = createHmac('sha256', SECRET).update(`1700000000.${body}`).digest('hex');
    expect(header).toBe(`t=1700000000,v1=${expected}`);

    // the timestamp is inside the signed material, not merely alongside it
    const shifted = signHeartbeat({ body, secret: SECRET, timestampSec: 1_700_000_001 });
    expect(shifted.split('v1=')[1]).not.toBe(expected);
  });

  test('a different body cannot reuse a signature', () => {
    const a = signHeartbeat({ body: '{"a":1}', secret: SECRET, timestampSec: 1 });
    const b = signHeartbeat({ body: '{"a":2}', secret: SECRET, timestampSec: 1 });
    expect(a).not.toBe(b);
  });

  test('refuses a weak secret and a non-integer timestamp', () => {
    expect(() => signHeartbeat({ body: '{}', secret: 'short', timestampSec: 1 }))
      .toThrow(/at least 32 characters/);
    expect(() => signHeartbeat({ body: '{}', secret: SECRET, timestampSec: 1.5 }))
      .toThrow(/must be an integer/);
  });

  test('the signature verifies with the same primitive the Forge trigger uses', async () => {
    const body = JSON.stringify(heartbeat);
    const header = signHeartbeat({ body, secret: SECRET, timestampSec: 1_700_000_000 });
    const hex = header.split('v1=')[1];
    const key = await webcrypto.subtle.importKey(
      'raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
    );
    const valid = await webcrypto.subtle.verify(
      'HMAC', key,
      Uint8Array.from(hex.match(/.{2}/g).map((b) => Number.parseInt(b, 16))),
      new TextEncoder().encode(`1700000000.${body}`),
    );
    expect(valid).toBe(true);
  });
});

describe('outbound heartbeat publishing', () => {
  test('pushes to Atlassian with the signature header and never opens a port here', async () => {
    const sent = [];
    const publisher = publisherWith(async (url, options) => {
      sent.push({ url: String(url), method: options.method, headers: options.headers, body: options.body });
      return new Response('{}', { status: 202 });
    });

    expect(await publisher.publish(heartbeat)).toEqual({ state: 'ready' });
    expect(sent[0].method).toBe('POST');
    expect(sent[0].url).toBe(URL_OK);
    expect(sent[0].headers['X-Company-Office-Signature']).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
    expect(JSON.parse(sent[0].body)).toEqual(heartbeat);
  });

  test('reports transport failure instead of stopping the dispatch loop', async () => {
    expect(await publisherWith(async () => new Response('{}', { status: 500 })).publish(heartbeat))
      .toEqual({ state: 'error', reason: 'status_500' });

    expect(await publisherWith(async () => { throw new Error('ECONNREFUSED'); }).publish(heartbeat))
      .toEqual({ state: 'error', reason: 'unreachable' });

    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    expect(await publisherWith(async () => { throw timeout; }).publish(heartbeat))
      .toEqual({ state: 'error', reason: 'timeout' });
  });

  test('refuses an oversized heartbeat rather than shipping it', async () => {
    let called = false;
    const publisher = publisherWith(async () => { called = true; return new Response('{}', { status: 202 }); });
    const result = await publisher.publish({ ...heartbeat, filler: 'y'.repeat(70_000) });
    expect(result).toEqual({ state: 'error', reason: 'heartbeat_too_large' });
    expect(called).toBe(false);
  });

  test('refuses a plaintext web trigger URL', () => {
    expect(() => createForgeHeartbeatPublisher({ webTriggerUrl: 'http://x.test/x1/a', secret: SECRET }))
      .toThrow(/must use HTTPS/);
  });
});

describe('company state publishing', () => {
  test('pushes the company snapshot through the signed channel', async () => {
    const sent = [];
    const publisher = createCompanyStatePublisher({
      webTriggerUrl: URL_OK,
      secret: SECRET,
      now: () => 1_700_000_000_000,
      fetchImpl: async (_url, options) => {
        sent.push(options);
        return new Response('{}', { status: 202 });
      },
    });
    const state = { schemaVersion: 1, roles: [{ id: 'developer' }] };
    expect(await publisher.publish(state)).toEqual({ state: 'ready' });
    expect(JSON.parse(sent[0].body)).toEqual(state);
    expect(sent[0].headers['X-Company-Office-Signature']).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
  });

  test('refuses a snapshot beyond the Forge storage boundary', async () => {
    let called = false;
    const publisher = createCompanyStatePublisher({
      webTriggerUrl: URL_OK,
      secret: SECRET,
      fetchImpl: async () => { called = true; return new Response('{}', { status: 202 }); },
    });
    expect(await publisher.publish({ schemaVersion: 1, roles: [], filler: 'x'.repeat(525_000) }))
      .toEqual({ state: 'error', reason: 'company_state_too_large' });
    expect(called).toBe(false);
  });
});

describe('role configuration loading', () => {
  test('pulls roles with a signed body', async () => {
    const calls = [];
    const load = createForgeRolesLoader({
      webTriggerUrl: URL_OK,
      secret: SECRET,
      now: () => 1_700_000_000_000,
      fetchImpl: async (_url, options) => {
        calls.push(options);
        return Response.json({ roles: [{ id: 'developer' }] });
      },
    });
    expect(await load()).toEqual({ roles: [{ id: 'developer' }] });
    expect(calls[0].body).toBe('{}');
    expect(calls[0].headers['X-Company-Office-Signature']).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
  });

  test('rejects a failed pull instead of treating it as empty roles', async () => {
    const load = createForgeRolesLoader({
      webTriggerUrl: URL_OK,
      secret: SECRET,
      fetchImpl: async () => new Response('{}', { status: 503 }),
    });
    await expect(load()).rejects.toThrow('Forge roles pull failed (503)');
  });
});

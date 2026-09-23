import express from 'express';
import request from 'supertest';
import nodeCrypto from 'crypto';
import { describe, expect, it } from 'vitest';

import { createClaudeSurface, namespaceEventIds } from './routes.js';

/**
 * The Claude surface is registered before the OpenCode proxy and intercepts
 * POST /api/session to find out whether the session is its own, which consumes
 * the request stream. Sessions that are not Claude's fall through to the proxy,
 * and the proxy can only replay an already-consumed body from `req.body` (see
 * `serializeParsedBody` in lib/opencode/proxy.js).
 *
 * While the body read here was dropped, every OpenCode session created from the
 * UI reached OpenCode with the original content-length and no payload: OpenCode
 * waited for bytes that never arrived and the composer reported a failure. The
 * request never errored, so only an end-to-end test over real HTTP sees it.
 */
describe('POST /api/session fall-through to the OpenCode proxy', () => {
  const createApp = () => {
    const app = express();
    createClaudeSurface({}).register(app);
    // Stands in for the proxy mounted after the Claude surface: it reports what
    // the proxy would have had available to replay.
    app.post('/api/session', (req, res) => res.json({ replayable: req.body ?? null }));
    return app;
  };

  it('leaves the consumed body on the request for the proxy to replay', async () => {
    const payload = { title: 'session', directory: '/tmp/project' };

    const response = await request(createApp()).post('/api/session').send(payload);

    expect(response.status).toBe(200);
    expect(response.body.replayable).toEqual(payload);
  });

  it('keeps a body it cannot parse as raw bytes instead of an empty object', async () => {
    const response = await request(createApp())
      .post('/api/session')
      .set('content-type', 'application/json')
      .send('not json');

    expect(response.status).toBe(200);
    expect(Buffer.from(response.body.replayable.data).toString('utf8')).toBe('not json');
  });
});

describe('namespaceEventIds', () => {
  const SESSION_UUID = '99de08cb-d25d-5f13-97b4-b0e6a44c757d';

  it('namespaces a session event id with the session prefix', () => {
    const namespaced = namespaceEventIds({
      type: 'session.deleted',
      properties: { info: { id: SESSION_UUID, directory: '/tmp/project' }, directory: '/tmp/project' },
    });

    expect(namespaced.properties.info.id).toMatch(/^ses_ccc/);
    expect(namespaced.properties.info.id).toBe(`ses_ccc${SESSION_UUID}`);
  });

  it('namespaces a message event id with the message prefix', () => {
    const namespaced = namespaceEventIds({
      type: 'message.updated',
      properties: {
        sessionID: SESSION_UUID,
        info: { id: 'msg_1', role: 'assistant', sessionID: SESSION_UUID },
      },
    });

    expect(namespaced.properties.info.id).toBe('claude:msg_1');
    expect(namespaced.properties.info.sessionID).toBe(`ses_ccc${SESSION_UUID}`);
    expect(namespaced.properties.sessionID).toBe(`ses_ccc${SESSION_UUID}`);
  });

  it('namespaces part ids and leaves an already namespaced id alone', () => {
    const namespaced = namespaceEventIds({
      type: 'message.part.updated',
      properties: {
        part: { id: 'p1', sessionID: SESSION_UUID, messageID: 'msg_1' },
      },
    });

    expect(namespaced.properties.part.messageID).toBe('claude:msg_1');
    expect(namespaced.properties.part.sessionID).toBe(`ses_ccc${SESSION_UUID}`);

    const twice = namespaceEventIds({
      type: 'message.updated',
      properties: { info: { id: 'claude:msg_1' } },
    });
    expect(twice.properties.info.id).toBe('claude:msg_1');
  });
});

describe('POST /api/session/:id/prompt_async', () => {
  const createApp = (query) => {
    const app = express();
    const sdk = query
      ? {
        listSessions: async () => [],
        getSessionMessages: async () => [],
        getSessionInfo: async () => null,
        renameSession: async () => {},
        query,
      }
      : null;
    createClaudeSurface({
      crypto: nodeCrypto,
      fsPromises: { readFile: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } },
      claudeExecutable: '/usr/bin/claude',
      sdkLoader: async () => sdk,
    }).register(app);
    return app;
  };

  it('answers once the turn is accepted, while the turn is still running', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const query = () => (async function* stream() {
      await gate;
      yield { type: 'result', is_error: false };
    })();

    const response = await request(createApp(query))
      .post('/api/session/ses_cccsess-1/prompt_async')
      .send({ parts: [{ type: 'text', text: 'hi' }] });

    expect(response.status).toBe(204);
    release();
  });

  it('still reports a turn rejected before acceptance as an error', async () => {
    // No Agent SDK: the backend refuses the turn before accepting it.
    const response = await request(createApp(null))
      .post('/api/session/ses_cccsess-1/prompt_async')
      .send({ parts: [{ type: 'text', text: 'hi' }] });

    expect(response.status).toBe(500);
    expect(response.body.error).toMatch(/not available/);
  });
});

import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createClaudeSurface } from './routes.js';

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

import express from 'express';
import request from 'supertest';
import nodeCrypto from 'crypto';
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

const NO_OVERLAY = { readFile: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } };

const surfaceApp = ({ sdk = null, ...options } = {}) => {
  const app = express();
  const surface = createClaudeSurface({
    crypto: nodeCrypto,
    fsPromises: NO_OVERLAY,
    claudeExecutable: '/usr/bin/claude',
    sdkLoader: async () => sdk,
    livePollMs: 0,
    ...options,
  });
  surface.register(app);
  // Stands in for the OpenCode proxy mounted after the surface.
  app.use('/api', (_req, res) => res.status(418).json({ proxied: true }));
  return { app, surface };
};

describe('POST /api/session/:id/prompt', () => {
  const sdkWith = (query) => ({
    listSessions: async () => [],
    getSessionMessages: async () => [],
    getSessionInfo: async () => null,
    renameSession: async () => {},
    query,
  });

  it('answers once the turn is accepted, with the inbox item the client named, while the turn still runs', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const query = () => (async function* stream() {
      await gate;
      yield { type: 'result', is_error: false };
    })();
    const { app } = surfaceApp({ sdk: sdkWith(query) });

    const response = await request(app)
      .post('/api/session/ses_cccsess-1/prompt')
      .send({ id: 'msg_client1', text: 'hi' });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ id: 'msg_client1', sessionID: 'ses_cccsess-1', type: 'user', payload: { text: 'hi' } });
    release();
  });

  it('echoes the prompt on the stream as one inbox event under the client id', async () => {
    const events = [];
    const query = () => (async function* stream() {
      yield { type: 'result', is_error: false };
    })();
    const { app } = surfaceApp({ sdk: sdkWith(query), publishEvent: ({ payload }) => events.push(payload) });

    await request(app).post('/api/session/ses_cccsess-1/prompt').send({ id: 'msg_client2', text: 'hola' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const enqueued = events.filter((event) => event.type === 'session.inbox.enqueued');
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].data).toMatchObject({
      sessionID: 'ses_cccsess-1',
      inboxID: 'msg_client2',
      item: { type: 'user', payload: { text: 'hola' } },
    });
    expect(events.map((event) => event.type)).toContain('session.idle');
  });

  it('reports a turn rejected before acceptance as a tagged error', async () => {
    // No Agent SDK: the backend refuses the turn before accepting it.
    const { app } = surfaceApp();

    const response = await request(app).post('/api/session/ses_cccsess-1/prompt').send({ text: 'hi' });

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({ _tag: 'UnknownError' });
    expect(response.body.message).toMatch(/not available/);
  });

  it('refuses an empty prompt as an invalid request', async () => {
    const { app } = surfaceApp();

    const response = await request(app).post('/api/session/ses_cccsess-1/prompt').send({ text: '' });

    expect(response.status).toBe(400);
  });

  it('lets a session the surface does not own through to the proxy', async () => {
    const { app } = surfaceApp();

    const response = await request(app).post('/api/session/ses_opencode1/prompt').send({ text: 'hi' });

    expect(response.status).toBe(418);
  });
});

describe('a session live in another process', () => {
  it('answers a prompt with 409 and who holds it', async () => {
    const sdk = {
      listSessions: async () => [],
      getSessionMessages: async () => [],
      getSessionInfo: async () => null,
      query: () => { throw new Error('must not start a second writer'); },
    };
    const { app } = surfaceApp({
      sdk,
      liveRegistry: {
        read: async () => new Map([['sess-1', {
          pid: 9, sessionId: 'sess-1', cwd: '/repo', entrypoint: 'cli', name: 'term', status: 'idle', bridgeSessionId: '',
        }]]),
        stop: async () => true,
      },
    });

    const response = await request(app).post('/api/session/ses_cccsess-1/prompt').send({ text: 'hi' });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      _tag: 'ConflictError',
      code: 'CLAUDE_SESSION_LIVE_ELSEWHERE',
      owner: { entrypoint: 'cli', pid: 9 },
    });
  });
});

describe('reading a Claude session through the OpenCode 2 routes', () => {
  const transcript = [
    { type: 'user', uuid: 'u1', timestamp: '2026-09-25T10:00:00.000Z', message: { role: 'user', content: 'primera' } },
    {
      type: 'assistant',
      uuid: 'a1',
      timestamp: '2026-09-25T10:00:01.000Z',
      message: { id: 'api1', model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: 'pienso' }, { type: 'text', text: 'uno' }] },
    },
    { type: 'user', uuid: 'u2', timestamp: '2026-09-25T10:00:02.000Z', message: { role: 'user', content: 'segunda' } },
    {
      type: 'assistant',
      uuid: 'a2',
      timestamp: '2026-09-25T10:00:03.000Z',
      message: { id: 'api2', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'dos' }] },
    },
  ];
  const sdk = {
    listSessions: async () => [{ sessionId: 'sess-1', cwd: '/repo/sub', summary: 'Una sesión', lastModified: 1_000 }],
    getSessionMessages: async () => transcript,
    getSessionInfo: async () => null,
    query: () => { throw new Error('reading never starts a turn'); },
  };

  it('pages messages newest first in OpenCode 2 shapes and continues with the cursor', async () => {
    const { app } = surfaceApp({ sdk });

    const first = await request(app).get('/api/session/ses_cccsess-1/message?limit=3&order=desc');
    expect(first.status).toBe(200);
    expect(first.body.data.map((message) => message.type)).toEqual(['assistant', 'user', 'assistant']);
    expect(first.body.data[0].content).toEqual([{ type: 'text', text: 'dos' }]);
    expect(first.body.data[2].content.map((item) => item.type)).toEqual(['reasoning', 'text']);
    expect(first.body.cursor.next).toEqual(expect.any(String));

    const second = await request(app).get(`/api/session/ses_cccsess-1/message?limit=3&cursor=${encodeURIComponent(first.body.cursor.next)}`);
    expect(second.body.data).toHaveLength(1);
    expect(second.body.data[0]).toMatchObject({ type: 'user', text: 'primera' });
    expect(second.body.cursor.next).toBeNull();
  });

  it('answers a session as Session.Info at its project root', async () => {
    const { app } = surfaceApp({ sdk, readProjects: async () => [{ id: 'p1', worktree: '/repo' }] });

    const response = await request(app).get('/api/session/ses_cccsess-1');

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      id: 'ses_cccsess-1',
      projectID: 'p1',
      location: { directory: '/repo' },
      subpath: 'sub',
      title: 'Una sesión',
      metadata: { backend: 'claude', claude: { directory: '/repo/sub' } },
    });
  });

  it('lists every Claude session under a directory for the proxy to merge', async () => {
    const { surface } = surfaceApp({ sdk, readProjects: async () => [{ id: 'p1', worktree: '/repo' }] });

    expect((await surface.listClaudeSessions({ directory: '/repo' })).map((session) => session.id)).toEqual(['ses_cccsess-1']);
    expect(await surface.listClaudeSessions({ directory: '/elsewhere' })).toEqual([]);
    expect(await surface.listClaudeSessions({ search: 'nada' })).toEqual([]);
  });

  it('answers the session side routes OpenCode would, so opening one reports no errors', async () => {
    const { app } = surfaceApp({ sdk });

    expect((await request(app).get('/api/session/ses_cccsess-1/inbox')).body).toEqual({ data: [] });
    expect((await request(app).post('/api/session/ses_cccsess-1/view')).status).toBe(204);
    expect((await request(app).post('/api/session/ses_cccsess-1/model').send({ model: { providerID: 'anthropic', id: 'claude-opus-5-5' } })).status).toBe(204);
    expect((await request(app).post('/api/session/ses_cccsess-1/interrupt')).body).toEqual({ interrupted: true });
  });
});

describe('OPENCHAMBER_CLAUDE_LIST_DISABLED kill switch', () => {
  it('registers no Claude routes and lists no Claude sessions', async () => {
    const previous = process.env.OPENCHAMBER_CLAUDE_LIST_DISABLED;
    process.env.OPENCHAMBER_CLAUDE_LIST_DISABLED = '1';
    try {
      const app = express();
      const surface = createClaudeSurface({});
      surface.register(app);
      app.use((req, res) => res.status(418).end());
      const res = await request(app).get('/api/session/ses_ccc00000000-0000-0000-0000-000000000000/message');
      expect(res.status).toBe(418);
      expect(await surface.listClaudeSessions(null)).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.OPENCHAMBER_CLAUDE_LIST_DISABLED;
      else process.env.OPENCHAMBER_CLAUDE_LIST_DISABLED = previous;
    }
  });
});

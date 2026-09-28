import express from 'express';
import request from 'supertest';
import nodeCrypto from 'crypto';
import { describe, expect, it, vi } from 'vitest';

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

  it('reports a running turn to the proxy\'s active snapshot, and not once it settles', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const query = () => (async function* stream() {
      await gate;
      yield { type: 'result', is_error: false };
    })();
    const { app, surface } = surfaceApp({ sdk: sdkWith(query) });

    await request(app).post('/api/session/ses_cccsess-1/prompt').send({ id: 'msg_active1', text: 'corre' });
    expect(await surface.listClaudeActive()).toMatchObject({ 'ses_cccsess-1': { type: 'busy' } });

    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await surface.listClaudeActive()).toEqual({});
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

describe('the Claude model picker', () => {
  const SETTINGS = {
    model: 'opus[1m]',
    modelPicker: {
      options: [
        { model: 'opus[1m]', label: 'Opus 5.5 (Anthropic)', description: 'Suscripcion oficial' },
        { model: 'qwen38-flash-next', label: 'qwen38 residente (local)' },
      ],
    },
  };
  const withSettings = {
    readFile: async (file) => {
      if (String(file).endsWith('settings.json')) return JSON.stringify(SETTINGS);
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
  };

  it('offers the models of Claude Code\'s own picker, not OpenCode\'s providers', async () => {
    const { app } = surfaceApp({ fsPromises: withSettings, homeDir: '/home/test' });

    const response = await request(app).get('/api/claude/models');

    expect(response.status).toBe(200);
    expect(response.body.models).toEqual([
      { id: 'opus[1m]', label: 'Opus 5.5 (Anthropic)', description: 'Suscripcion oficial' },
      { id: 'qwen38-flash-next', label: 'qwen38 residente (local)' },
    ]);
    expect(response.body.defaultModelId).toBe('opus[1m]');
    expect(response.body.efforts.map((effort) => effort.id)).toEqual(['low', 'medium', 'high', 'max']);
  });

  it('runs the next turn on the Claude pick, which the send path\'s OpenCode model does not overwrite', async () => {
    const query = vi.fn(() => (async function* stream() {
      yield { type: 'result', is_error: false };
    })());
    const sdk = {
      listSessions: async () => [],
      getSessionMessages: async () => [],
      getSessionInfo: async () => null,
      renameSession: async () => {},
      query,
    };
    const { app } = surfaceApp({ sdk, fsPromises: withSettings, homeDir: '/home/test' });

    await request(app).post('/api/session/ses_cccsess-1/model').send({ model: { providerID: 'claude', id: 'qwen38-flash-next', variant: 'low' } });
    await request(app).post('/api/session/ses_cccsess-1/model').send({ model: { providerID: 'litellm-local', id: 'q38-flash' } });
    const response = await request(app).post('/api/session/ses_cccsess-1/prompt').send({ text: 'hi' });

    expect(response.status).toBe(200);
    expect(query.mock.calls[0][0].options).toMatchObject({ model: 'qwen38-flash-next', effort: 'low' });
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

  it('parses a transcript once for the pages read back to back', async () => {
    const getSessionMessages = vi.fn(async () => transcript);
    const { app } = surfaceApp({ sdk: { ...sdk, getSessionMessages } });

    const first = await request(app).get('/api/session/ses_cccsess-1/message?limit=2&order=desc');
    await request(app).get(`/api/session/ses_cccsess-1/message?limit=2&cursor=${encodeURIComponent(first.body.cursor.next)}`);
    await Promise.all([
      request(app).get('/api/session/ses_cccsess-1/message?limit=2'),
      request(app).get('/api/session/ses_cccsess-1/message/msg_x'),
    ]);

    expect(getSessionMessages).toHaveBeenCalledTimes(1);
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

  it('answers a session archived in the archive store as archived', async () => {
    const { app } = surfaceApp({ sdk, getArchivedSessions: async () => ({ 'ses_cccsess-1': 1_234 }) });

    const response = await request(app).get('/api/session/ses_cccsess-1');

    expect(response.status).toBe(200);
    expect(response.body.data.time.archived).toBe(1_234);
  });

  it('leaves a session the archive store does not name un-archived', async () => {
    const recent = { ...sdk, listSessions: async () => [{ sessionId: 'sess-1', cwd: '/repo/sub', summary: 'Una sesión', lastModified: Date.now() }] };
    const { app } = surfaceApp({ sdk: recent, getArchivedSessions: async () => ({ ses_other: 1_234 }) });

    const response = await request(app).get('/api/session/ses_cccsess-1');

    expect(response.body.data.time.archived).toBeUndefined();
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

describe('Claude engine: commands, compaction, fork and refusals', () => {
  // A CLI that records every prompt it is sent and answers each at once.
  const recordingSdk = (extra = {}) => {
    const prompts = [];
    const sdk = {
      listSessions: async () => [],
      getSessionMessages: async () => [],
      getSessionInfo: async (id) => ({ sessionId: id, cwd: '/repo', createdAt: 1, lastModified: 2, summary: 's' }),
      renameSession: async () => {},
      forkSession: vi.fn(async () => ({ sessionId: 'forked-1' })),
      query: ({ prompt }) => (async function* stream() {
        for await (const message of prompt) {
          prompts.push(message.message.content);
          yield { type: 'result', is_error: false };
        }
      })(),
      ...extra,
    };
    return { sdk, prompts };
  };
  const id = 'ses_ccc11111111-2222-3333-4444-555555555555';

  it('sends a command as `/name args` in a plain string, and answers 204 like OpenCode', async () => {
    const { sdk, prompts } = recordingSdk();
    const { app } = surfaceApp({ sdk });
    const response = await request(app).post(`/api/session/${id}/command`).send({ name: 'review', text: 'src/app.ts' });
    expect(response.status).toBe(204);
    await vi.waitFor(() => expect(prompts).toEqual(['/review src/app.ts']));
  });

  it('sends the context admitted with a command after the command line, in the same message', async () => {
    const { sdk, prompts } = recordingSdk();
    const { app } = surfaceApp({ sdk });
    await request(app).post(`/api/session/${id}/synthetic`).send({ text: 'selected code' });
    await request(app).post(`/api/session/${id}/command`).send({ name: 'review', text: 'focus on auth' });
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    expect(prompts[0]).toBe('/review focus on auth\n\nselected code');
    // Consumed with the command: the next prompt does not carry it again.
    await request(app).post(`/api/session/${id}/prompt`).send({ text: 'go on' });
    await vi.waitFor(() => expect(prompts).toHaveLength(2));
    expect(JSON.stringify(prompts[1])).not.toContain('selected code');
  });

  it('leaves context admitted for the next prompt out of /compact', async () => {
    const { sdk, prompts } = recordingSdk();
    const { app } = surfaceApp({ sdk });
    await request(app).post(`/api/session/${id}/synthetic`).send({ text: 'terminal output' });
    await request(app).post(`/api/session/${id}/compact`).send({});
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    expect(prompts[0]).toBe('/compact');
    await request(app).post(`/api/session/${id}/prompt`).send({ text: 'go on' });
    await vi.waitFor(() => expect(prompts).toHaveLength(2));
    expect(JSON.stringify(prompts[1])).toContain('terminal output');
  });

  it('refuses a command with attachments instead of degrading it to prose', async () => {
    const { sdk, prompts } = recordingSdk();
    const { app } = surfaceApp({ sdk });
    const response = await request(app).post(`/api/session/${id}/command`)
      .send({ name: 'review', text: 'x', files: [{ uri: 'data:image/png;base64,AAAA', name: 'a.png' }] });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ _tag: 'UnsupportedOperationError', engine: 'claude', operation: 'commandAttachments' });
    expect(prompts).toEqual([]);
  });

  it('sends a prompt that merely starts with a slash as prose (blocks), never as a command', async () => {
    const { sdk, prompts } = recordingSdk();
    const { app } = surfaceApp({ sdk });
    await request(app).post(`/api/session/${id}/prompt`).send({ text: '/usr/local/bin/node --version shows 18, why?' });
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    expect(Array.isArray(prompts[0])).toBe(true);
  });

  it('puts consumed context back when the turn is refused before it starts', async () => {
    const prompts = [];
    let refuse = true;
    const sdk = {
      listSessions: async () => [],
      getSessionMessages: async () => [],
      getSessionInfo: async (sid) => ({ sessionId: sid, cwd: '/repo', createdAt: 1, lastModified: 2, summary: 's' }),
      renameSession: async () => {},
      query: ({ prompt }) => {
        if (refuse) {
          refuse = false;
          throw new Error('CLI failed to start');
        }
        return (async function* stream() {
          for await (const message of prompt) {
            prompts.push(message.message.content);
            yield { type: 'result', is_error: false };
          }
        })();
      },
    };
    const { app } = surfaceApp({ sdk });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await request(app).post(`/api/session/${id}/synthetic`).send({ text: 'keep me' });
    const failed = await request(app).post(`/api/session/${id}/prompt`).send({ text: 'first' });
    expect(failed.status).toBe(500);
    await request(app).post(`/api/session/${id}/prompt`).send({ text: 'second' });
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    warn.mockRestore();
    expect(JSON.stringify(prompts[0])).toContain('keep me');
  });

  it.each(['two words', 'usr/local/bin/node', '', '9lives'])('refuses %j as a command name', async (name) => {
    const { sdk } = recordingSdk();
    const { app } = surfaceApp({ sdk });
    const response = await request(app).post(`/api/session/${id}/command`).send({ name });
    expect(response.status).toBe(400);
    expect(response.body._tag).toBe('InvalidRequestError');
  });

  it('accepts namespaced command names', async () => {
    const { sdk, prompts } = recordingSdk();
    const { app } = surfaceApp({ sdk });
    const response = await request(app).post(`/api/session/${id}/command`).send({ name: 'frontend:component', text: 'Button' });
    expect(response.status).toBe(204);
    await vi.waitFor(() => expect(prompts).toEqual(['/frontend:component Button']));
  });

  it('compacts through Claude Code\'s own /compact', async () => {
    const { sdk, prompts } = recordingSdk();
    const { app } = surfaceApp({ sdk });
    const response = await request(app).post(`/api/session/${id}/compact`).send({});
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(prompts).toEqual(['/compact']));
  });

  it('forks into a sibling Claude session with a public id', async () => {
    const { sdk } = recordingSdk();
    const { app } = surfaceApp({ sdk });
    const response = await request(app).post(`/api/session/${id}/fork`).send({});
    expect(response.status).toBe(200);
    expect(response.body.data.id).toBe('ses_cccforked-1');
    expect(response.body.data.parentID).toBeUndefined();
    expect(response.body.data.metadata.backend).toBe('claude');
  });

  it('answers a fork point it cannot find as a missing message, not a server failure', async () => {
    const { sdk } = recordingSdk();
    const { app } = surfaceApp({ sdk });
    const response = await request(app).post(`/api/session/${id}/fork`).send({ before: 'msg_nope' });
    expect(response.status).toBe(404);
    expect(response.body._tag).toBe('MessageNotFoundError');
  });

  it.each([
    ['post', 'shell', 'shell'],
    ['post', 'revert/stage', 'revert'],
    ['post', 'move', 'move'],
    ['post', 'generate', 'generate'],
    ['post', 'permission/req_1', 'permissions'],
  ])('refuses %s %s with a typed error naming the engine and the operation', async (method, rest, operation) => {
    const { sdk } = recordingSdk();
    const { app } = surfaceApp({ sdk });
    const response = await request(app)[method](`/api/session/${id}/${rest}`).send({});
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ _tag: 'UnsupportedOperationError', engine: 'claude', operation });
    expect(response.body.message).toBe(`Claude Code sessions do not support ${operation}`);
  });

  it('never forwards an OpenCode session\'s command to the Claude engine', async () => {
    const { sdk, prompts } = recordingSdk();
    const { app } = surfaceApp({ sdk });
    const response = await request(app).post('/api/session/ses_native123/command').send({ name: 'review' });
    expect(response.status).toBe(418);
    expect(prompts).toEqual([]);
  });

  it('lists the commands the Claude CLI reported', async () => {
    const { sdk } = recordingSdk();
    const { app } = surfaceApp({ sdk });
    const response = await request(app).get('/api/claude/commands').query({ directory: '/repo' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ commands: [] });
  });
});

describe('queueTransport: the server queue delivering to a Claude session', () => {
  const sdkRecording = () => {
    const prompts = [];
    return {
      prompts,
      sdk: {
        listSessions: async () => [],
        getSessionMessages: async () => [],
        getSessionInfo: async (id) => ({ sessionId: id, cwd: '/repo', createdAt: 1, lastModified: 2, summary: 's' }),
        renameSession: async () => {},
        query: ({ prompt }) => (async function* stream() {
          for await (const message of prompt) {
            prompts.push(message.message.content);
            yield { type: 'result', is_error: false };
          }
        })(),
      },
    };
  };
  const id = 'ses_ccc11111111-2222-3333-4444-555555555555';

  it('owns only Claude ids', () => {
    const { surface } = surfaceApp({ sdk: sdkRecording().sdk });
    expect(surface.queueTransport.owns(id)).toBe(true);
    expect(surface.queueTransport.owns('ses_native123')).toBe(false);
  });

  it('is idle when nothing runs for the session', async () => {
    const { surface } = surfaceApp({ sdk: sdkRecording().sdk });
    await expect(surface.queueTransport.isIdle(id)).resolves.toBe(true);
  });

  it('sends queued text with its context and knowledge ahead, and says the knowledge went out', async () => {
    const { sdk, prompts } = sdkRecording();
    const { surface } = surfaceApp({ sdk });
    const result = await surface.queueTransport.send(id, '/repo', { text: 'go on', context: ['quoted selection'], knowledge: 'project notes' });
    expect(result).toEqual({ knowledgeDelivered: true });
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    const sent = JSON.stringify(prompts[0]);
    expect(sent).toContain('quoted selection');
    expect(sent).toContain('project notes');
    expect(sent.indexOf('project notes')).toBeLessThan(sent.indexOf('go on'));
  });

  it('sends a queued `/name` as the command with its context after it, and no knowledge', async () => {
    const { sdk, prompts } = sdkRecording();
    const { surface } = surfaceApp({ sdk });
    const result = await surface.queueTransport.send(id, '/repo', { text: '/review src/app.ts', context: ['selected code'], knowledge: 'project notes' });
    expect(result).toEqual({ knowledgeDelivered: false });
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    expect(prompts[0]).toBe('/review src/app.ts\n\nselected code');
  });

  it('sends queued prose that starts with a path as a prompt', async () => {
    const { sdk, prompts } = sdkRecording();
    const { surface } = surfaceApp({ sdk });
    await surface.queueTransport.send(id, '/repo', { text: '/etc/hosts has a stale line, check it' });
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    expect(Array.isArray(prompts[0])).toBe(true);
  });

  it('never touches the composer\'s pending context, so a retry cannot duplicate it', async () => {
    const { sdk, prompts } = sdkRecording();
    const { app, surface } = surfaceApp({ sdk });
    await surface.queueTransport.send(id, '/repo', { text: 'one', context: ['ctx'] });
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    await request(app).post(`/api/session/${id}/prompt`).send({ text: 'two' });
    await vi.waitFor(() => expect(prompts).toHaveLength(2));
    expect(JSON.stringify(prompts[1])).not.toContain('ctx');
  });

  it('holds Claude items while the surface is switched off: idleness unknown, sends refused', async () => {
    const { sdk, prompts } = sdkRecording();
    const { surface } = surfaceApp({ sdk });
    process.env.OPENCHAMBER_CLAUDE_LIST_DISABLED = '1';
    try {
      await expect(surface.queueTransport.isIdle(id)).resolves.toBeNull();
      await expect(surface.queueTransport.send(id, '/repo', { text: 'x' })).rejects.toThrow('switched off');
    } finally {
      delete process.env.OPENCHAMBER_CLAUDE_LIST_DISABLED;
    }
    expect(prompts).toEqual([]);
  });
});

describe('OpenChamber metadata on Claude sessions', () => {
  const sdk = {
    listSessions: async () => [{ sessionId: 'aaaa', cwd: '/repo', createdAt: 1, lastModified: 2, summary: 's' }],
    getSessionMessages: async () => [],
    getSessionInfo: async (id) => ({ sessionId: id, cwd: '/repo', createdAt: 1, lastModified: 2, summary: 's' }),
    renameSession: async () => {},
    query: () => (async function* stream() {})(),
  };
  const stored = { 'ses_cccaaaa': { openchamber: { btwSessionID: 'ses_cccbbbb' }, backend: 'opencode' } };
  const options = {
    getStoredMetadata: async (id) => stored[id] ?? {},
    peekStoredMetadata: (id) => stored[id],
  };

  it('lays the stored metadata over the record, and the engine stays the server\'s to declare', async () => {
    const { app } = surfaceApp({ sdk, ...options });
    const response = await request(app).get('/api/session/ses_cccaaaa');
    expect(response.status).toBe(200);
    expect(response.body.data.metadata.openchamber).toEqual({ btwSessionID: 'ses_cccbbbb' });
    expect(response.body.data.metadata.backend).toBe('claude');
  });

  it('re-announces the whole record after a metadata change, never the stored part alone', async () => {
    const published = [];
    const { surface } = surfaceApp({ sdk, ...options, publishEvent: (event) => published.push(event.payload) });
    await surface.announceSession('ses_cccaaaa');
    const update = published.find((event) => event.type === 'session.metadata.updated');
    expect(update).toBeDefined();
    const metadata = update.data?.metadata ?? update.properties?.metadata;
    expect(metadata.backend).toBe('claude');
    expect(metadata.openchamber).toEqual({ btwSessionID: 'ses_cccbbbb' });
  });
});

describe('deleting a Claude session', () => {
  it('forgets its OpenChamber metadata with it', async () => {
    const forgotten = [];
    const sdk = {
      listSessions: async () => [],
      getSessionMessages: async () => [],
      getSessionInfo: async (id) => ({ sessionId: id, cwd: '/repo', createdAt: 1, lastModified: 2, summary: 's' }),
      renameSession: async () => {},
      deleteSession: async () => {},
      query: () => (async function* stream() {})(),
    };
    const { app } = surfaceApp({ sdk, forgetStoredMetadata: async (id) => { forgotten.push(id); } });
    const response = await request(app).delete('/api/session/ses_cccaaaa');
    expect(response.status).toBe(204);
    expect(forgotten).toEqual(['ses_cccaaaa']);
  });
});

describe('Claude Code asking the user: permissions, questions, plan approval', () => {
  /** A CLI that asks through canUseTool on its first prompt, then ends the turn with what it was told. */
  const askingSdk = (toolName, input, outcomes) => ({
    listSessions: async () => [],
    getSessionMessages: async () => [],
    getSessionInfo: async () => null,
    renameSession: async () => {},
    query: ({ prompt, options }) => (async function* stream() {
      for await (const message of prompt) {
        yield { ...message, isReplay: true };
        const result = await options.canUseTool(toolName, input, { signal: new AbortController().signal, toolUseID: 'toolu_1', requestId: 'r1', suggestions: [] });
        outcomes.push(result);
        yield { type: 'result', is_error: false };
      }
    })(),
  });

  const waitFor = async (check) => {
    for (let i = 0; i < 50; i += 1) {
      const value = await check();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('timed out');
  };

  it('serves a permission request through OpenCode\'s routes and statuses', async () => {
    const outcomes = [];
    const events = [];
    const { app, surface } = surfaceApp({ sdk: askingSdk('Bash', { command: 'ls' }, outcomes), publishEvent: ({ payload }) => events.push(payload) });
    await request(app).post('/api/session/ses_cccsess-1/prompt').send({ id: 'msg_p1', text: 'list' });

    const listed = await waitFor(async () => (await request(app).get('/api/session/ses_cccsess-1/permission')).body.data[0]);
    expect(listed).toMatchObject({ sessionID: 'ses_cccsess-1', action: 'shell', resources: ['ls'] });
    expect(events.find((event) => event.type === 'permission.asked').data).toMatchObject({ id: listed.id, sessionID: 'ses_cccsess-1' });
    expect(surface.listClaudePending('permission').map((request) => request.id)).toEqual([listed.id]);
    expect(surface.listClaudePending('permission', { directory: '/elsewhere' })).toEqual([]);

    expect((await request(app).get(`/api/session/ses_cccsess-1/permission/${listed.id}`)).body.data.id).toBe(listed.id);
    expect((await request(app).post(`/api/session/ses_cccsess-1/permission/${listed.id}/reply`).send({ decision: 'maybe' })).status).toBe(400);
    expect((await request(app).post(`/api/session/ses_cccsess-1/permission/${listed.id}/reply`).send({ decision: 'once' })).status).toBe(204);
    await waitFor(() => outcomes.length === 1);
    expect(outcomes[0]).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
    // Settled: a 404 is the server saying so.
    expect((await request(app).get(`/api/session/ses_cccsess-1/permission/${listed.id}`)).status).toBe(404);
    expect((await request(app).post(`/api/session/ses_cccsess-1/permission/${listed.id}/reply`).send({ decision: 'once' })).status).toBe(404);
    expect(events.find((event) => event.type === 'permission.replied').data).toMatchObject({ requestID: listed.id, reply: 'once' });
  });

  it('answers AskUserQuestion through a form, and a cancelled form refuses', async () => {
    const outcomes = [];
    const input = { questions: [{ question: 'Which?', header: 'Pick', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }] };
    const { app } = surfaceApp({ sdk: askingSdk('AskUserQuestion', input, outcomes) });
    await request(app).post('/api/session/ses_cccsess-1/prompt').send({ id: 'msg_q1', text: 'ask me' });

    const form = await waitFor(async () => (await request(app).get('/api/session/ses_cccsess-1/form')).body.data[0]);
    expect(form).toMatchObject({ sessionID: 'ses_cccsess-1', title: 'Pick', fields: [{ key: 'q0', type: 'string', custom: true }] });
    expect((await request(app).post(`/api/session/ses_cccsess-1/form/${form.id}/reply`).send({ answer: 'A' })).status).toBe(400);
    expect((await request(app).post(`/api/session/ses_cccsess-1/form/${form.id}/reply`).send({ answer: { q0: 'B' } })).status).toBe(204);
    await waitFor(() => outcomes.length === 1);
    expect(outcomes[0]).toEqual({ behavior: 'allow', updatedInput: { ...input, answers: { 'Which?': 'B' } } });

    await request(app).post('/api/session/ses_cccsess-1/prompt').send({ id: 'msg_q2', text: 'again' });
    const second = await waitFor(async () => (await request(app).get('/api/session/ses_cccsess-1/form')).body.data[0]);
    expect((await request(app).delete(`/api/session/ses_cccsess-1/form/${second.id}`)).status).toBe(204);
    await waitFor(() => outcomes.length === 2);
    expect(outcomes[1].behavior).toBe('deny');
    expect((await request(app).delete(`/api/session/ses_cccsess-1/form/${second.id}`)).status).toBe(404);
  });

  it('switches the mode from the mode menu, ignores OpenCode\'s agent, and refuses an unknown mode', async () => {
    const queries = [];
    const sdk = {
      listSessions: async () => [],
      getSessionMessages: async () => [],
      getSessionInfo: async () => null,
      renameSession: async () => {},
      query: ({ prompt, options }) => {
        queries.push(options);
        return (async function* stream() {
          for await (const message of prompt) {
            yield { ...message, isReplay: true };
            yield { type: 'result', is_error: false };
          }
        })();
      },
    };
    const { app } = surfaceApp({ sdk });
    expect((await request(app).post('/api/session/ses_cccsess-1/agent').send({ agent: 'plan' })).status).toBe(204);
    expect((await request(app).post('/api/session/ses_cccsess-1/claude/mode').send({ mode: 'nope' })).status).toBe(400);
    expect((await request(app).post('/api/session/ses_cccsess-1/claude/mode').send({ mode: 'acceptEdits' })).body).toEqual({ mode: 'acceptEdits' });
    await request(app).post('/api/session/ses_cccsess-1/prompt').send({ id: 'msg_m1', text: 'go' });
    await waitFor(() => queries.length === 1);
    // OpenCode's `plan` agent did not put Claude in plan mode; the menu's pick did.
    expect(queries[0].permissionMode).toBe('acceptEdits');
    expect(typeof queries[0].canUseTool).toBe('function');

    const models = await request(app).get('/api/claude/models');
    expect(models.body.modes.map((mode) => mode.id)).toEqual(['default', 'acceptEdits', 'plan', 'auto']);
    expect(models.body.defaultMode).toBe('default');
  });

  it('lets a subagent be stopped and read, and refuses every other write to it', async () => {
    const { app } = surfaceApp({
      sdk: {
        listSessions: async () => [],
        getSessionMessages: async () => [],
        getSessionInfo: async () => null,
        getSubagentMessages: async () => [],
      },
    });
    const stop = await request(app).post('/api/session/ses_cccsess-1~ag1/interrupt');
    expect(stop.status).toBe(200);
    expect(stop.body).toEqual({ interrupted: false });
    const write = await request(app).post('/api/session/ses_cccsess-1~ag1/prompt').send({ text: 'hi' });
    expect(write.status).toBe(400);
    expect(write.body).toMatchObject({ _tag: 'UnsupportedOperationError', engine: 'claude' });
  });
});

describe('Claude session ids from URLs', () => {
  it('never takes an id that could name a path outside the transcripts', async () => {
    const { app, surface } = surfaceApp({
      sdk: { listSessions: async () => [], getSessionMessages: async () => [], getSessionInfo: async () => null, getSubagentMessages: async () => [] },
    });
    // Not a Claude id: it falls through to the proxy (418 here), never to the engine.
    for (const id of ['ses_ccc..%2F..%2Fetc', 'ses_cccsess-1~..%2Fx', 'ses_ccca.b', 'ses_ccc']) {
      const response = await request(app).get(`/api/session/${id}/message`);
      expect(response.status).toBe(418);
    }
    expect(surface.queueTransport.owns('ses_ccc../x')).toBe(false);
    expect(surface.queueTransport.owns('ses_ccc0c4d2c1e-1b2a-4c3d-8e9f-001122334455')).toBe(true);
    expect(surface.queueTransport.owns('ses_ccc0c4d2c1e-1b2a-4c3d-8e9f-001122334455~a5df7622fa8de0538')).toBe(true);
  });
});

describe('POST /api/session/:id/claude/rewind', () => {
  it('asks for the prompt it rewinds to, and answers a record that is not one as missing', async () => {
    const { app } = surfaceApp({
      sdk: {
        listSessions: async () => [],
        getSessionMessages: async () => [],
        getSessionInfo: async () => null,
        query: () => (async function* stream() {})(),
      },
    });
    expect((await request(app).post('/api/session/ses_cccsess-1/claude/rewind').send({})).status).toBe(400);
    const missing = await request(app).post('/api/session/ses_cccsess-1/claude/rewind').send({ messageID: 'msg_nope', dryRun: true });
    expect(missing.status).toBe(404);
    expect(missing.body._tag).toBe('MessageNotFoundError');
    // A subagent's files are rewound through its session, never its child.
    expect((await request(app).post('/api/session/ses_cccsess-1~ag1/claude/rewind').send({ messageID: 'msg_x' })).status).toBe(400);
  });
});

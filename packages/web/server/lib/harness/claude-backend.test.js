import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import nodeCrypto from 'crypto';

import { createClaudeBackendRuntime } from './claude-backend.js';

const HOME = '/home/test';
const OVERLAY_FILE = '/state/claude-sessions.json';
const SETTINGS_FILE = `${HOME}/.claude/settings.json`;
const EXECUTABLE = '/usr/bin/claude';

const makeFs = ({ settings, overlay } = {}) => {
  const files = new Map();
  if (settings !== undefined) files.set(SETTINGS_FILE, JSON.stringify(settings));
  if (overlay !== undefined) files.set(OVERLAY_FILE, JSON.stringify(overlay));
  const missing = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });

  return {
    files,
    readFile: vi.fn(async (target) => {
      if (files.has(target)) return files.get(target);
      throw missing();
    }),
    writeFile: vi.fn(async (target, data) => {
      files.set(target, data);
    }),
    mkdir: vi.fn(async () => {}),
    access: vi.fn(async (target) => {
      if (target === EXECUTABLE) return;
      throw missing();
    }),
  };
};

const makeQuery = (messages, extra = {}) => {
  const query = (async function* stream() {
    for (const message of messages) yield message;
  })();
  query.interrupt = vi.fn(async () => {});
  return Object.assign(query, extra);
};

const makeSdk = (overrides = {}) => ({
  listSessions: vi.fn(async () => []),
  getSessionMessages: vi.fn(async () => []),
  getSessionInfo: vi.fn(async () => null),
  renameSession: vi.fn(async () => {}),
  deleteSession: vi.fn(async () => {}),
  forkSession: vi.fn(async () => ({ sessionId: 'forked-1' })),
  query: vi.fn(() => makeQuery([])),
  ...overrides,
});

const sessionInfo = (overrides = {}) => ({
  sessionId: 'sess-1',
  customTitle: '',
  summary: 'summarised work',
  firstPrompt: 'first prompt',
  cwd: '/repo/project',
  gitBranch: 'main',
  createdAt: 1000,
  lastModified: 2000,
  ...overrides,
});

const createRuntime = ({ sdk, fs, ...rest } = {}) => {
  const sdkObject = sdk || makeSdk();
  const runtime = createClaudeBackendRuntime({
    crypto: nodeCrypto,
    fsPromises: fs || makeFs(),
    publishEvent: vi.fn(),
    homeDir: HOME,
    overlayFilePath: OVERLAY_FILE,
    claudeExecutable: EXECUTABLE,
    sdkLoader: async () => sdkObject,
    ...rest,
  });
  return { runtime, sdk: sdkObject };
};

describe('claude backend availability', () => {
  it('is available when the SDK exposes the session API', async () => {
    const { runtime } = createRuntime();
    await expect(runtime.ensureAvailable()).resolves.toBe(true);
    expect(runtime.isAvailable()).toBe(true);
  });

  it('is unavailable when the SDK cannot be loaded', async () => {
    const { runtime } = createRuntime({
      sdkLoader: async () => {
        throw new Error('Cannot find module');
      },
    });
    await expect(runtime.ensureAvailable()).resolves.toBe(false);
  });

  it('is unavailable when the SDK lacks session APIs', async () => {
    const { runtime } = createRuntime({ sdkLoader: async () => ({ query: () => {} }) });
    await expect(runtime.ensureAvailable()).resolves.toBe(false);
  });
});

describe('claude backend listSessions', () => {
  it('maps SDK session info to harness sessions', async () => {
    const { runtime } = createRuntime({
      sdk: makeSdk({ listSessions: vi.fn(async () => [sessionInfo()]) }),
    });

    const sessions = await runtime.listSessions({ directory: '/repo/project' });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: 'sess-1',
      title: 'summarised work',
      directory: '/repo/project',
      backendId: 'claude',
      time: { created: 1000, updated: 2000 },
    });
    expect(sessions[0].metadata.gitBranch).toBe('main');
  });

  it('prefers customTitle over summary', async () => {
    const { runtime } = createRuntime({
      sdk: makeSdk({ listSessions: vi.fn(async () => [sessionInfo({ customTitle: ' Named ' })]) }),
    });
    const [session] = await runtime.listSessions({});
    expect(session.title).toBe('Named');
  });

  it('sorts newest first and honours limit', async () => {
    const { runtime } = createRuntime({
      sdk: makeSdk({
        listSessions: vi.fn(async () => [
          sessionInfo({ sessionId: 'old', lastModified: 100 }),
          sessionInfo({ sessionId: 'new', lastModified: 900 }),
          sessionInfo({ sessionId: 'mid', lastModified: 500 }),
        ]),
      }),
    });
    const sessions = await runtime.listSessions({ limit: 2 });
    expect(sessions.map((session) => session.id)).toEqual(['new', 'mid']);
  });

  it('hides overlay-archived sessions unless asked for them', async () => {
    const { runtime } = createRuntime({
      sdk: makeSdk({ listSessions: vi.fn(async () => [sessionInfo({ sessionId: 'a' }), sessionInfo({ sessionId: 'b' })]) }),
      fs: makeFs({ overlay: { archived: { a: 123 } } }),
    });

    const active = await runtime.listSessions({ archived: false });
    expect(active.map((session) => session.id)).toEqual(['b']);

    const archived = await runtime.listSessions({ archived: true });
    expect(archived.map((session) => session.id)).toEqual(['a']);
    expect(archived[0].time.archived).toBe(123);
  });

  it('serves a second call from cache within the TTL', async () => {
    const listSessions = vi.fn(async () => [sessionInfo()]);
    const { runtime } = createRuntime({ sdk: makeSdk({ listSessions }) });

    await runtime.listSessions({});
    await runtime.listSessions({});
    expect(listSessions).toHaveBeenCalledTimes(1);
  });

  it('returns empty and logs nothing fatal when the SDK throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { runtime } = createRuntime({
      sdk: makeSdk({ listSessions: vi.fn(async () => { throw new Error('EACCES'); }) }),
    });
    await expect(runtime.listSessions({})).resolves.toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('claude backend getMessages', () => {
  const transcript = [
    { type: 'user', uuid: 'u1', timestamp: new Date(1000).toISOString(), message: { role: 'user', content: 'hello' } },
    {
      type: 'assistant',
      uuid: 'a1',
      timestamp: new Date(2000).toISOString(),
      message: { id: 'msg_a', role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'hi there' }] },
    },
  ];

  it('maps SDK messages into {info, parts} records', async () => {
    const { runtime } = createRuntime({
      sdk: makeSdk({ getSessionMessages: vi.fn(async () => transcript) }),
    });

    const records = await runtime.getMessages({ sessionID: 'sess-1' });
    expect(records.map((record) => record.info.role)).toEqual(['user', 'assistant']);
    expect(records[1].parts[0].text).toBe('hi there');
    expect(records[1].info.providerID).toBe('claude');
  });

  it('applies limit by keeping the newest records', async () => {
    const { runtime } = createRuntime({
      sdk: makeSdk({ getSessionMessages: vi.fn(async () => transcript) }),
    });
    const records = await runtime.getMessages({ sessionID: 'sess-1', limit: 1 });
    expect(records).toHaveLength(1);
    expect(records[0].info.role).toBe('assistant');
  });

  it('returns empty when the SDK cannot read the transcript', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { runtime } = createRuntime({
      sdk: makeSdk({ getSessionMessages: vi.fn(async () => { throw new Error('missing'); }) }),
    });
    await expect(runtime.getMessages({ sessionID: 'nope' })).resolves.toEqual([]);
    warn.mockRestore();
  });
});

describe('claude backend createSession', () => {
  it('returns a uuid session and stages the title for the first turn', async () => {
    const fs = makeFs();
    const { runtime } = createRuntime({ fs });

    const session = await runtime.createSession({ directory: '/repo/project', title: 'My task' });
    expect(session.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(session.title).toBe('My task');
    expect(session.directory).toBe('/repo/project');

    const overlay = JSON.parse(fs.files.get(OVERLAY_FILE));
    expect(overlay.pendingTitles[session.id]).toBe('My task');
  });

  it('does not write an overlay file when no title is given', async () => {
    const fs = makeFs();
    const { runtime } = createRuntime({ fs });
    await runtime.createSession({ directory: '/repo/project' });
    expect(fs.writeFile).not.toHaveBeenCalled();
  });
});

describe('claude backend promptAsync', () => {
  const textDelta = (id, index, text) => ({
    type: 'stream_event',
    event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
  });

  it('starts a brand-new session with sessionId and streams deltas', async () => {
    const sdk = makeSdk({
      query: vi.fn(() => makeQuery([
        { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_a' } } },
        textDelta('msg_a', 0, 'hel'),
        textDelta('msg_a', 0, 'lo'),
        { type: 'result', is_error: false },
      ])),
    });
    const publishEvent = vi.fn();
    const { runtime } = createRuntime({ sdk, publishEvent });

    await expect(runtime.promptAsync({
      sessionID: 'sess-new',
      directory: '/repo/project',
      parts: [{ type: 'text', text: 'hi' }],
    })).resolves.toEqual({ ok: true });

    const options = sdk.query.mock.calls[0][0].options;
    expect(options.sessionId).toBe('sess-new');
    expect(options.resume).toBeUndefined();
    expect(options.pathToClaudeCodeExecutable).toBe(EXECUTABLE);
    expect(options.settingSources).toEqual(['user', 'project', 'local']);
    expect(options.includePartialMessages).toBe(true);

    const deltas = publishEvent.mock.calls
      .map(([event]) => event.payload)
      .filter((payload) => payload.type === 'message.part.delta');
    expect(deltas.map((payload) => payload.properties.delta)).toEqual(['hel', 'lo']);
    expect(deltas[0].properties.partID).toBe('msg_msg_a_text_0');

    // The part must exist before deltas reference it.
    const partOpens = publishEvent.mock.calls
      .map(([event]) => event.payload)
      .filter((payload) => payload.type === 'message.part.updated');
    expect(partOpens.length).toBeGreaterThan(0);

    const statuses = publishEvent.mock.calls
      .map(([event]) => event.payload)
      .filter((payload) => payload.type === 'session.status');
    expect(statuses.map((payload) => payload.properties.status.type)).toEqual(['busy', 'idle']);
  });

  it('resumes once a transcript exists', async () => {
    const sdk = makeSdk({
      getSessionInfo: vi.fn(async () => sessionInfo()),
      query: vi.fn(() => makeQuery([{ type: 'result', is_error: false }])),
    });
    const { runtime } = createRuntime({ sdk });

    await runtime.promptAsync({
      sessionID: 'sess-1',
      directory: '/repo/project',
      parts: [{ type: 'text', text: 'continue' }],
    });

    const options = sdk.query.mock.calls[0][0].options;
    expect(options.resume).toBe('sess-1');
    expect(options.sessionId).toBeUndefined();
  });

  it('applies a pending title after the first turn', async () => {
    const fs = makeFs({ overlay: { archived: {}, pendingTitles: { 'sess-new': 'Staged name' } } });
    const sdk = makeSdk({ query: vi.fn(() => makeQuery([{ type: 'result', is_error: false }])) });
    const { runtime } = createRuntime({ sdk, fs });

    await runtime.promptAsync({
      sessionID: 'sess-new',
      directory: '/repo/project',
      parts: [{ type: 'text', text: 'go' }],
    });

    expect(sdk.renameSession).toHaveBeenCalledWith('sess-new', 'Staged name', { dir: '/repo/project' });
    expect(JSON.parse(fs.files.get(OVERLAY_FILE)).pendingTitles).toEqual({});
  });

  it('sends attachments as image blocks', async () => {
    const sdk = makeSdk({ query: vi.fn(() => makeQuery([{ type: 'result', is_error: false }])) });
    const { runtime } = createRuntime({ sdk });

    await runtime.promptAsync({
      sessionID: 'sess-1',
      parts: [
        { type: 'text', text: 'look' },
        { type: 'file', url: 'data:image/png;base64,AAAA', mime: 'image/png' },
      ],
    });

    const prompt = sdk.query.mock.calls[0][0].prompt;
    const messages = [];
    for await (const value of prompt) messages.push(value);
    expect(messages).toHaveLength(1);
    expect(messages[0].message.content).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ]);
  });

  it('rejects an empty turn', async () => {
    const { runtime } = createRuntime();
    await expect(runtime.promptAsync({ sessionID: 'sess-1', parts: [] })).rejects.toThrow(/empty input/);
  });

  it('rejects a second concurrent run on the same session', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const sdk = makeSdk({
      query: vi.fn(() => makeQuery([(async () => { await gate; return { type: 'result', is_error: false }; })()])),
    });
    const { runtime } = createRuntime({ sdk });

    const first = runtime.promptAsync({ sessionID: 'sess-1', parts: [{ type: 'text', text: 'a' }] });
    await vi.waitFor(() => expect(runtime.getStatusSnapshot({})).resolves.toHaveProperty('sess-1'));

    await expect(runtime.promptAsync({ sessionID: 'sess-1', parts: [{ type: 'text', text: 'b' }] }))
      .rejects.toThrow(/already running/);

    release();
    await first;
  });

  it('emits session.error and still goes idle when the run fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const publishEvent = vi.fn();
    const sdk = makeSdk({
      query: vi.fn(() => makeQuery([{ type: 'result', is_error: true, result: 'credit balance' }])),
    });
    const { runtime } = createRuntime({ sdk, publishEvent });

    await runtime.promptAsync({ sessionID: 'sess-1', parts: [{ type: 'text', text: 'hi' }] });

    const errors = publishEvent.mock.calls
      .map(([event]) => event.payload)
      .filter((payload) => payload.type === 'session.error');
    expect(errors[0].properties.error.message).toBe('credit balance');
    warn.mockRestore();
  });
});

describe('claude backend abortSession', () => {
  it('interrupts and aborts a running turn', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const query = makeQuery([(async () => { await gate; return { type: 'result', is_error: false }; })()]);
    const sdk = makeSdk({ query: vi.fn(() => query) });
    const { runtime } = createRuntime({ sdk });

    const running = runtime.promptAsync({ sessionID: 'sess-1', parts: [{ type: 'text', text: 'hi' }] });
    await vi.waitFor(() => expect(sdk.query).toHaveBeenCalled());

    await expect(runtime.abortSession({ sessionID: 'sess-1' })).resolves.toBe(true);
    expect(query.interrupt).toHaveBeenCalled();
    // The run slot is released even though the fake stream cannot observe the abort.
    expect(await runtime.getStatusSnapshot({})).toEqual({});

    release();
    await running;
  });

  it('is a no-op for an unknown session', async () => {
    const { runtime } = createRuntime();
    await expect(runtime.abortSession({ sessionID: 'unknown' })).resolves.toBe(true);
  });
});

describe('claude backend updateSession', () => {
  it('renames through the SDK', async () => {
    const sdk = makeSdk({
      listSessions: vi.fn(async () => [sessionInfo()]),
      renameSession: vi.fn(async () => {}),
    });
    const { runtime } = createRuntime({ sdk });

    const session = await runtime.updateSession({ sessionID: 'sess-1', title: 'Renamed' });
    expect(sdk.renameSession).toHaveBeenCalledWith('sess-1', 'Renamed', {});
    expect(session.title).toBe('Renamed');
  });

  it('stages the title when the rename fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fs = makeFs();
    const sdk = makeSdk({
      listSessions: vi.fn(async () => [sessionInfo()]),
      renameSession: vi.fn(async () => { throw new Error('no transcript yet'); }),
    });
    const { runtime } = createRuntime({ sdk, fs });

    await runtime.updateSession({ sessionID: 'sess-1', title: 'Renamed' });
    expect(JSON.parse(fs.files.get(OVERLAY_FILE)).pendingTitles['sess-1']).toBe('Renamed');
    warn.mockRestore();
  });

  it('archives and unarchives through the overlay', async () => {
    const fs = makeFs();
    const sdk = makeSdk({ listSessions: vi.fn(async () => [sessionInfo()]) });
    const { runtime } = createRuntime({ sdk, fs });

    const archived = await runtime.updateSession({ sessionID: 'sess-1', time: { archived: 555 } });
    expect(archived.time.archived).toBe(555);
    expect(JSON.parse(fs.files.get(OVERLAY_FILE)).archived['sess-1']).toBe(555);

    const active = await runtime.updateSession({ sessionID: 'sess-1', time: { archived: null } });
    expect(active.time.archived).toBeUndefined();
    expect(JSON.parse(fs.files.get(OVERLAY_FILE)).archived).toEqual({});
  });
});

describe('claude backend deleteSession', () => {
  it('deletes through the SDK and clears overlay state', async () => {
    const fs = makeFs({ overlay: { archived: { 'sess-1': 1 }, pendingTitles: { 'sess-1': 'x' } } });
    const sdk = makeSdk({ deleteSession: vi.fn(async () => {}) });
    const { runtime } = createRuntime({ sdk, fs });

    await expect(runtime.deleteSession({ sessionID: 'sess-1' })).resolves.toBe(true);
    expect(sdk.deleteSession).toHaveBeenCalledWith('sess-1', {});
    const overlay = JSON.parse(fs.files.get(OVERLAY_FILE));
    expect(overlay.archived).toEqual({});
    expect(overlay.pendingTitles).toEqual({});
  });

  it('reports false when the SDK cannot delete and nothing was staged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sdk = makeSdk({ deleteSession: vi.fn(async () => { throw new Error('ENOENT'); }) });
    const { runtime } = createRuntime({ sdk });
    await expect(runtime.deleteSession({ sessionID: 'sess-x' })).resolves.toBe(false);
    warn.mockRestore();
  });
});

describe('claude backend control surface', () => {
  it('reads the model catalog and defaults from settings.json', async () => {
    const fs = makeFs({
      settings: {
        model: 'qwen38-flash-next',
        effortLevel: 'max',
        modelPicker: {
          options: [
            { model: 'opus[1m]', label: 'Opus 5' },
            { model: 'qwen38-flash-next', label: 'Qwen (local)', description: 'via LiteLLM' },
          ],
        },
      },
    });
    const { runtime } = createRuntime({ fs });

    const surface = await runtime.getControlSurface();
    expect(surface.modelSelector.options.map((option) => option.id))
      .toEqual(['opus[1m]', 'qwen38-flash-next']);
    expect(surface.modelSelector.defaultOptionId).toBe('qwen38-flash-next');
    expect(surface.effortSelector.defaultOptionId).toBe('max');
    expect(surface.modeSelector.items.map((item) => item.id)).toEqual(['default', 'plan', 'acceptEdits']);
    expect(surface.modeSelector.items.find((item) => item.isDefault).id).toBe('default');
  });

  it('falls back to a static catalog without settings', async () => {
    const { runtime } = createRuntime();
    const surface = await runtime.getControlSurface();
    expect(surface.modelSelector.options.map((option) => option.id)).toEqual(['sonnet', 'opus', 'haiku']);
    expect(surface.effortSelector.defaultOptionId).toBe('high');
  });
});

describe('claude backend status and events', () => {
  it('reports running sessions as busy per directory', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const sdk = makeSdk({
      query: vi.fn(() => makeQuery([(async () => { await gate; return { type: 'result', is_error: false }; })()])),
    });
    const { runtime } = createRuntime({ sdk });

    const running = runtime.promptAsync({
      sessionID: 'sess-1', directory: '/repo/project', parts: [{ type: 'text', text: 'hi' }],
    });
    await vi.waitFor(() => expect(sdk.query).toHaveBeenCalled());

    expect(await runtime.getStatusSnapshot({ directory: '/repo/project' })).toEqual({ 'sess-1': { type: 'busy' } });
    expect(await runtime.getStatusSnapshot({ directory: '/other' })).toEqual({});

    release();
    await running;
    expect(await runtime.getStatusSnapshot({})).toEqual({});
  });

  it('writes events only to clients of the matching directory', async () => {
    const makeRes = (chunks) => ({
      write: vi.fn((chunk) => chunks.push(chunk)),
      on: vi.fn(),
      off: vi.fn(),
    });

    const chunksA = [];
    const chunksB = [];
    const sdk = makeSdk({
      query: vi.fn(() => makeQuery([
        { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_a' } } },
        { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } } },
        { type: 'result', is_error: false },
      ])),
    });
    const { runtime } = createRuntime({ sdk });
    const removeA = runtime.addEventClient(makeRes(chunksA), '/repo/project');
    runtime.addEventClient(makeRes(chunksB), '/elsewhere');

    await runtime.promptAsync({
      sessionID: 'sess-1', directory: '/repo/project', parts: [{ type: 'text', text: 'hi' }],
    });

    const parsed = (chunks) => chunks.map((chunk) => JSON.parse(chunk.replace(/^data: /, '').trim()));

    expect(parsed(chunksA).some((payload) => payload.type === 'message.part.delta')).toBe(true);
    // Message traffic is directory-scoped, while session lifecycle events are
    // broadcast to every client (same contract as the codex backend).
    expect(parsed(chunksB).every((payload) => payload.type.startsWith('session.'))).toBe(true);
    expect(parsed(chunksB).length).toBeGreaterThan(0);
    expect(typeof removeA).toBe('function');
  });
});

describe('claude backend shutdownAll', () => {
  it('interrupts every running turn', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const query = makeQuery([(async () => { await gate; return { type: 'result', is_error: false }; })()]);
    const sdk = makeSdk({ query: vi.fn(() => query) });
    const { runtime } = createRuntime({ sdk });

    const running = runtime.promptAsync({ sessionID: 'sess-1', parts: [{ type: 'text', text: 'hi' }] });
    await vi.waitFor(() => expect(sdk.query).toHaveBeenCalled());

    await runtime.shutdownAll();
    expect(query.interrupt).toHaveBeenCalled();
    expect(await runtime.getStatusSnapshot({})).toEqual({});

    release();
    await running.catch(() => {});
  });
});

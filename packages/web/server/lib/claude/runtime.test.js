import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import nodeCrypto from 'crypto';
import v8 from 'node:v8';
import vm from 'node:vm';

import { createClaudeBackendRuntime, recordFingerprint } from './runtime.js';

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
    // The fixtures' timestamps are from 1970: automatic archiving is tested on its own.
    autoArchiveAfterMs: 0,
    ...rest,
  });
  return { runtime, sdk: sdkObject };
};

// A CLI that stays up across prompts: answers each one and closes the turn.
const interactiveQuery = (extraHandle = () => ({})) => vi.fn(({ prompt }) => {
  const queued = [];
  const waiting = [];
  let ended = false;
  const push = (value) => {
    const next = waiting.shift();
    if (next) next({ value, done: false });
    else queued.push(value);
  };
  const end = () => {
    ended = true;
    for (const next of waiting.splice(0)) next({ value: undefined, done: true });
  };
  (async () => {
    for await (const message of prompt) {
      push({ ...message, isReplay: true });
      push({ type: 'result', is_error: false });
    }
    end();
  })();
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        if (queued.length > 0) return Promise.resolve({ value: queued.shift(), done: false });
        if (ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => waiting.push(resolve));
      },
    }),
    interrupt: vi.fn(async () => {}),
    close: vi.fn(end),
    setModel: vi.fn(async () => {}),
    setPermissionMode: vi.fn(async () => {}),
    ...extraHandle(),
  };
});

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
  it('replaces a Remote Control placeholder title with the transcript ai-title', async () => {
    const readAiTitle = vi.fn(async () => 'Debug image issue');
    const { runtime } = createRuntime({
      sdk: makeSdk({
        listSessions: vi.fn(async () => [sessionInfo({
          customTitle: 'OpenChamber · k8s',
          summary: 'OpenChamber · k8s',
          firstPrompt: '',
        })]),
      }),
      fs: Object.assign(makeFs(), { stat: vi.fn(async () => ({ mtimeMs: 123 })) }),
      transcriptSidecar: { locate: async () => '/transcripts/sess-1.jsonl', readAiTitle },
    });

    const [session] = await runtime.listSessions({ directory: '/repo/project' });
    expect(session.title).toBe('Debug image issue');

    // The answer is cached until the transcript changes, and a real title
    // never asks the transcript at all.
    await runtime.listSessions({ directory: '/repo/project' });
    expect(readAiTitle).toHaveBeenCalledTimes(1);
    readAiTitle.mockClear();
    const { runtime: clean } = createRuntime({
      sdk: makeSdk({ listSessions: vi.fn(async () => [sessionInfo()]) }),
      transcriptSidecar: { locate: async () => '/transcripts/sess-1.jsonl', readAiTitle },
    });
    const [untouched] = await clean.listSessions({ directory: '/repo/project' });
    expect(untouched.title).toBe('summarised work');
    expect(readAiTitle).not.toHaveBeenCalled();
  });

  it('unmasks a title buried under the generated VS Code name', async () => {
    const readAiTitle = vi.fn(async () => 'El título que sacó la IA');
    const sidecar = (real) => ({
      locate: async () => '/transcripts/sess-1.jsonl',
      readAiTitle,
      readRealCustomTitle: vi.fn(async () => real),
    });
    // As the SDK answers it: `summary` is its display title, the stamp again.
    const stamp = { customTitle: 'ubuntu-bright-duckling', summary: 'ubuntu-bright-duckling', firstPrompt: 'hola' };

    // The conversation had a real title before the stamp: that one shows,
    // and the ai-title has no say over a custom title.
    const { runtime } = createRuntime({
      sdk: makeSdk({ listSessions: vi.fn(async () => [sessionInfo(stamp)]) }),
      fs: Object.assign(makeFs(), { stat: vi.fn(async () => ({ mtimeMs: 123 })) }),
      transcriptSidecar: sidecar('iOS no lee archivo proceso'),
    });
    const [masked] = await runtime.listSessions({ directory: '/repo/project' });
    expect(masked.title).toBe('iOS no lee archivo proceso');
    expect(readAiTitle).not.toHaveBeenCalled();

    // Nothing real under the stamp: it is no title, so the ai-title decides.
    const { runtime: bare } = createRuntime({
      sdk: makeSdk({ listSessions: vi.fn(async () => [sessionInfo(stamp)]) }),
      fs: Object.assign(makeFs(), { stat: vi.fn(async () => ({ mtimeMs: 123 })) }),
      transcriptSidecar: sidecar(''),
    });
    const [unmasked] = await bare.listSessions({ directory: '/repo/project' });
    expect(unmasked.title).toBe('El título que sacó la IA');

    // No ai-title either (the title call failed): the first prompt, never the stamp.
    const { runtime: untitled } = createRuntime({
      sdk: makeSdk({ listSessions: vi.fn(async () => [sessionInfo(stamp)]) }),
      fs: Object.assign(makeFs(), { stat: vi.fn(async () => ({ mtimeMs: 123 })) }),
      transcriptSidecar: { ...sidecar(''), readAiTitle: vi.fn(async () => '') },
    });
    const [prompted] = await untitled.listSessions({ directory: '/repo/project' });
    expect(prompted.title).toBe('hola');

    // The SDK's first prompt empty (a pasted image outgrew its scan): the
    // transcript's own first prompt.
    const { runtime: pasted } = createRuntime({
      sdk: makeSdk({ listSessions: vi.fn(async () => [sessionInfo({ ...stamp, firstPrompt: '' })]) }),
      fs: Object.assign(makeFs(), { stat: vi.fn(async () => ({ mtimeMs: 123 })) }),
      transcriptSidecar: { ...sidecar(''), readAiTitle: vi.fn(async () => ''), readFirstPrompt: vi.fn(async () => 'porque hay 2 precios?') },
    });
    const [fromTranscript] = await pasted.listSessions({ directory: '/repo/project' });
    expect(fromTranscript.title).toBe('porque hay 2 precios?');

    // A chosen title is never scanned, however many words it hyphenates.
    const scan = sidecar('NO DEBE LLAMARME');
    const { runtime: clean } = createRuntime({
      sdk: makeSdk({ listSessions: vi.fn(async () => [sessionInfo()]) }),
      transcriptSidecar: scan,
    });
    const [untouched] = await clean.listSessions({ directory: '/repo/project' });
    expect(untouched.title).toBe('summarised work');
    expect(scan.readRealCustomTitle).not.toHaveBeenCalled();
  });

  it('names a prompt-only session by its ai-title, as VS Code does', async () => {
    const readAiTitle = vi.fn(async () => 'Apagar y relanzar SC-1340');
    const { runtime } = createRuntime({
      sdk: makeSdk({
        listSessions: vi.fn(async () => [sessionInfo({
          customTitle: '',
          summary: '',
          firstPrompt: 'que session esta haciendo SC-1340? apagala y arrancala aqui',
        })]),
      }),
      fs: Object.assign(makeFs(), { stat: vi.fn(async () => ({ mtimeMs: 123 })) }),
      transcriptSidecar: { locate: async () => '/transcripts/sess-1.jsonl', readAiTitle },
    });

    const [session] = await runtime.listSessions({ directory: '/repo/project' });
    expect(session.title).toBe('Apagar y relanzar SC-1340');
  });

  it('keeps the first prompt when the transcript has no ai-title yet', async () => {
    const { runtime } = createRuntime({
      sdk: makeSdk({
        listSessions: vi.fn(async () => [sessionInfo({ customTitle: '', summary: '' })]),
      }),
      fs: Object.assign(makeFs(), { stat: vi.fn(async () => ({ mtimeMs: 123 })) }),
      transcriptSidecar: { locate: async () => '/transcripts/sess-1.jsonl', readAiTitle: async () => '' },
    });

    const [session] = await runtime.listSessions({ directory: '/repo/project' });
    expect(session.title).toBe('first prompt');
  });

  it('reads at most eight transcripts at a time and keeps the order of the list', async () => {
    const SESSIONS = 50;
    let reading = 0;
    let peak = 0;
    const readAiTitle = vi.fn(async (sessionId) => {
      reading += 1;
      peak = Math.max(peak, reading);
      // Finish out of order: the last ones are quickest.
      await new Promise((resolve) => setTimeout(resolve, (SESSIONS - Number(sessionId.slice(5))) % 7));
      reading -= 1;
      return `title of ${sessionId}`;
    });
    const infos = Array.from({ length: SESSIONS }, (_, index) => sessionInfo({
      sessionId: `sess-${index}`,
      customTitle: '',
      summary: '',
      firstPrompt: '',
    }));
    const { runtime } = createRuntime({
      sdk: makeSdk({ listSessions: vi.fn(async () => infos) }),
      fs: Object.assign(makeFs(), { stat: vi.fn(async () => ({ mtimeMs: 123 })) }),
      transcriptSidecar: { locate: async (sessionId) => `/transcripts/${sessionId}.jsonl`, readAiTitle },
    });

    const sessions = await runtime.listSessions({ directory: '/repo/project' });
    expect(readAiTitle).toHaveBeenCalledTimes(SESSIONS);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
    // Same `lastModified` everywhere: the list keeps the order the SDK gave.
    expect(sessions.map((session) => session.title)).toEqual(infos.map((info) => `title of ${info.sessionId}`));
  });

  it('does not keep the transcript windows its fields were sliced from', async () => {
    // The SDK reads 64 KB from each end of every transcript and returns its
    // fields as substrings of them; V8 keeps the parent of a substring alive.
    // A real heap measure: `gc` is not exposed to the worker, so ask V8 for it.
    v8.setFlagsFromString('--expose-gc');
    const collect = vm.runInNewContext('gc');
    const heapUsed = () => {
      collect();
      collect();
      return process.memoryUsage().heapUsed;
    };
    const SESSIONS = 300;
    const WINDOW = 64 * 1024;
    const sliceOf = (parent, part) => {
      const at = parent.indexOf(part);
      return parent.slice(at, at + part.length);
    };
    const makeInfos = () => Array.from({ length: SESSIONS }, (_, index) => {
      const head = `${index}|00000000-0000-4000-8000-${String(index).padStart(12, '0')}|/repo/project/long/path-${index}|feature/branch-number-${index}|${'h'.repeat(WINDOW)}`;
      const tail = `${index}|summary of session number ${index}|${'t'.repeat(WINDOW)}`;
      return sessionInfo({
        sessionId: sliceOf(head, `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`),
        cwd: sliceOf(head, `/repo/project/long/path-${index}`),
        gitBranch: sliceOf(head, `feature/branch-number-${index}`),
        summary: sliceOf(tail, `summary of session number ${index}`),
        customTitle: '',
      });
    });

    const baseline = heapUsed();
    let infos = makeInfos();
    // A plain function: a `vi.fn` keeps every value it returned.
    const { runtime } = createRuntime({ sdk: makeSdk({ listSessions: async () => infos }) });
    const listed = await runtime.listSessions();
    expect(listed).toHaveLength(SESSIONS);
    expect(listed.find((session) => session.directory === '/repo/project/long/path-7').title).toBe('summary of session number 7');
    infos = null;

    // 300 x 2 x 64 KB = ~38 MB held by the substrings before the fix; under 1 MB after.
    const retainedMb = (heapUsed() - baseline) / 1024 / 1024;
    expect(retainedMb, 'MB still held after the list').toBeLessThan(8);
    // The cache still serves the list it kept.
    expect(await runtime.listSessions()).toHaveLength(SESSIONS);
  });

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

  it('archives a session untouched for the configured time, unless it is live or was unarchived by hand', async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const fs = makeFs();
    const { runtime } = createRuntime({
      sdk: makeSdk({
        listSessions: vi.fn(async () => [
          sessionInfo({ sessionId: 'fresh', lastModified: now - DAY }),
          sessionInfo({ sessionId: 'stale', lastModified: now - 8 * DAY }),
          sessionInfo({ sessionId: 'kept', lastModified: now - 9 * DAY }),
        ]),
      }),
      fs,
      autoArchiveAfterMs: 7 * DAY,
    });

    expect((await runtime.listSessions({ archived: false })).map((session) => session.id)).toEqual(['fresh']);
    const archived = await runtime.listSessions({ archived: true });
    expect(archived.map((session) => session.id)).toEqual(['stale', 'kept']);
    // Archived from the moment it crossed the line, not from when it was listed.
    expect(archived[0].time.archived).toBe(now - DAY);

    // Unarchived by hand: back in the list, and the clock starts again.
    const restored = await runtime.updateSession({ sessionID: 'kept', time: { archived: null } });
    expect(restored.time.archived).toBeUndefined();
    expect(JSON.parse(fs.files.get(OVERLAY_FILE)).kept.kept).toBeGreaterThanOrEqual(now);
    expect((await runtime.listSessions({ archived: false })).map((session) => session.id)).toEqual(['fresh', 'kept']);
  });

  it('scans the transcripts once for concurrent calls', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const listSessions = vi.fn(async () => { await gate; return [sessionInfo()]; });
    const { runtime } = createRuntime({ sdk: makeSdk({ listSessions }) });

    const calls = [runtime.listSessions({ archived: false }), runtime.listSessions({ archived: true }), runtime.listSessions({})];
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    const [active, archived, all] = await Promise.all(calls);

    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(active).toHaveLength(1);
    expect(archived).toHaveLength(0);
    expect(all).toHaveLength(1);
  });

  it('serves a stale list past the TTL while it refreshes in the background', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      let round = 0;
      const listSessions = vi.fn(async () => [sessionInfo({ customTitle: `round ${round += 1}` })]);
      const { runtime } = createRuntime({ sdk: makeSdk({ listSessions }) });

      expect((await runtime.listSessions({}))[0].title).toBe('round 1');
      vi.setSystemTime(Date.now() + 20_000);
      // Past the TTL: the old list comes back at once and a scan starts.
      expect((await runtime.listSessions({}))[0].title).toBe('round 1');
      await vi.waitFor(() => expect(listSessions).toHaveBeenCalledTimes(2));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect((await runtime.listSessions({}))[0].title).toBe('round 2');
    } finally {
      vi.useRealTimers();
    }
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

    // The prompt is a stream that stays open for the next turn: read the
    // first message rather than draining it.
    const prompt = sdk.query.mock.calls[0][0].prompt;
    const first = await prompt[Symbol.asyncIterator]().next();
    expect(first.done).toBe(false);
    expect(first.value.message.content).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ]);
  });

  it('reads a sent prompt back as the one message the front end already shows', async () => {
    const publishEvent = vi.fn();
    const sdk = makeSdk({ query: vi.fn(() => makeQuery([{ type: 'result', is_error: false }])) });
    const { runtime } = createRuntime({ sdk, publishEvent });

    await runtime.promptAsync({
      sessionID: 'sess-1',
      directory: '/repo/project',
      parts: [{ type: 'text', text: 'que hora es?' }],
    });
    // The uuid the CLI was given is the uuid it writes in the transcript.
    const first = await sdk.query.mock.calls[0][0].prompt[Symbol.asyncIterator]().next();
    const sentUuid = first.value.uuid;
    sdk.getSessionMessages.mockImplementation(async () => [
      {
        type: 'user',
        uuid: sentUuid,
        timestamp: '2026-09-29T00:10:37.336Z',
        message: { role: 'user', content: [{ type: 'text', text: 'que hora es?' }] },
      },
    ]);

    const echoed = publishEvent.mock.calls.map(([event]) => event.payload)
      .filter((payload) => payload.type === 'message.updated' && payload.properties?.info?.role === 'user')
      .map((payload) => payload.properties.info.id);
    expect(echoed).toHaveLength(1);

    const records = await runtime.getMessages({ sessionID: 'sess-1', directory: '/repo/project', internal: true });
    const prompts = records.filter((record) => record.info.role === 'user');
    expect(prompts).toHaveLength(1);
    expect(prompts[0].info.id).toBe(echoed[0]);
    await runtime.shutdownAll();
  });

  it('rejects an empty turn', async () => {
    const { runtime } = createRuntime();
    await expect(runtime.promptAsync({ sessionID: 'sess-1', parts: [] })).rejects.toThrow(/empty input/);
  });

  it('queues a second prompt in the same process instead of refusing it', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const sdk = makeSdk({
      query: vi.fn(() => makeQuery([(async () => { await gate; return { type: 'result', is_error: false }; })()])),
    });
    const { runtime } = createRuntime({ sdk });

    const first = runtime.promptAsync({ sessionID: 'sess-1', parts: [{ type: 'text', text: 'a' }] });
    await vi.waitFor(() => expect(runtime.getStatusSnapshot({})).resolves.toHaveProperty('sess-1'));

    const onStarted = vi.fn();
    const second = runtime.promptAsync({ sessionID: 'sess-1', parts: [{ type: 'text', text: 'b' }], onStarted });
    await vi.waitFor(() => expect(onStarted).toHaveBeenCalled());
    // Never a second writer on the transcript.
    expect(sdk.query).toHaveBeenCalledTimes(1);

    release();
    await first;
    // This fake CLI exits after one turn without taking the queued prompt.
    await expect(second).rejects.toThrow(/exited before taking the prompt/);
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
    // The VS Code extension's modes; Bypass only where the user accepted it.
    expect(surface.modeSelector.items.map((item) => item.id)).toEqual(['default', 'acceptEdits', 'plan', 'auto']);
    expect(surface.modeSelector.items.find((item) => item.isDefault).id).toBe('default');
  });

  it('offers Bypass permissions only where the CLI already accepted it, and honours defaultMode', async () => {
    const fs = makeFs({ settings: { skipDangerousModePermissionPrompt: true, permissions: { defaultMode: 'acceptEdits' } } });
    const { runtime } = createRuntime({ fs });
    const modes = await runtime.listModes();
    expect(modes.map((mode) => mode.id)).toEqual(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']);
    expect(modes.find((mode) => mode.isDefault).id).toBe('acceptEdits');
    expect(modes.find((mode) => mode.id === 'bypassPermissions').dangerous).toBe(true);
  });

  it('never starts in Bypass when it is not offered, whatever defaultMode says', async () => {
    const fs = makeFs({ settings: { permissions: { defaultMode: 'bypassPermissions' } } });
    const { runtime } = createRuntime({ fs });
    const modes = await runtime.listModes();
    expect(modes.some((mode) => mode.id === 'bypassPermissions')).toBe(false);
    expect(modes.find((mode) => mode.isDefault).id).toBe('default');
  });

  it('falls back to a static catalog without settings', async () => {
    const { runtime } = createRuntime();
    const surface = await runtime.getControlSurface();
    expect(surface.modelSelector.options.map((option) => option.id)).toEqual(['sonnet', 'opus', 'haiku']);
    expect(surface.effortSelector.defaultOptionId).toBe('high');
  });
});

describe('claude backend OpenChamber defaults', () => {
  it('opens a new session on the OpenChamber defaults, ahead of the CLI settings', async () => {
    const fs = makeFs({
      settings: { model: 'qwen38-flash-next', effortLevel: 'max', permissions: { defaultMode: 'acceptEdits' } },
    });
    const { runtime } = createRuntime({
      fs,
      readAppSettings: async () => ({ claudeDefaultModel: 'opus[1m]', claudeDefaultEffort: 'low', claudeDefaultMode: 'plan' }),
    });

    const surface = await runtime.getControlSurface();
    expect(surface.modelSelector.defaultOptionId).toBe('opus[1m]');
    expect(surface.effortSelector.defaultOptionId).toBe('low');
    expect(surface.modeSelector.items.find((item) => item.isDefault).id).toBe('plan');
  });

  it('never defaults to a mode this host does not offer, and an unset key falls through', async () => {
    const fs = makeFs({ settings: { effortLevel: 'low', permissions: { defaultMode: 'acceptEdits' } } });
    const { runtime } = createRuntime({
      fs,
      // Bypass is not accepted by this CLI, and the model key is empty.
      readAppSettings: async () => ({ claudeDefaultModel: '', claudeDefaultMode: 'bypassPermissions' }),
    });

    const modes = await runtime.listModes();
    expect(modes.find((mode) => mode.isDefault).id).toBe('acceptEdits');
    const surface = await runtime.getControlSurface();
    expect(surface.effortSelector.defaultOptionId).toBe('low');
    expect(surface.modelSelector.defaultOptionId).toBe('sonnet');
  });

  it('starts the first turn on what the session was created with, and keeps it across a restart', async () => {
    const sdk = makeSdk({ query: vi.fn(() => makeQuery([{ type: 'result', is_error: false }])) });
    const fs = makeFs({ settings: { model: 'sonnet', effortLevel: 'max', permissions: { defaultMode: 'default' } } });
    const { runtime } = createRuntime({ sdk, fs });

    const session = await runtime.createSession({
      directory: '/repo/project',
      selection: { model: 'opus[1m]', effort: 'low', mode: 'plan' },
    });
    expect(session.metadata.claude).toMatchObject({ model: 'opus[1m]', effort: 'low', mode: 'plan' });
    expect(JSON.parse(fs.files.get(OVERLAY_FILE)).selections[session.id])
      .toEqual({ model: 'opus[1m]', effort: 'low', mode: 'plan' });

    await runtime.promptAsync({ sessionID: session.id, directory: '/repo/project', parts: [{ type: 'text', text: 'hi' }] });
    const options = sdk.query.mock.calls[0][0].options;
    expect(options.model).toBe('opus[1m]');
    expect(options.effort).toBe('low');
    expect(options.permissionMode).toBe('plan');

    // A second runtime over the same overlay: the pick was never only in memory.
    const reopened = makeSdk({ query: vi.fn(() => makeQuery([{ type: 'result', is_error: false }])) });
    const { runtime: second } = createRuntime({ sdk: reopened, fs });
    await second.promptAsync({ sessionID: session.id, directory: '/repo/project', parts: [{ type: 'text', text: 'hi' }] });
    expect(reopened.query.mock.calls[0][0].options.model).toBe('opus[1m]');
    expect(reopened.query.mock.calls[0][0].options.permissionMode).toBe('plan');
  });

  it('keeps a session with no pick on the configured defaults', async () => {
    const sdk = makeSdk({ query: vi.fn(() => makeQuery([{ type: 'result', is_error: false }])) });
    const fs = makeFs({ settings: { model: 'sonnet' } });
    const { runtime } = createRuntime({ sdk, fs, readAppSettings: async () => ({ claudeDefaultEffort: 'medium' }) });

    const session = await runtime.createSession({ directory: '/repo/project' });
    expect(session.metadata).toBeUndefined();

    await runtime.promptAsync({ sessionID: session.id, directory: '/repo/project', parts: [{ type: 'text', text: 'hi' }] });
    const options = sdk.query.mock.calls[0][0].options;
    expect(options.model).toBe('sonnet');
    expect(options.effort).toBe('medium');
  });

  it('refuses a creation pick this host does not offer', async () => {
    const fs = makeFs({ settings: { permissions: { defaultMode: 'default' } } });
    const { runtime } = createRuntime({ fs });

    const session = await runtime.createSession({
      directory: '/repo/project',
      selection: { model: 'haiku', effort: 'ultra', mode: 'bypassPermissions' },
    });
    // Only the model survives: the effort is not a level and Bypass is not offered.
    expect(session.metadata.claude).toEqual({ model: 'haiku' });
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
    // broadcast to every client (same contract as the OpenCode event stream).
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

describe('claude backend live turn rendering', () => {
  const payloadsOf = (publishEvent) => publishEvent.mock.calls.map(([event]) => event.payload);
  const partUpdates = (publishEvent) => payloadsOf(publishEvent)
    .filter((payload) => payload.type === 'message.part.updated')
    .map((payload) => payload.properties.part);

  it('streams thinking deltas into a reasoning part', async () => {
    const sdk = makeSdk({
      query: vi.fn(() => makeQuery([
        { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_a' } } },
        { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'pien' } } },
        { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'so' } } },
        { type: 'result', is_error: false },
      ])),
    });
    const publishEvent = vi.fn();
    const { runtime } = createRuntime({ sdk, publishEvent });

    await runtime.promptAsync({ sessionID: 'sess-1', parts: [{ type: 'text', text: 'hi' }] });

    const deltas = payloadsOf(publishEvent).filter((payload) => payload.type === 'message.part.delta');
    expect(deltas.map((payload) => payload.properties.delta)).toEqual(['pien', 'so']);
    expect(deltas[0].properties.partID).toBe('msg_msg_a_reasoning_0');
    expect(partUpdates(publishEvent).some((part) => part.id === 'msg_msg_a_reasoning_0' && part.type === 'reasoning'))
      .toBe(true);
  });

  it('settles the streamed text part with the finished block instead of rendering it twice', async () => {
    // The CLI sends each finished block as its own assistant message at
    // content index 0, while its deltas carried the real block index (1).
    const sdk = makeSdk({
      query: vi.fn(() => makeQuery([
        { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_a' } } },
        { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'O' } } },
        { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'K' } } },
        { type: 'assistant', message: { id: 'msg_a', content: [{ type: 'text', text: 'OK' }] } },
        { type: 'result', is_error: false },
      ])),
    });
    const publishEvent = vi.fn();
    const { runtime } = createRuntime({ sdk, publishEvent });

    await runtime.promptAsync({ sessionID: 'sess-1', parts: [{ type: 'text', text: 'hi' }] });

    const textParts = partUpdates(publishEvent).filter((part) => part.type === 'text' && part.messageID === 'msg_msg_a');
    expect(new Set(textParts.map((part) => part.id))).toEqual(new Set(['msg_msg_a_text_1']));
    expect(textParts.at(-1).text).toBe('OK');
  });

  it('closes a tool card live when its tool_result arrives', async () => {
    const sdk = makeSdk({
      query: vi.fn(() => makeQuery([
        { type: 'assistant', message: { id: 'msg_a', content: [{ type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'pwd' } }] } },
        { type: 'assistant', message: { id: 'msg_a', content: [{ type: 'tool_use', id: 'call_2', name: 'Read', input: { file_path: '/x' } }] } },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '/repo' }] } },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_2', content: 'nope', is_error: true }] } },
        { type: 'result', is_error: false },
      ])),
    });
    const publishEvent = vi.fn();
    const { runtime } = createRuntime({ sdk, publishEvent });

    await runtime.promptAsync({ sessionID: 'sess-1', parts: [{ type: 'text', text: 'hi' }] });

    const tools = partUpdates(publishEvent).filter((part) => part.type === 'tool');
    // Parallel calls of one API message keep separate cards.
    expect(new Set(tools.map((part) => part.id)).size).toBe(2);
    const last = (callID) => tools.filter((part) => part.callID === callID).at(-1);
    expect(last('call_1').state).toMatchObject({ status: 'completed', output: '/repo', input: { command: 'pwd' } });
    expect(last('call_1').state.time.end).toBeGreaterThanOrEqual(last('call_1').state.time.start);
    expect(last('call_2').state).toMatchObject({ status: 'error', error: 'nope' });
  });

  it('reports acceptance through onStarted before the turn finishes', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const sdk = makeSdk({
      query: vi.fn(() => makeQuery([(async () => { await gate; return { type: 'result', is_error: false }; })()])),
    });
    const { runtime } = createRuntime({ sdk });
    const onStarted = vi.fn();

    const running = runtime.promptAsync({ sessionID: 'sess-1', parts: [{ type: 'text', text: 'hi' }], onStarted });
    await vi.waitFor(() => expect(onStarted).toHaveBeenCalledTimes(1));

    release();
    await running;
    expect(onStarted).toHaveBeenCalledTimes(1);
  });

  it('does not report acceptance for a turn rejected up front', async () => {
    const { runtime } = createRuntime();
    const onStarted = vi.fn();
    await expect(runtime.promptAsync({ sessionID: 'sess-1', parts: [], onStarted })).rejects.toThrow(/empty input/);
    expect(onStarted).not.toHaveBeenCalled();
  });
});

describe('claude backend live processes', () => {
  const remoteControlHandle = () => ({
    enableRemoteControl: vi.fn(async () => ({ session_url: 'https://claude.ai/code/session_x', bridge_session_id: 'cse_x' })),
  });
  const interactiveRemoteQuery = () => interactiveQuery(remoteControlHandle);

  it('reuses the session process for the next turn', async () => {
    const sdk = makeSdk({ query: interactiveRemoteQuery() });
    const { runtime } = createRuntime({ sdk });

    await runtime.promptAsync({ sessionID: 'sess-1', parts: [{ type: 'text', text: 'one' }] });
    await runtime.promptAsync({ sessionID: 'sess-1', parts: [{ type: 'text', text: 'two' }] });

    expect(sdk.query).toHaveBeenCalledTimes(1);
    expect(sdk.query.mock.calls[0][0].options.extraArgs).toEqual({ 'replay-user-messages': null });
    await runtime.shutdownAll();
  });

  it('launches the CLI as `cli` so VS Code lists the session', async () => {
    const sdk = makeSdk({ query: interactiveRemoteQuery() });
    const { runtime } = createRuntime({ sdk });

    await runtime.promptAsync({ sessionID: 'sess-1', parts: [{ type: 'text', text: 'hi' }] });

    expect(sdk.query.mock.calls[0][0].options.env.CLAUDE_CODE_ENTRYPOINT).toBe('cli');
    await runtime.shutdownAll();
  });

  it('starts a new process when the effort changes', async () => {
    const sdk = makeSdk({ query: interactiveRemoteQuery() });
    const { runtime } = createRuntime({ sdk });

    await runtime.promptAsync({ sessionID: 'sess-1', parts: [{ type: 'text', text: 'one' }], variant: 'low' });
    await runtime.promptAsync({ sessionID: 'sess-1', parts: [{ type: 'text', text: 'two' }], variant: 'max' });

    expect(sdk.query).toHaveBeenCalledTimes(2);
    expect(sdk.query.mock.calls[1][0].options.effort).toBe('max');
    await runtime.shutdownAll();
  });

  it('links the process to Remote Control with a first-party base URL and advertises the link', async () => {
    const sdk = makeSdk({
      query: interactiveRemoteQuery(),
      listSessions: vi.fn(async () => [sessionInfo()]),
    });
    const { runtime } = createRuntime({
      sdk,
      remoteControl: { enabled: true, baseUrl: 'https://api.anthropic.com' },
    });

    await runtime.promptAsync({ sessionID: 'sess-1', directory: '/repo/project', parts: [{ type: 'text', text: 'hi' }] });

    const options = sdk.query.mock.calls[0][0].options;
    expect(options.settings).toEqual({ env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } });
    const handle = sdk.query.mock.results[0].value;
    expect(handle.enableRemoteControl).toHaveBeenCalledWith(true, 'summarised work');

    await vi.waitFor(async () => {
      const [session] = await runtime.listSessions({ directory: '/repo/project' });
      expect(session.metadata.remoteControl).toEqual({ url: 'https://claude.ai/code/session_x' });
    });
    await runtime.shutdownAll();
  });

  it('links a fresh untitled session to Remote Control with no name: the CLI keeps its own title', async () => {
    // The placeholder name used to be persisted by the CLI as the transcript's
    // custom title, masking the summary the CLI writes after the first turn.
    const sdk = makeSdk({
      query: interactiveRemoteQuery(),
      listSessions: vi.fn(async () => []),
    });
    const { runtime } = createRuntime({ sdk, remoteControl: { enabled: true } });

    await runtime.promptAsync({ sessionID: 'sess-untitled', directory: '/repo/project', parts: [{ type: 'text', text: 'hi' }] });

    const handle = sdk.query.mock.results[0].value;
    expect(handle.enableRemoteControl).toHaveBeenCalledWith(true, undefined);
    await runtime.shutdownAll();
  });

  it('closes the longest-idle process to make room, never a busy one', async () => {
    const sdk = makeSdk({ query: interactiveRemoteQuery() });
    const { runtime } = createRuntime({ sdk, maxConcurrentRuns: 1 });

    await runtime.promptAsync({ sessionID: 'sess-1', parts: [{ type: 'text', text: 'one' }] });
    await runtime.promptAsync({ sessionID: 'sess-2', parts: [{ type: 'text', text: 'two' }] });

    const first = sdk.query.mock.results[0].value;
    expect(first.close).toHaveBeenCalled();
    expect(sdk.query).toHaveBeenCalledTimes(2);
    await runtime.shutdownAll();
  });
});

describe('claude backend releaseSession', () => {
  // The live-process CLI stub is `interactiveQuery`, at the top of the file.

  it('closes the process it hosts, leaving the transcript with no writer', async () => {
    const sdk = makeSdk({ query: interactiveQuery() });
    const { runtime } = createRuntime({ sdk });
    await runtime.promptAsync({ sessionID: 'sess-1', parts: [{ type: 'text', text: 'one' }] });
    const handle = sdk.query.mock.results[0].value;

    expect(await runtime.releaseSession({ sessionID: 'sess-1' })).toEqual({ released: true, busy: false });
    expect(handle.close).toHaveBeenCalled();

    await runtime.shutdownAll();
  });

  it('is a no-op when this server hosts nothing for the session', async () => {
    const sdk = makeSdk({ query: interactiveQuery() });
    const { runtime } = createRuntime({ sdk });

    expect(await runtime.releaseSession({ sessionID: 'sess-1' })).toEqual({ released: true, busy: false });
    expect(sdk.query).not.toHaveBeenCalled();

    await runtime.shutdownAll();
  });

  it('refuses to release while the turn is answering', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const sdk = makeSdk({
      query: vi.fn(() => makeQuery([(async () => { await gate; return { type: 'result', is_error: false }; })()])),
    });
    const { runtime } = createRuntime({ sdk });
    const running = runtime.promptAsync({ sessionID: 'sess-1', parts: [{ type: 'text', text: 'hi' }] });
    await vi.waitFor(() => expect(sdk.query).toHaveBeenCalled());

    expect(await runtime.releaseSession({ sessionID: 'sess-1' })).toEqual({ released: false, busy: true });

    release();
    await running;
    await runtime.shutdownAll();
  });
});

describe('claude backend sessions live in another process', () => {
  const owner = (overrides = {}) => ({
    pid: 4242,
    sessionId: 'sess-1',
    cwd: '/repo/project',
    entrypoint: 'claude-vscode',
    name: 'k8s-93',
    status: 'busy',
    bridgeSessionId: 'session_01REMOTE',
    updatedAt: 1,
    ...overrides,
  });

  const makeRegistry = (owners) => {
    const state = { owners: new Map(owners.map((o) => [o.sessionId, o])) };
    return {
      state,
      read: vi.fn(async ({ ignoreParentPid } = {}) => new Map([...state.owners]
        .filter(([, o]) => ignoreParentPid === undefined || o.ppid !== ignoreParentPid))),
      stop: vi.fn(async (o) => { state.owners.delete(o.sessionId); return true; }),
    };
  };

  it('refuses to resume a session another process is writing', async () => {
    const sdk = makeSdk();
    const liveRegistry = makeRegistry([owner()]);
    const { runtime } = createRuntime({ sdk, liveRegistry, livePollMs: 0 });

    await expect(runtime.promptAsync({ sessionID: 'sess-1', parts: [{ type: 'text', text: 'hi' }] }))
      .rejects.toMatchObject({ code: 'CLAUDE_SESSION_LIVE_ELSEWHERE', owner: { pid: 4242 } });
    expect(sdk.query).not.toHaveBeenCalled();
  });

  it('writes to a session live elsewhere through its claude.ai bridge, without a second process', async () => {
    const sdk = makeSdk({ getSessionInfo: vi.fn(async () => sessionInfo()) });
    const liveRegistry = makeRegistry([owner()]);
    const remoteAttach = { send: vi.fn(async () => {}), closeAll: vi.fn() };
    const { runtime } = createRuntime({ sdk, liveRegistry, remoteAttach, livePollMs: 5 });

    const onStarted = vi.fn();
    await runtime.promptAsync({ sessionID: 'sess-1', directory: '/repo/project', parts: [{ type: 'text', text: 'hola' }], onStarted });

    expect(remoteAttach.send).toHaveBeenCalledWith('session_01REMOTE', [{ type: 'text', text: 'hola' }]);
    expect(onStarted).toHaveBeenCalled();
    expect(sdk.query).not.toHaveBeenCalled();
    expect(liveRegistry.stop).not.toHaveBeenCalled();
    await vi.waitFor(async () => {
      const session = await runtime.getSession({ sessionID: 'sess-1', directory: '/repo/project' });
      expect(session.metadata.liveElsewhere.attachable).toBe(true);
    });
    await runtime.shutdownAll();
    expect(remoteAttach.closeAll).toHaveBeenCalled();
  });

  it('puts a live session on the model picked here before writing to it', async () => {
    const sdk = makeSdk({ getSessionInfo: vi.fn(async () => sessionInfo()) });
    const liveRegistry = makeRegistry([owner()]);
    const remoteAttach = { send: vi.fn(async () => {}), setModel: vi.fn(async () => {}), closeAll: vi.fn() };
    const { runtime } = createRuntime({ sdk, liveRegistry, remoteAttach, livePollMs: 0 });

    await runtime.promptAsync({ sessionID: 'sess-1', directory: '/repo/project', parts: [{ type: 'text', text: 'hola' }] });
    expect(remoteAttach.setModel).not.toHaveBeenCalled();

    await runtime.promptAsync({
      sessionID: 'sess-1', directory: '/repo/project', parts: [{ type: 'text', text: 'otra' }], model: { modelID: 'sonnet[1m]' },
    });
    expect(remoteAttach.setModel).toHaveBeenCalledWith('session_01REMOTE', 'sonnet[1m]');
    expect(remoteAttach.setModel.mock.invocationCallOrder[0]).toBeLessThan(remoteAttach.send.mock.invocationCallOrder[1]);
    await runtime.shutdownAll();
  });

  it('puts a live session on the effort picked here, and changes its mode through the bridge at once', async () => {
    const sdk = makeSdk({ getSessionInfo: vi.fn(async () => sessionInfo()) });
    const liveRegistry = makeRegistry([owner()]);
    const remoteAttach = {
      send: vi.fn(async () => {}), setModel: vi.fn(async () => {}), setEffort: vi.fn(async () => {}),
      setPermissionMode: vi.fn(async () => {}), closeAll: vi.fn(),
    };
    const { runtime } = createRuntime({ sdk, liveRegistry, remoteAttach, livePollMs: 0 });

    await runtime.promptAsync({ sessionID: 'sess-1', directory: '/repo/project', parts: [{ type: 'text', text: 'hola' }], variant: 'max' });
    expect(remoteAttach.setEffort).toHaveBeenCalledWith('session_01REMOTE', 'max');
    expect(remoteAttach.setEffort.mock.invocationCallOrder[0]).toBeLessThan(remoteAttach.send.mock.invocationCallOrder[0]);

    await expect(runtime.setSessionMode({ sessionID: 'sess-1', mode: 'plan' })).resolves.toBe('plan');
    expect(remoteAttach.setPermissionMode).toHaveBeenCalledWith('session_01REMOTE', 'plan');
    expect(sdk.query).not.toHaveBeenCalled();
    await runtime.shutdownAll();
  });

  it('refuses a mode change for a live session that is not linked to claude.ai', async () => {
    const sdk = makeSdk();
    const liveRegistry = makeRegistry([owner({ bridgeSessionId: '' })]);
    const remoteAttach = { send: vi.fn(async () => {}), setPermissionMode: vi.fn(async () => {}), closeAll: vi.fn() };
    const { runtime } = createRuntime({ sdk, liveRegistry, remoteAttach, livePollMs: 0 });

    await expect(runtime.setSessionMode({ sessionID: 'sess-1', mode: 'plan' }))
      .rejects.toMatchObject({ code: 'CLAUDE_SESSION_LIVE_ELSEWHERE' });
    expect(remoteAttach.setPermissionMode).not.toHaveBeenCalled();
  });

  it('still refuses a live session that is not linked to claude.ai', async () => {
    const sdk = makeSdk();
    const liveRegistry = makeRegistry([owner({ bridgeSessionId: '' })]);
    const remoteAttach = { send: vi.fn(async () => {}), closeAll: vi.fn() };
    const { runtime } = createRuntime({ sdk, liveRegistry, remoteAttach, livePollMs: 0 });

    await expect(runtime.promptAsync({ sessionID: 'sess-1', parts: [{ type: 'text', text: 'hi' }] }))
      .rejects.toMatchObject({ code: 'CLAUDE_SESSION_LIVE_ELSEWHERE' });
    expect(remoteAttach.send).not.toHaveBeenCalled();
    expect(sdk.query).not.toHaveBeenCalled();
  });

  it('takes a session over: stops the owner, then resumes it here and reattaches its claude.ai link', async () => {
    const enableRemoteControl = vi.fn(async () => ({ session_url: 'https://claude.ai/code/session_01REMOTE' }));
    const sdk = makeSdk({
      getSessionInfo: vi.fn(async () => sessionInfo()),
      query: vi.fn(() => Object.assign(makeQuery([]), { enableRemoteControl })),
    });
    const liveRegistry = makeRegistry([owner()]);
    const { runtime } = createRuntime({
      sdk, liveRegistry, livePollMs: 0, remoteControl: { enabled: true },
    });

    await runtime.takeOverSession({ sessionID: 'sess-1' });

    expect(liveRegistry.stop).toHaveBeenCalledWith(expect.objectContaining({ pid: 4242 }));
    const options = sdk.query.mock.calls[0][0].options;
    expect(options.resume).toBe('sess-1');
    expect(options.cwd).toBe('/repo/project');
    await vi.waitFor(() => expect(enableRemoteControl).toHaveBeenCalledWith(
      true, 'summarised work', { reattachSessionId: 'session_01REMOTE' },
    ));
  });

  it('does not resume when the owner will not exit', async () => {
    const sdk = makeSdk();
    const liveRegistry = { ...makeRegistry([owner()]), stop: vi.fn(async () => false) };
    const { runtime } = createRuntime({ sdk, liveRegistry, livePollMs: 0 });

    await expect(runtime.takeOverSession({ sessionID: 'sess-1' })).rejects.toThrow(/did not exit/);
    expect(sdk.query).not.toHaveBeenCalled();
  });

  it('publishes the foreign owner, its busy state and its claude.ai link', async () => {
    const publishEvent = vi.fn();
    const sdk = makeSdk({ listSessions: vi.fn(async () => [sessionInfo()]) });
    const liveRegistry = makeRegistry([owner()]);
    const { runtime } = createRuntime({ sdk, publishEvent, liveRegistry, livePollMs: 5 });

    await runtime.listSessions({ directory: '/repo/project' });
    await vi.waitFor(async () => {
      const [session] = await runtime.listSessions({ directory: '/repo/project' });
      expect(session.metadata.liveElsewhere).toEqual({ entrypoint: 'claude-vscode', name: 'k8s-93', status: 'busy', pid: 4242, attachable: false });
      expect(session.metadata.remoteControl).toEqual({ url: 'https://claude.ai/code/session_01REMOTE' });
    });
    expect(await runtime.getStatusSnapshot({ directory: '/repo/project' })).toEqual({ 'sess-1': { type: 'busy' } });
    const statuses = publishEvent.mock.calls.map(([e]) => e.payload).filter((p) => p.type === 'session.status');
    expect(statuses.at(-1).properties.status.type).toBe('busy');

    // The owner goes idle, then exits: both are published.
    liveRegistry.state.owners.set('sess-1', owner({ status: 'idle' }));
    await vi.waitFor(() => expect(
      publishEvent.mock.calls.map(([e]) => e.payload).filter((p) => p.type === 'session.status').at(-1).properties.status.type,
    ).toBe('idle'));
    liveRegistry.state.owners.delete('sess-1');
    await vi.waitFor(async () => {
      const [session] = await runtime.listSessions({ directory: '/repo/project' });
      expect(session.metadata?.liveElsewhere).toBeUndefined();
    });
    await runtime.shutdownAll();
  });

  it('yields its own process when someone else resumes the session on top of it', async () => {
    const publishEvent = vi.fn();
    const close = vi.fn();
    const sdk = makeSdk({
      getSessionInfo: vi.fn(async () => sessionInfo()),
      query: vi.fn(() => makeQuery([
        { type: 'result', is_error: false, session_id: 'sess-1' },
        new Promise(() => {}),
      ], { close })),
    });
    const liveRegistry = makeRegistry([]);
    const { runtime } = createRuntime({ sdk, publishEvent, liveRegistry, livePollMs: 5, selfPid: 100 });

    await runtime.promptAsync({ sessionID: 'sess-1', directory: '/repo/project', parts: [{ type: 'text', text: 'hi' }] });
    // Our own CLI child is in the registry too: it is not a foreign writer.
    liveRegistry.state.owners.set('sess-1', owner({ entrypoint: 'sdk-ts', pid: 555, ppid: 100, status: 'idle' }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(close).not.toHaveBeenCalled();

    // VS Code resumes it on top of ours: ours closes, the session is followed.
    liveRegistry.state.owners.set('sess-1', owner({ pid: 4242, ppid: 1, status: 'busy' }));
    await vi.waitFor(() => expect(close).toHaveBeenCalled());
    await vi.waitFor(async () => {
      const session = await runtime.getSession({ sessionID: 'sess-1', directory: '/repo/project' });
      expect(session.metadata.liveElsewhere).toMatchObject({ entrypoint: 'claude-vscode', pid: 4242 });
    });
    await runtime.shutdownAll();
  });

  it('keeps following while the front end still shows the session, and catches up after a lapse', async () => {
    const publishEvent = vi.fn();
    let lastModified = 100;
    let transcript = [
      { type: 'user', uuid: 'u1', timestamp: '2026-09-23T00:00:00.000Z', message: { role: 'user', content: 'hola' } },
    ];
    const sdk = makeSdk({
      getSessionInfo: vi.fn(async () => sessionInfo({ lastModified })),
      getSessionMessages: vi.fn(async () => transcript),
    });
    const liveRegistry = makeRegistry([owner()]);
    const { runtime } = createRuntime({ sdk, publishEvent, liveRegistry, livePollMs: 5, liveFollowWindowMs: 40 });
    const texts = () => publishEvent.mock.calls.map(([e]) => e.payload)
      .filter((p) => p.type === 'message.part.updated').map((p) => p.properties.part.text);
    const write = (uuid, text) => {
      transcript = [...transcript, { type: 'assistant', uuid, timestamp: '2026-09-23T00:00:01.000Z', message: { id: `api_${uuid}`, role: 'assistant', content: [{ type: 'text', text }] } }];
      lastModified += 1;
    };

    await runtime.getMessages({ sessionID: 'sess-1', directory: '/repo/project' });
    // Reading a foreign session already armed the follow, so a renewal right
    // after it is not a lapse: nothing was missed.
    await expect(runtime.keepFollowing({ sessionID: 'sess-1', directory: '/repo/project' }))
      .resolves.toEqual({ lapsed: false });
    // Shown for longer than the window: the keep-alive holds the follow.
    const keepAlive = setInterval(() => { void runtime.keepFollowing({ sessionID: 'sess-1', directory: '/repo/project' }); }, 10);
    await new Promise((resolve) => setTimeout(resolve, 120));
    write('a1', 'sigue en vivo');
    await vi.waitFor(() => expect(texts()).toContain('sigue en vivo'));
    clearInterval(keepAlive);

    // Nobody pings, but the foreign writer is still live: the writer is its own
    // lease, so the follow holds and the list keeps moving (30-09: without this
    // the sidebar froze while VS Code wrote and the tab was backgrounded).
    await new Promise((resolve) => setTimeout(resolve, 120));
    write('a2', 'sin keep-alive');
    await vi.waitFor(() => expect(texts()).toContain('sin keep-alive'));
    await expect(runtime.keepFollowing({ sessionID: 'sess-1', directory: '/repo/project' }))
      .resolves.toEqual({ lapsed: false });

    // The writer exits: with no browser holding it either, the lease lapses and
    // nothing more is published.
    liveRegistry.state.owners.delete('sess-1');
    await new Promise((resolve) => setTimeout(resolve, 120));
    write('a3', 'mientras dormia');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(texts()).not.toContain('mientras dormia');

    // Shown again: the renewal says the lease was dead — the stream carried
    // none of that gap, so the window pulls the transcript, which has it all.
    await expect(runtime.keepFollowing({ sessionID: 'sess-1', directory: '/repo/project' }))
      .resolves.toEqual({ lapsed: true });
    const reread = await runtime.getMessages({ sessionID: 'sess-1', directory: '/repo/project' });
    expect(reread.map((record) => record.parts.map((part) => part.text).join('')).join('\n'))
      .toContain('mientras dormia');
    await runtime.shutdownAll();
  });

  it('follows the transcript while another process writes it, publishing only what changed', async () => {
    const publishEvent = vi.fn();
    let lastModified = 100;
    let transcript = [
      { type: 'user', uuid: 'u1', timestamp: '2026-09-23T00:00:00.000Z', message: { role: 'user', content: 'hola' } },
    ];
    const sdk = makeSdk({
      getSessionInfo: vi.fn(async () => sessionInfo({ lastModified })),
      getSessionMessages: vi.fn(async () => transcript),
    });
    const liveRegistry = makeRegistry([owner()]);
    const { runtime } = createRuntime({ sdk, publishEvent, liveRegistry, livePollMs: 5 });

    const first = await runtime.getMessages({ sessionID: 'sess-1', directory: '/repo/project' });
    expect(first).toHaveLength(1);
    await vi.waitFor(() => expect(sdk.getSessionInfo).toHaveBeenCalled());

    transcript = [
      ...transcript,
      { type: 'assistant', uuid: 'a1', timestamp: '2026-09-23T00:00:01.000Z', message: { id: 'api_1', role: 'assistant', content: [{ type: 'text', text: 'desde VS Code' }] } },
    ];
    lastModified = 200;

    await vi.waitFor(() => {
      const texts = publishEvent.mock.calls
        .map(([e]) => e.payload)
        .filter((p) => p.type === 'message.part.updated')
        .map((p) => p.properties.part.text);
      expect(texts).toContain('desde VS Code');
    });
    // The user message did not change, so it is not re-published.
    const userEchoes = publishEvent.mock.calls
      .map(([e]) => e.payload)
      .filter((p) => p.type === 'message.part.updated' && p.properties.part.text === 'hola');
    expect(userEchoes).toHaveLength(0);
    await runtime.shutdownAll();
  });

  describe('a live writer nobody has opened', () => {
    const events = (publishEvent, type) => publishEvent.mock.calls.map(([e]) => e.payload).filter((p) => p.type === type);
    const secondPoll = (liveRegistry) => vi.waitFor(() => expect(liveRegistry.read.mock.calls.length).toBeGreaterThanOrEqual(2));

    it('never reads its transcript: only its list row follows it', async () => {
      const publishEvent = vi.fn();
      let lastModified = 100;
      const sdk = makeSdk({
        getSessionInfo: vi.fn(async () => sessionInfo({ lastModified })),
        getSessionMessages: vi.fn(async () => []),
      });
      const read = vi.fn(async () => ({ toolResults: new Map(), subagents: new Map() }));
      const liveRegistry = makeRegistry([owner()]);
      const { runtime } = createRuntime({
        sdk,
        publishEvent,
        liveRegistry,
        livePollMs: 5,
        liveRowRefreshMs: 15,
        transcriptSidecar: { locate: async () => '/transcripts/sess-1.jsonl', read },
      });

      await runtime.listSessions({ directory: '/repo/project' });
      await secondPoll(liveRegistry);
      const rows = () => events(publishEvent, 'session.updated').length;
      const rowsBefore = rows();
      // The writer keeps writing: every poll finds a newer transcript.
      const writer = setInterval(() => { lastModified += 1; }, 2);
      await vi.waitFor(() => expect(rows()).toBeGreaterThanOrEqual(rowsBefore + 3));
      clearInterval(writer);

      expect(sdk.getSessionMessages).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(events(publishEvent, 'message.part.updated')).toHaveLength(0);
      await runtime.shutdownAll();
    });

    it('looks at a session at most once per refresh window, however often the writer writes', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
      try {
        const WRITERS = 26;
        const WINDOW = 200;
        const publishEvent = vi.fn();
        const ids = Array.from({ length: WRITERS }, (_, index) => `sess-${index}`);
        let tick = 100;
        const asked = [];
        const sdk = makeSdk({
          // Newer on every look: the transcript changes at every poll.
          getSessionInfo: vi.fn(async (sessionId) => {
            asked.push({ sessionId, at: Date.now() });
            tick += 1;
            return sessionInfo({ sessionId, lastModified: tick });
          }),
        });
        const liveRegistry = makeRegistry(ids.map((sessionId) => owner({ sessionId, pid: 1000 + Number(sessionId.slice(5)) })));
        const { runtime } = createRuntime({ sdk, publishEvent, liveRegistry, livePollMs: 10, liveRowRefreshMs: WINDOW });

        await runtime.listSessions({ directory: '/repo/project' });
        // The first polls: each writer is seen once, nothing more is asked of it yet.
        await vi.advanceTimersByTimeAsync(30);
        asked.length = 0;
        publishEvent.mockClear();

        await vi.advanceTimersByTimeAsync(3 * WINDOW);

        for (const sessionId of ids) {
          const looks = asked.filter((look) => look.sessionId === sessionId).map((look) => look.at);
          expect(looks.length).toBeGreaterThanOrEqual(1);
          expect(looks.length).toBeLessThanOrEqual(3);
          for (let i = 1; i < looks.length; i += 1) expect(looks[i] - looks[i - 1]).toBeGreaterThanOrEqual(WINDOW);
        }
        expect(asked.length).toBeLessThanOrEqual(WRITERS * 3);
        const rowsOf = (sessionId) => events(publishEvent, 'session.updated').filter((p) => p.properties.info.id === sessionId);
        for (const sessionId of ids) expect(rowsOf(sessionId).length).toBeLessThanOrEqual(3);
        await runtime.shutdownAll();
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not turn a failing getSessionInfo into a retry at every poll', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
      try {
        const sdk = makeSdk({ getSessionInfo: vi.fn(async () => { throw new Error('sdk down'); }) });
        const liveRegistry = makeRegistry([owner()]);
        const { runtime } = createRuntime({ sdk, liveRegistry, livePollMs: 10, liveRowRefreshMs: 200 });

        await runtime.listSessions({ directory: '/repo/project' });
        await vi.advanceTimersByTimeAsync(30);
        sdk.getSessionInfo.mockClear();
        await vi.advanceTimersByTimeAsync(600);

        expect(sdk.getSessionInfo.mock.calls.length).toBeLessThanOrEqual(3);
        await runtime.shutdownAll();
      } finally {
        vi.useRealTimers();
      }
    });

    it('takes one last look, without waiting, when the writer exits: the row moves only if the transcript did', async () => {
      const publishEvent = vi.fn();
      const modified = { moved: 100, still: 100 };
      const sdk = makeSdk({
        getSessionInfo: vi.fn(async (sessionId) => sessionInfo({ sessionId, lastModified: modified[sessionId] })),
      });
      const liveRegistry = makeRegistry([owner({ sessionId: 'moved' }), owner({ sessionId: 'still', pid: 4243 })]);
      // A window nothing in this test outlasts: only the last look can see the change.
      const { runtime } = createRuntime({ sdk, publishEvent, liveRegistry, livePollMs: 5, liveRowRefreshMs: 600_000 });
      const rowsOf = (sessionId) => events(publishEvent, 'session.updated').filter((p) => p.properties.info.id === sessionId);

      await runtime.listSessions({ directory: '/repo/project' });
      await secondPoll(liveRegistry);
      modified.moved = 200;
      const polls = liveRegistry.read.mock.calls.length;
      await vi.waitFor(() => expect(liveRegistry.read.mock.calls.length).toBeGreaterThanOrEqual(polls + 3));
      // Still alive: the window has not run out, so the row was not touched.
      expect(rowsOf('moved')).toHaveLength(0);

      liveRegistry.state.owners.clear();
      // The exit itself publishes the session once; the last look adds the new row of the one that moved.
      await vi.waitFor(() => expect(rowsOf('moved')).toHaveLength(2));
      expect(rowsOf('moved').at(-1).properties.info.time.updated).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(rowsOf('still')).toHaveLength(1);
      await runtime.shutdownAll();
    });

    it('becomes a full follow when a view reads it, and publishes only what changes after that', async () => {
      const publishEvent = vi.fn();
      let lastModified = 100;
      let transcript = [
        { type: 'user', uuid: 'u1', timestamp: '2026-09-23T00:00:00.000Z', message: { role: 'user', content: 'hola' } },
      ];
      const sdk = makeSdk({
        getSessionInfo: vi.fn(async () => sessionInfo({ lastModified })),
        getSessionMessages: vi.fn(async () => transcript),
      });
      const liveRegistry = makeRegistry([owner()]);
      const { runtime } = createRuntime({ sdk, publishEvent, liveRegistry, livePollMs: 5 });
      const texts = () => events(publishEvent, 'message.part.updated').map((p) => p.properties.part.text);

      await runtime.listSessions({ directory: '/repo/project' });
      await secondPoll(liveRegistry);
      // Followed without a view: it has no base to catch up from, so the view is told to pull.
      await expect(runtime.keepFollowing({ sessionID: 'sess-1', directory: '/repo/project' }))
        .resolves.toEqual({ lapsed: true });
      expect(sdk.getSessionMessages).not.toHaveBeenCalled();

      const history = await runtime.getMessages({ sessionID: 'sess-1', directory: '/repo/project' });
      expect(history).toHaveLength(1);
      await expect(runtime.keepFollowing({ sessionID: 'sess-1', directory: '/repo/project' }))
        .resolves.toEqual({ lapsed: false });

      transcript = [
        ...transcript,
        { type: 'assistant', uuid: 'a1', timestamp: '2026-09-23T00:00:01.000Z', message: { id: 'api_1', role: 'assistant', content: [{ type: 'text', text: 'ya con vista' }] } },
      ];
      lastModified = 200;
      await vi.waitFor(() => expect(texts()).toContain('ya con vista'));
      await new Promise((resolve) => setTimeout(resolve, 40));
      // The history the view already has is not sent again, and the news only once.
      expect(texts()).toEqual(['ya con vista']);
      await runtime.shutdownAll();
    });

    it('streams the answer of a claude.ai-attached writer even when it was only followed as a row', async () => {
      const publishEvent = vi.fn();
      let lastModified = 100;
      let transcript = [
        { type: 'user', uuid: 'u1', timestamp: '2026-09-23T00:00:00.000Z', message: { role: 'user', content: 'hola' } },
      ];
      const sdk = makeSdk({
        getSessionInfo: vi.fn(async () => sessionInfo({ lastModified })),
        getSessionMessages: vi.fn(async () => transcript),
      });
      const liveRegistry = makeRegistry([owner()]);
      const remoteAttach = { send: vi.fn(async () => {}), closeAll: vi.fn() };
      const { runtime } = createRuntime({ sdk, publishEvent, liveRegistry, remoteAttach, livePollMs: 5 });

      await runtime.listSessions({ directory: '/repo/project' });
      await secondPoll(liveRegistry);
      await runtime.promptAsync({ sessionID: 'sess-1', directory: '/repo/project', parts: [{ type: 'text', text: 'dime' }] });
      expect(remoteAttach.send).toHaveBeenCalled();

      transcript = [
        ...transcript,
        { type: 'assistant', uuid: 'a1', timestamp: '2026-09-23T00:00:01.000Z', message: { id: 'api_1', role: 'assistant', content: [{ type: 'text', text: 'respuesta del escritor' }] } },
      ];
      lastModified = 200;
      await vi.waitFor(() => expect(events(publishEvent, 'message.part.updated').map((p) => p.properties.part.text)).toContain('respuesta del escritor'));
      await runtime.shutdownAll();
    });
  });

  it('remembers a record by a short fingerprint, not by the record', () => {
    const record = { info: { id: 'm1' }, parts: [{ type: 'text', text: 'x'.repeat(1024 * 1024) }] };
    const fingerprint = recordFingerprint(record);
    expect(fingerprint.length).toBeLessThan(64);
    expect(recordFingerprint({ ...record })).toBe(fingerprint);
    // Same length, one character different: still a change.
    const edited = { ...record, parts: [{ type: 'text', text: `${'x'.repeat(1024 * 1024 - 1)}y` }] };
    expect(recordFingerprint(edited)).not.toBe(fingerprint);
    expect(recordFingerprint({ ...record, parts: [] })).not.toBe(fingerprint);
  });
});

describe('claude backend forkSession', () => {
  const line = (type, uuid, at, extra = {}) => ({
    type,
    uuid,
    timestamp: new Date(at).toISOString(),
    message: type === 'user'
      ? { role: 'user', content: [{ type: 'text', text: 'q' }] }
      : { id: `api-${uuid}`, role: 'assistant', content: [{ type: 'text', text: 'a' }] },
    ...extra,
  });
  const transcript = [line('user', 'u1', 1000), line('assistant', 'a1', 2000), line('user', 'u2', 3000)];
  const forkedInfo = sessionInfo({ sessionId: 'forked-1', customTitle: 'fork' });

  const setup = (overrides = {}) => {
    const sdk = makeSdk({
      getSessionMessages: vi.fn(async () => transcript),
      getSessionInfo: vi.fn(async (id) => (id === 'forked-1' ? forkedInfo : sessionInfo({ sessionId: id }))),
      ...overrides,
    });
    const publishEvent = vi.fn();
    return { ...createRuntime({ sdk, publishEvent }), publishEvent };
  };

  it('copies the whole transcript without `before`, as a sibling (no parentID)', async () => {
    const { runtime, sdk, publishEvent } = setup();
    const session = await runtime.forkSession({ sessionID: 'sess-1', directory: '/repo/project' });
    expect(sdk.forkSession).toHaveBeenCalledWith('sess-1', { dir: '/repo/project' });
    expect(session.id).toBe('forked-1');
    expect(session.parentID ?? null).toBeNull();
    const created = publishEvent.mock.calls.map(([event]) => event.payload ?? event).find((event) => event?.type === 'session.created');
    expect(created).toBeDefined();
  });

  it('cuts before the named record: everything up to the previous entry is kept', async () => {
    const { runtime, sdk } = setup();
    const records = await runtime.getMessages({ sessionID: 'sess-1', directory: '/repo/project', internal: true });
    const secondPrompt = records.filter((record) => record.info.role === 'user')[1].info.id;
    await runtime.forkSession({ sessionID: 'sess-1', directory: '/repo/project', before: secondPrompt });
    expect(sdk.forkSession).toHaveBeenCalledWith('sess-1', { dir: '/repo/project', upToMessageId: 'a1' });
  });

  it('forks before the first prompt as an empty session in the same directory', async () => {
    const { runtime, sdk } = setup();
    const records = await runtime.getMessages({ sessionID: 'sess-1', directory: '/repo/project', internal: true });
    const session = await runtime.forkSession({ sessionID: 'sess-1', directory: '/repo/project', before: records[0].info.id });
    expect(sdk.forkSession).not.toHaveBeenCalled();
    expect(session.directory).toBe('/repo/project');
    expect(session.id).not.toBe('sess-1');
  });

  it('refuses a cut point the transcript does not have, with a code the route can map', async () => {
    const { runtime, sdk } = setup();
    await expect(runtime.forkSession({ sessionID: 'sess-1', directory: '/repo/project', before: 'msg_nope' }))
      .rejects.toMatchObject({ code: 'CLAUDE_FORK_POINT_NOT_FOUND' });
    expect(sdk.forkSession).not.toHaveBeenCalled();
  });
});

describe('claude backend prompt uuids for later fork cuts', () => {
  it('sends each prompt with a uuid and resolves the client id to it', async () => {
    let sentUuid;
    const sdk = makeSdk({
      query: vi.fn(({ prompt }) => {
        const iterator = prompt[Symbol.asyncIterator]();
        return (async function* stream() {
          const first = await iterator.next();
          sentUuid = first.value.uuid;
          yield { type: 'result', is_error: false };
        })();
      }),
      getSessionInfo: vi.fn(async (id) => sessionInfo({ sessionId: id })),
    });
    const { runtime } = createRuntime({ sdk });
    await runtime.promptAsync({
      sessionID: 'sess-1',
      directory: '/repo/project',
      parts: [{ type: 'text', text: 'second' }],
      messageID: 'msg_client_2',
    });
    expect(typeof sentUuid).toBe('string');

    sdk.getSessionMessages.mockImplementation(async () => [
      { type: 'user', uuid: 'u1', timestamp: new Date(1000).toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'first' }] } },
      { type: 'assistant', uuid: 'a1', timestamp: new Date(2000).toISOString(), message: { id: 'x', role: 'assistant', content: [{ type: 'text', text: 'a' }] } },
      { type: 'user', uuid: sentUuid, timestamp: new Date(3000).toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'second' }] } },
    ]);
    await runtime.forkSession({ sessionID: 'sess-1', directory: '/repo/project', before: 'msg_client_2' });
    expect(sdk.forkSession).toHaveBeenCalledWith('sess-1', { dir: '/repo/project', upToMessageId: 'a1' });
  });
});

describe('claude backend listCommands', () => {
  it('is empty before any Claude process ran', async () => {
    const { runtime } = createRuntime();
    await expect(runtime.listCommands({ directory: '/repo/project' })).resolves.toEqual([]);
  });

  it('reads the commands a live CLI reports and keeps them for when none runs', async () => {
    let finishTurn;
    const hold = new Promise((resolve) => { finishTurn = resolve; });
    const supportedCommands = vi.fn(async () => [
      { name: '/review', description: 'Review a PR', argumentHint: '<pr>' },
      { name: 'compact', description: 'Compact the context', argumentHint: '' },
      { name: '  ', description: 'blank names are dropped' },
    ]);
    const sdk = makeSdk({
      query: vi.fn(() => makeQuery([], {
        supportedCommands,
        [Symbol.asyncIterator]() {
          return (async function* stream() {
            await hold;
            yield { type: 'result', is_error: false };
          })();
        },
      })),
    });
    const { runtime } = createRuntime({ sdk });
    const turn = runtime.promptAsync({ sessionID: 'sess-1', directory: '/repo/project', parts: [{ type: 'text', text: 'hi' }] });
    await vi.waitFor(() => expect(sdk.query).toHaveBeenCalled());

    const commands = await runtime.listCommands({ directory: '/repo/project' });
    expect(commands).toEqual([
      { name: 'review', description: 'Review a PR', argumentHint: '<pr>' },
      { name: 'compact', description: 'Compact the context', argumentHint: '' },
    ]);
    finishTurn();
    await turn;
    supportedCommands.mockRejectedValue(new Error('process gone'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(runtime.listCommands({ directory: '/repo/project' })).resolves.toEqual(commands);
    warn.mockRestore();
  });
});

describe('claude backend deleteSession with a live CLI', () => {
  it('waits for the CLI to exit before deleting, so its closing write cannot recreate the transcript', async () => {
    const order = [];
    const sdk = makeSdk({
      getSessionInfo: vi.fn(async (id) => sessionInfo({ sessionId: id })),
      deleteSession: vi.fn(async () => { order.push('delete'); }),
      query: vi.fn(({ prompt }) => (async function* stream() {
        for await (const message of prompt) {
          void message;
          yield { type: 'result', is_error: false };
        }
        // The CLI writes its closing stats on the way out.
        await new Promise((resolve) => setTimeout(resolve, 30));
        order.push('exit');
      })()),
    });
    const { runtime } = createRuntime({ sdk });
    await runtime.promptAsync({ sessionID: 'sess-1', directory: '/repo/project', parts: [{ type: 'text', text: 'hi' }] });
    await runtime.deleteSession({ sessionID: 'sess-1', directory: '/repo/project' });
    expect(order).toEqual(['exit', 'delete']);
  });
});

describe('claude backend — subagents, modes and questions', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

  /** A CLI whose first turn starts a subagent and holds until released. */
  const subagentQuery = (gate) => ({ prompt, options }) => {
    const handle = (async function* stream() {
      for await (const message of prompt) {
        yield { ...message, isReplay: true };
        yield { type: 'assistant', message: { id: 'api_1', content: [{ type: 'tool_use', id: 'toolu_a', name: 'Agent', input: { subagent_type: 'Explore', description: 'Find it', prompt: 'look' } }] } };
        yield { type: 'system', subtype: 'task_started', task_id: 'ag1', tool_use_id: 'toolu_a', description: 'Find it', subagent_type: 'Explore' };
        await gate;
        yield { type: 'system', subtype: 'task_notification', task_id: 'ag1', status: 'completed' };
        yield { type: 'result', is_error: false };
      }
    })();
    handle.options = options;
    handle.interrupt = vi.fn(async () => {});
    handle.stopTask = vi.fn(async () => {});
    handle.setPermissionMode = vi.fn(async () => {});
    return handle;
  };

  it('announces a running subagent as a busy child session, readable before its files exist', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const handles = [];
    const sdk = makeSdk({ query: vi.fn((args) => { const handle = subagentQuery(gate)(args); handles.push(handle); return handle; }) });
    const publishEvent = vi.fn();
    const { runtime } = createRuntime({ sdk, publishEvent });

    const turn = runtime.promptAsync({ sessionID: 'sess-1', directory: '/repo/project', parts: [{ type: 'text', text: 'go' }] });
    await settle();

    const payloads = publishEvent.mock.calls.map(([call]) => call.payload);
    const created = payloads.find((payload) => payload.type === 'session.created');
    expect(created.properties.info).toMatchObject({ id: 'sess-1~ag1', parentID: 'sess-1', title: 'Find it', metadata: { subagent: { agentType: 'Explore', status: 'running' } } });
    expect(payloads.some((payload) => payload.type === 'session.status' && payload.properties.sessionID === 'sess-1~ag1' && payload.properties.status.type === 'busy')).toBe(true);

    const children = await runtime.listSubagentSessions({ sessionID: 'sess-1' });
    expect(children.map((child) => [child.id, child.parentID, child.metadata.subagent.status])).toEqual([['sess-1~ag1', 'sess-1', 'running']]);
    expect((await runtime.getSession({ sessionID: 'sess-1~ag1' })).title).toBe('Find it');

    // Stopping the child stops that subagent only.
    await runtime.abortSession({ sessionID: 'sess-1~ag1' });
    expect(handles[0].stopTask).toHaveBeenCalledWith('ag1');
    expect(handles[0].interrupt).not.toHaveBeenCalled();

    release();
    await turn;
    await settle();
    expect((await runtime.listSubagentSessions({ sessionID: 'sess-1' }))[0].metadata.subagent.status).toBe('completed');
    await runtime.shutdownAll();
  });

  it('reads a subagent\'s own transcript for its child id', async () => {
    const sdk = makeSdk({
      // As the SDK returns them: every entry names the call that started the subagent.
      getSubagentMessages: vi.fn(async () => [
        { type: 'user', uuid: 'u1', parent_tool_use_id: 'toolu_a', timestamp: '2026-09-28T00:00:00.000Z', message: { role: 'user', content: 'look for it' } },
        { type: 'assistant', uuid: 'a1', parent_tool_use_id: 'toolu_a', timestamp: '2026-09-28T00:00:01.000Z', message: { id: 'api_s', role: 'assistant', content: [{ type: 'text', text: 'sub answer' }] } },
      ]),
    });
    const { runtime } = createRuntime({ sdk });
    const records = await runtime.getMessages({ sessionID: 'sess-1~ag1', directory: '/repo/project' });
    expect(sdk.getSubagentMessages).toHaveBeenCalledWith('sess-1', 'ag1', { dir: '/repo/project' });
    expect(records.map((record) => record.info.role)).toEqual(['user', 'assistant']);
    expect(records.flatMap((record) => record.parts).map((part) => part.text)).toEqual(['look for it', 'sub answer']);
  });

  it('switches a live process\'s mode at once and publishes it on the session', async () => {
    const handles = [];
    const sdk = makeSdk({
      getSessionInfo: vi.fn(async () => sessionInfo()),
      query: vi.fn(({ prompt }) => {
        const handle = (async function* stream() {
          for await (const message of prompt) {
            yield { ...message, isReplay: true };
            yield { type: 'result', is_error: false };
          }
        })();
        handle.interrupt = vi.fn(async () => {});
        handle.setPermissionMode = vi.fn(async () => {});
        handles.push(handle);
        return handle;
      }),
    });
    const publishEvent = vi.fn();
    const { runtime } = createRuntime({ sdk, publishEvent });
    await runtime.promptAsync({ sessionID: 'sess-1', directory: '/repo/project', parts: [{ type: 'text', text: 'go' }] });
    await settle();

    await expect(runtime.setSessionMode({ sessionID: 'sess-1', mode: 'plan' })).resolves.toBe('plan');
    expect(handles[0].setPermissionMode).toHaveBeenCalledWith('plan');
    const session = await runtime.getSession({ sessionID: 'sess-1' });
    expect(session.metadata.claude).toMatchObject({ mode: 'plan' });
    await expect(runtime.setSessionMode({ sessionID: 'sess-1', mode: 'bypassPermissions' })).rejects.toMatchObject({ code: 'UNKNOWN_MODE' });
    await runtime.shutdownAll();
  });

  it('withdraws an unanswered question when its process ends', async () => {
    let asked;
    const sdk = makeSdk({
      query: vi.fn(({ prompt, options }) => {
        const handle = (async function* stream() {
          for await (const message of prompt) {
            yield { ...message, isReplay: true };
            asked = options.canUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal, toolUseID: 't', requestId: 'r' });
            await new Promise(() => {});
          }
        })();
        handle.interrupt = vi.fn(async () => {});
        handle.close = vi.fn();
        return handle;
      }),
    });
    const { runtime } = createRuntime({ sdk });
    void runtime.promptAsync({ sessionID: 'sess-1', directory: '/repo/project', parts: [{ type: 'text', text: 'go' }] });
    await settle();
    expect(runtime.requests.list('permission')).toHaveLength(1);
    await runtime.abortSession({ sessionID: 'sess-1' });
    await expect(asked).resolves.toMatchObject({ behavior: 'deny' });
    expect(runtime.requests.list('permission')).toHaveLength(0);
  });
});

describe('claude backend — rewind code to a prompt', () => {
  const transcript = [
    { type: 'user', uuid: 'u-1', timestamp: '2026-09-28T00:00:00.000Z', message: { role: 'user', content: 'edit a' } },
    { type: 'assistant', uuid: 'a-1', timestamp: '2026-09-28T00:00:01.000Z', message: { id: 'api_1', role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
  ];

  const rewindSdk = (rewind) => makeSdk({
    getSessionMessages: vi.fn(async () => transcript),
    query: vi.fn(({ prompt, options }) => {
      const handle = (async function* stream() {
        for await (const message of prompt) {
          yield { ...message, isReplay: true };
          yield { type: 'result', is_error: false };
        }
      })();
      handle.options = options;
      handle.interrupt = vi.fn(async () => {});
      handle.close = vi.fn();
      handle.rewindFiles = rewind;
      return handle;
    }),
  });

  it('rewinds the files to the prompt a record names, starting the process for it, with checkpoints on', async () => {
    const rewind = vi.fn(async (_uuid, { dryRun }) => ({ canRewind: true, filesChanged: ['a.txt'], insertions: 1, deletions: dryRun ? 2 : 2 }));
    const sdk = rewindSdk(rewind);
    const { runtime } = createRuntime({ sdk });
    const records = await runtime.getMessages({ sessionID: 'sess-1', directory: '/repo/project' });
    const prompt = records.find((record) => record.info.role === 'user');

    const preview = await runtime.rewindFiles({ sessionID: 'sess-1', messageID: prompt.info.id, dryRun: true, directory: '/repo/project' });
    expect(preview).toEqual({ canRewind: true, filesChanged: ['a.txt'], insertions: 1, deletions: 2 });
    expect(rewind).toHaveBeenCalledWith('u-1', { dryRun: true });
    expect(sdk.query.mock.calls[0][0].options.enableFileCheckpointing).toBe(true);

    await runtime.rewindFiles({ sessionID: 'sess-1', messageID: prompt.info.id, directory: '/repo/project' });
    expect(rewind).toHaveBeenLastCalledWith('u-1', { dryRun: false });
    // One process for both: the second call reused it.
    expect(sdk.query).toHaveBeenCalledTimes(1);
    await runtime.shutdownAll();
  });

  it('refuses a record that is not a prompt of the transcript, and a subagent', async () => {
    const { runtime } = createRuntime({ sdk: rewindSdk(vi.fn()) });
    await expect(runtime.rewindFiles({ sessionID: 'sess-1', messageID: 'msg_nope', directory: '/repo/project' }))
      .rejects.toMatchObject({ code: 'CLAUDE_FORK_POINT_NOT_FOUND' });
    await expect(runtime.rewindFiles({ sessionID: 'sess-1~ag1', messageID: 'msg_x' })).rejects.toThrow('Session not found');
    await runtime.shutdownAll();
  });
});

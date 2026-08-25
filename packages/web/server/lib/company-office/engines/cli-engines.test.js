import { EventEmitter } from 'node:events';
import { describe, expect, test, vi } from 'vitest';
import { createProcessRegistry, startTurn, TurnStartError } from './cli-runtime.js';
import { createClaudeEngine, sessionIdForTicket, subscriptionEnv } from './claude.js';
import { createCodexEngine, ticketMarker } from './codex.js';

/** A child process that behaves the way the engines actually use one. */
const fakeChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn((signal) => {
    child.signalCode = signal;
    child.emit('exit', null, signal);
    return true;
  });
  child.finish = (code = 0) => {
    child.exitCode = code;
    child.emit('exit', code, null);
  };
  return child;
};

/** Records the argv every spawn received so invariants can be asserted on it. */
const recordingSpawn = () => {
  const calls = [];
  const spawnImpl = vi.fn((command, args, options) => {
    const child = fakeChild();
    calls.push({ command, args, options, child });
    return child;
  });
  return { calls, spawnImpl };
};

const plan = (overrides = {}) => ({
  ticketKey: 'SC-122',
  directory: '/srv/repo-a',
  title: '[SC-122] Wire the thing',
  prompt: 'Ticket SC-122: wire the thing',
  agent: 'company/developer',
  ...overrides,
});

describe('cli runtime', () => {
  test('a preset session id settles the start without waiting for the turn', async () => {
    const { spawnImpl, calls } = recordingSpawn();
    const registry = createProcessRegistry();

    const started = await startTurn({
      command: 'claude',
      args: [],
      cwd: '/srv/repo-a',
      registry,
      presetSessionId: 'preset-id',
      spawnImpl,
    });

    expect(started.sessionId).toBe('preset-id');
    // The turn is still running: dispatch must not block on it.
    expect(registry.isBusy('preset-id')).toBe(true);
    calls[0].child.finish(0);
    expect(registry.isBusy('preset-id')).toBe(false);
  });

  test('an announced session id settles the start at the first line that carries it', async () => {
    const { spawnImpl, calls } = recordingSpawn();
    const registry = createProcessRegistry();

    const pending = startTurn({
      command: 'codex',
      args: [],
      cwd: '/srv/repo-a',
      registry,
      readSessionId: (event) => (event?.type === 'thread.started' ? event.thread_id : null),
      spawnImpl,
    });

    const { child } = calls[0];
    child.stdout.emit('data', '{"type":"turn.started"}\n');
    child.stdout.emit('data', '{"type":"thread.started","thread_id":"th-1"}\n');

    await expect(pending).resolves.toMatchObject({ sessionId: 'th-1' });
    expect(registry.isBusy('th-1')).toBe(true);
  });

  test('a half-written line is not parsed until it is whole', async () => {
    const { spawnImpl, calls } = recordingSpawn();
    const pending = startTurn({
      command: 'codex',
      args: [],
      cwd: '/srv/repo-a',
      readSessionId: (event) => (event?.type === 'thread.started' ? event.thread_id : null),
      spawnImpl,
    });

    const { child } = calls[0];
    child.stdout.emit('data', '{"type":"thread.started","thre');
    child.stdout.emit('data', 'ad_id":"th-split"}\n');

    await expect(pending).resolves.toMatchObject({ sessionId: 'th-split' });
  });

  test('exiting before a session id reports the CLI stderr, not a generic failure', async () => {
    const { spawnImpl, calls } = recordingSpawn();
    const pending = startTurn({ command: 'codex', args: [], cwd: '/srv/repo-a', spawnImpl });

    const { child } = calls[0];
    child.stderr.emit('data', 'Not inside a trusted directory');
    child.finish(1);

    await expect(pending).rejects.toThrow(TurnStartError);
    await expect(pending).rejects.toThrow(/Not inside a trusted directory/);
  });

  test('aborting signals the child so the session file closes cleanly', async () => {
    const { spawnImpl, calls } = recordingSpawn();
    const registry = createProcessRegistry();
    await startTurn({ command: 'claude', args: [], cwd: '/x', registry, presetSessionId: 's1', spawnImpl });

    expect(registry.statuses()).toEqual({ s1: { type: 'busy' } });
    await registry.abort('s1');

    expect(calls[0].child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(registry.statuses()).toEqual({});
  });

  test('a finished turn is not busy, and an unknown session is not busy either', async () => {
    const { spawnImpl, calls } = recordingSpawn();
    const registry = createProcessRegistry();
    await startTurn({ command: 'claude', args: [], cwd: '/x', registry, presetSessionId: 's1', spawnImpl });

    calls[0].child.finish(0);
    expect(registry.isBusy('s1')).toBe(false);
    expect(registry.isBusy('never-started')).toBe(false);
  });
});

describe('claude engine', () => {
  test('the ticket derives its session id, identically and forever', () => {
    const first = sessionIdForTicket('SC-122');
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(sessionIdForTicket('SC-122')).toBe(first);
    expect(sessionIdForTicket('SC-123')).not.toBe(first);
    // Pinned: this value IS the ticket->history link. Changing it detaches every
    // ticket in flight from its session.
    expect(first).toBe(sessionIdForTicket('SC-122', '6f1d2a54-7b3c-4e18-9a60-2c5f0b7d4e91'));
  });

  test('a ticket is claimed by the presence of its own session file', async () => {
    const claimed = sessionIdForTicket('SC-122');
    const readdirImpl = vi.fn(async (path, options) => (
      options?.withFileTypes
        ? [{ name: '-srv-repo-a', isDirectory: () => true }]
        : [`${claimed}.jsonl`, 'not-a-session.txt']
    ));
    const engine = createClaudeEngine({ readdirImpl });

    const found = await engine.findSessionsByTicket(['SC-122', 'SC-999']);
    expect(found.byTicket.get('SC-122')).toMatchObject({ sessionId: claimed });
    expect(found.byTicket.has('SC-999')).toBe(false);
    expect(found.state).toBe('ready');
  });

  test('an unreadable store fails loudly instead of reporting every ticket free', async () => {
    const engine = createClaudeEngine({
      readdirImpl: vi.fn(async () => { throw new Error('EACCES'); }),
    });
    await expect(engine.findSessionsByTicket(['SC-122'])).rejects.toThrow(/Claude session scan failed/);
  });

  test('starting names the session; adopting resumes that same name', async () => {
    const { spawnImpl, calls } = recordingSpawn();
    const engine = createClaudeEngine({ spawnImpl, model: 'opus' });

    const started = await engine.spawn(plan());
    expect(started.sessionId).toBe(sessionIdForTicket('SC-122'));
    expect(calls[0].args).toEqual(expect.arrayContaining(['--session-id', sessionIdForTicket('SC-122')]));
    expect(calls[0].args).toEqual(expect.arrayContaining(['--model', 'opus']));
    expect(calls[0].options.cwd).toBe('/srv/repo-a');
    expect(calls[0].options.env.CLAUDE_CONFIG_DIR).toMatch(/\.claude$/);

    await engine.adopt(plan(), { sessionId: sessionIdForTicket('SC-122') });
    expect(calls[1].args).toEqual(expect.arrayContaining(['--resume', sessionIdForTicket('SC-122')]));
    expect(calls[1].args).not.toEqual(expect.arrayContaining(['--session-id']));
  });

  test('ambient config cannot move a turn off the subscription', () => {
    const clean = subscriptionEnv({
      PATH: '/usr/bin',
      ANTHROPIC_BASE_URL: 'https://litellm.lan.e-dani.com/v1',
      ANTHROPIC_API_KEY: 'sk-metered',
      ANTHROPIC_AUTH_TOKEN: 'tok',
      CLAUDE_CODE_OAUTH_TOKEN: 'other-identity',
    }, '/accounts/personal');

    // A gateway URL reroutes the session; a key moves it onto metered billing.
    // Neither is visible in the transcript afterwards.
    expect(clean.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(clean.ANTHROPIC_API_KEY).toBeUndefined();
    expect(clean.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(clean.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(clean.CLAUDE_CONFIG_DIR).toBe('/accounts/personal');
    expect(clean.PATH).toBe('/usr/bin');
  });

  test('the guard is applied to the spawn itself, not only exported', async () => {
    const { spawnImpl, calls } = recordingSpawn();
    const engine = createClaudeEngine({
      spawnImpl,
      env: { PATH: '/usr/bin', ANTHROPIC_BASE_URL: 'https://litellm.lan.e-dani.com/v1' },
    });
    await engine.spawn(plan());
    expect(calls[0].options.env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  test('sessions are never archived, because they are the claim and the operator copy', async () => {
    const engine = createClaudeEngine();
    await expect(engine.archive('any')).resolves.toMatchObject({ archived: false });
  });
});

describe('codex engine', () => {
  const rolloutDir = (entries) => vi.fn(async () => entries);

  test('every run forces the provider, so a config the plugin rewrites cannot route it to the bridge', async () => {
    const { spawnImpl, calls } = recordingSpawn();
    const engine = createCodexEngine({ spawnImpl, model: 'gpt-5.6-sol' });

    const pending = engine.spawn(plan());
    calls[0].child.stdout.emit('data', '{"type":"thread.started","thread_id":"th-9"}\n');
    await expect(pending).resolves.toMatchObject({ sessionId: 'th-9' });

    expect(calls[0].args).toEqual(expect.arrayContaining(['-c', 'model_provider=openai']));
    expect(calls[0].args).toEqual(expect.arrayContaining(['-m', 'gpt-5.6-sol']));
    expect(calls[0].args).not.toEqual(expect.arrayContaining([expect.stringContaining('litellm')]));
    expect(calls[0].options.env.CODEX_HOME).toMatch(/\.codex$/);
  });

  test('the ticket marker travels in the prompt, so the rollout carries the claim', async () => {
    const { spawnImpl, calls } = recordingSpawn();
    const engine = createCodexEngine({ spawnImpl });

    const pending = engine.spawn(plan());
    calls[0].child.stdout.emit('data', '{"type":"thread.started","thread_id":"th-1"}\n');
    await pending;

    expect(calls[0].args.at(-1)).toContain(ticketMarker('SC-122'));
    expect(calls[0].args.at(-1)).toContain('wire the thing');
  });

  test('adopting resumes the rollout the ticket already owns', async () => {
    const { spawnImpl, calls } = recordingSpawn();
    const engine = createCodexEngine({ spawnImpl });

    const pending = engine.adopt(plan(), { sessionId: 'th-old' });
    calls[0].child.stdout.emit('data', '{"type":"thread.started","thread_id":"th-old"}\n');
    await pending;

    expect(calls[0].args.slice(0, 3)).toEqual(['exec', 'resume', 'th-old']);
  });

  test('a ticket is claimed by the marker inside its rollout', async () => {
    const id = '01a021e4-179e-7e10-85ce-6f01c4b8aaa3';
    const engine = createCodexEngine({
      readdirImpl: rolloutDir([`rollout-2026-08-21T03-16-31-${id}.jsonl`]),
      openImpl: vi.fn(async () => ({
        read: async (buffer) => {
          const text = `{"type":"session_meta"}\n[SC-122] Wire the thing\n`;
          buffer.write(text);
          return { bytesRead: Buffer.byteLength(text) };
        },
        close: async () => {},
      })),
    });

    const found = await engine.findSessionsByTicket(['SC-122']);
    expect(found.byTicket.get('SC-122')).toMatchObject({ sessionId: id });
    expect(found.state).toBe('ready');
  });

  test('two rollouts for one ticket resume neither, and say so', async () => {
    const first = '01a021e4-179e-7e10-85ce-6f01c4b8aaa3';
    const second = '01a021e4-179e-7e10-85ce-6f01c4b8bbbb';
    const engine = createCodexEngine({
      readdirImpl: rolloutDir([
        `rollout-2026-08-21T03-16-31-${first}.jsonl`,
        `rollout-2026-08-21T04-16-31-${second}.jsonl`,
      ]),
      openImpl: vi.fn(async () => ({
        read: async (buffer) => {
          const text = '[SC-122] Wire the thing\n';
          buffer.write(text);
          return { bytesRead: Buffer.byteLength(text) };
        },
        close: async () => {},
      })),
    });

    const found = await engine.findSessionsByTicket(['SC-122']);
    expect(found.byTicket.has('SC-122')).toBe(false);
    expect(found.duplicates).toEqual(['SC-122']);
    expect(found.state).toBe('partial');
  });

  test('an unreadable rollout downgrades the scan instead of freeing the ticket', async () => {
    const engine = createCodexEngine({
      readdirImpl: rolloutDir(['rollout-2026-08-21T03-16-31-01a021e4-179e-7e10-85ce-6f01c4b8aaa3.jsonl']),
      openImpl: vi.fn(async () => { throw new Error('EACCES'); }),
    });

    const found = await engine.findSessionsByTicket(['SC-122']);
    expect(found.state).toBe('partial');
  });
});

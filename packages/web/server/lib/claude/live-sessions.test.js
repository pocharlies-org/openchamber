import { describe, expect, it, vi } from 'vitest';

import { createLiveSessionRegistry, remoteControlUrl } from './live-sessions.js';

const DIR = '/home/test/.claude/sessions';

const makeFs = (entries, procStarts = {}) => ({
  readdir: vi.fn(async () => Object.keys(entries)),
  readFile: vi.fn(async (target) => {
    const name = target.split('/').pop();
    if (target.startsWith('/proc/')) {
      const pid = target.split('/')[2];
      if (!(pid in procStarts)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      // 52 fields; comm with a space to prove parsing from the closing paren.
      const fields = Array.from({ length: 50 }, (_, i) => String(i + 3));
      fields[22 - 3] = String(procStarts[pid]);
      return `${pid} (claude code) ${fields.join(' ')}`;
    }
    if (!(name in entries)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return typeof entries[name] === 'string' ? entries[name] : JSON.stringify(entries[name]);
  }),
});

const entry = (pid, overrides = {}) => ({
  pid,
  sessionId: `sess-${pid}`,
  cwd: '/repo',
  procStart: '100',
  entrypoint: 'claude-vscode',
  name: `n-${pid}`,
  status: 'idle',
  updatedAt: 10,
  ...overrides,
});

const killFor = (alive) => vi.fn((pid, signal) => {
  if (alive.has(pid)) {
    if (signal === 'SIGTERM') alive.delete(pid);
    return true;
  }
  throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
});

describe('live session registry', () => {
  it('lists sessions whose process is alive and started when recorded', async () => {
    const fs = makeFs({
      '1.json': entry(1, { status: 'busy', bridgeSessionId: 'session_01A' }),
      '2.json': entry(2),
      '3.json': entry(3),
      'notes.txt': 'x',
    }, { 1: '100', 3: '999' });
    const registry = createLiveSessionRegistry({
      fsPromises: fs, sessionsDir: DIR, kill: killFor(new Set([1, 3])), platform: 'linux',
    });

    const owners = await registry.read();

    // 2 is dead; 3 is a reused pid (different start time).
    expect(Array.from(owners.keys())).toEqual(['sess-1']);
    expect(owners.get('sess-1')).toMatchObject({
      pid: 1, entrypoint: 'claude-vscode', status: 'busy', bridgeSessionId: 'session_01A',
    });
  });

  it('keeps the most recently active writer when one session has two entries', async () => {
    const fs = makeFs({
      '1.json': entry(1, { sessionId: 'same', updatedAt: 5 }),
      '2.json': entry(2, { sessionId: 'same', updatedAt: 50 }),
    }, { 1: '100', 2: '100' });
    const registry = createLiveSessionRegistry({
      fsPromises: fs, sessionsDir: DIR, kill: killFor(new Set([1, 2])), platform: 'linux',
    });
    expect((await registry.read()).get('same').pid).toBe(2);
  });

  it('skips unreadable entries and treats a missing directory as nothing live', async () => {
    const fs = makeFs({ '1.json': '{not json' });
    const registry = createLiveSessionRegistry({ fsPromises: fs, sessionsDir: DIR, kill: killFor(new Set([1])) });
    expect((await registry.read()).size).toBe(0);

    const missing = {
      readdir: vi.fn(async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }),
      readFile: vi.fn(),
    };
    const empty = createLiveSessionRegistry({ fsPromises: missing, sessionsDir: DIR });
    expect((await empty.read()).size).toBe(0);
  });

  it('stops an owner and waits for its pid to go away', async () => {
    const alive = new Set([7]);
    const kill = killFor(alive);
    const registry = createLiveSessionRegistry({ fsPromises: makeFs({}), sessionsDir: DIR, kill });
    await expect(registry.stop({ pid: 7 }, { sleep: async () => {} })).resolves.toBe(true);
    expect(kill).toHaveBeenCalledWith(7, 'SIGTERM');
  });

  it('resets the revive unit of an owner it stopped', async () => {
    const alive = new Set([9]);
    const fsPromises = makeFs({});
    const readFile = fsPromises.readFile;
    fsPromises.readFile = vi.fn(async (target, ...rest) => (target === '/proc/9/cgroup'
      ? '0::/user.slice/user-1000.slice/user@1000.service/claude-revive.slice/claude-rc-revive-ae04f51c.service\n'
      : readFile(target, ...rest)));
    const resetFailedUnit = vi.fn(async () => {});
    const registry = createLiveSessionRegistry({
      fsPromises, sessionsDir: DIR, kill: killFor(alive), platform: 'linux', resetFailedUnit,
    });
    await expect(registry.stop({ pid: 9 }, { sleep: async () => {} })).resolves.toBe(true);
    expect(resetFailedUnit).toHaveBeenCalledWith('claude-rc-revive-ae04f51c.service');
  });

  it('leaves other units alone (VS Code, the Remote Control daemon)', async () => {
    const alive = new Set([10]);
    const fsPromises = makeFs({});
    const readFile = fsPromises.readFile;
    fsPromises.readFile = vi.fn(async (target, ...rest) => (target === '/proc/10/cgroup'
      ? '0::/user.slice/user-1000.slice/user@1000.service/app.slice/claude-rc-k8s.service\n'
      : readFile(target, ...rest)));
    const resetFailedUnit = vi.fn(async () => {});
    const registry = createLiveSessionRegistry({
      fsPromises, sessionsDir: DIR, kill: killFor(alive), platform: 'linux', resetFailedUnit,
    });
    await expect(registry.stop({ pid: 10 }, { sleep: async () => {} })).resolves.toBe(true);
    expect(resetFailedUnit).not.toHaveBeenCalled();
  });

  it('reports an owner that outlives the timeout', async () => {
    const kill = vi.fn(() => true);
    const registry = createLiveSessionRegistry({ fsPromises: makeFs({}), sessionsDir: DIR, kill });
    await expect(registry.stop({ pid: 8 }, { timeoutMs: 5, pollMs: 1 })).resolves.toBe(false);
  });
});

describe('remoteControlUrl', () => {
  it('builds the claude.ai link from a bridge session id', () => {
    expect(remoteControlUrl('session_01X')).toBe('https://claude.ai/code/session_01X');
    expect(remoteControlUrl('cse_01X')).toBe('https://claude.ai/code/session_01X');
    expect(remoteControlUrl('')).toBe('');
  });
});

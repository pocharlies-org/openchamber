import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createClaudeAccountService } from './account.js';

/** The CLI's answer to `auth status --json`, flipped by the test. */
const STATUS = {
  signedIn: {
    loggedIn: true,
    authMethod: 'claude.ai',
    email: 'me@example.com',
    orgName: 'Example',
    subscriptionType: 'max',
    configDirectory: '/home/test/.claude',
  },
  signedOut: { loggedIn: false },
};

const createSpawnSync = (state) => vi.fn(() => ({
  stdout: JSON.stringify(state.signedIn ? STATUS.signedIn : STATUS.signedOut),
}));

const createChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { writable: true, writes: [], write(value) { this.writes.push(value); } };
  child.kill = vi.fn(() => { });
  return child;
};

/** The three lines `claude auth login` prints before it waits (observed shape). */
const handoffToChild = (child) => {
  child.stdout.emit('data', 'Opening browser to sign in…\n');
  child.stdout.emit('data', 'If the browser didn\'t open, visit: https://claude.com/cai/oauth/authorize?code=true&state=abc\nPaste code here if prompted > ');
};

/** Lets `logout()` get past its await on the executable before the child is driven. */
const settleSpawn = () => new Promise((resolve) => { setImmediate(resolve); });

const createService = ({ signedIn = true, spawnFn } = {}) => {
  const state = { signedIn };
  const children = [];
  const spawned = spawnFn || ((command, args) => {
    const child = createChild();
    children.push({ command, args, child });
    return child;
  });
  const service = createClaudeAccountService({
    env: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-must-not-leak' },
    platform: 'linux',
    spawnFn: spawned,
    spawnSyncFn: createSpawnSync(state),
    resolveExecutable: async () => '/home/test/.local/bin/claude',
  });
  return { service, state, children };
};

describe('claude account service', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('reports the account the CLI is signed in as', () => {
    const { service } = createService();
    expect(service.readAccount()).toEqual({
      loggedIn: true,
      reason: 'logged-in',
      account: expect.objectContaining({ email: 'me@example.com', subscriptionType: 'max' }),
    });
  });

  it('signs in through the CLI, showing the URL it prints and never the API key', async () => {
    const { service, children } = createService({ signedIn: false });

    const started = await service.startLogin({ mode: 'claudeai' });
    const spawned = children[0];
    expect(spawned.command).toBe('/home/test/.local/bin/claude');
    expect(spawned.args).toEqual(['auth', 'login', '--claudeai']);
    expect(spawned.child.stdin.writable).toBe(true);

    handoffToChild(spawned.child);
    const flow = service.getFlow(started.id);
    expect(flow.status).toBe('waiting-code');
    expect(flow.url).toBe('https://claude.com/cai/oauth/authorize?code=true&state=abc');
    expect(flow.messages).toEqual(['Opening browser to sign in…']);
    expect(flow.messages.join()).not.toContain('Paste code here');

    const result = service.submitCode(flow.id, 'the-code');
    expect(result.flow.status).toBe('exchanging');
    expect(spawned.child.stdin.writes).toEqual(['the-code\n']);
  });

  it('runs the console (API billing) flow when asked', async () => {
    const { service, children } = createService({ signedIn: false });
    await service.startLogin({ mode: 'console' });
    expect(children[0].args).toEqual(['auth', 'login', '--console']);
  });

  it('settles as signed in with the account the CLI reports once the exchange ends', async () => {
    const { service, children, state } = createService({ signedIn: false });
    const started = await service.startLogin({});
    const { child } = children[0];
    handoffToChild(child);
    service.submitCode(started.id, 'the-code');
    state.signedIn = true;
    child.emit('close', 0);

    const flow = service.getFlow(started.id);
    expect(flow.status).toBe('signed-in');
    expect(flow.account).toEqual(expect.objectContaining({ email: 'me@example.com' }));
    expect(service.readAccount().loggedIn).toBe(true);
  });

  it('keeps the flow open after a wrong code and reports what the CLI said', async () => {
    const { service, children } = createService({ signedIn: false });
    const started = await service.startLogin({});
    const { child } = children[0];
    handoffToChild(child);
    service.submitCode(started.id, 'wrong');

    child.stdout.emit('data', 'Invalid code. Please make sure the full code was copied.\n');
    const waiting = service.getFlow(started.id);
    expect(waiting.status).toBe('waiting-code');
    expect(waiting.messages.at(-1)).toBe('Invalid code. Please make sure the full code was copied.');

    // The prompt is still open, so the user can paste the real one.
    const second = service.submitCode(started.id, 'right');
    expect(children[0].child.stdin.writes).toEqual(['wrong\n', 'right\n']);
    expect(second.flow.status).toBe('exchanging');
  });

  it('fails with the CLI\'s own reason when the exchange ends logged out', async () => {
    const { service, children } = createService({ signedIn: false });
    const started = await service.startLogin({});
    const { child } = children[0];
    handoffToChild(child);
    service.submitCode(started.id, 'nope');
    child.stderr.emit('data', 'Login failed: code expired.\n');
    child.emit('close', 1);

    const flow = service.getFlow(started.id);
    expect(flow.status).toBe('failed');
    expect(flow.error).toBe('Login failed: code expired.');
  });

  it('reads a sign-in that completed in the browser as signed in, and a walk-away as cancelled', async () => {
    const signedIn = createService({ signedIn: true });
    const first = await signedIn.service.startLogin({});
    const { child } = signedIn.children[0];
    handoffToChild(child);
    child.emit('close', 0);
    expect(signedIn.service.getFlow(first.id).status).toBe('signed-in');

    const walkedAway = createService({ signedIn: false });
    const second = await walkedAway.service.startLogin({});
    walkedAway.children[0].child.emit('close', 0);
    expect(walkedAway.service.getFlow(second.id).status).toBe('cancelled');
  });

  it('joins the sign-in already running instead of starting a second child', async () => {
    const { service, children } = createService({ signedIn: false });
    const first = await service.startLogin({});
    handoffToChild(children[0].child);
    const second = await service.startLogin({ mode: 'console' });

    expect(second.id).toBe(first.id);
    expect(children).toHaveLength(1);
    expect(service.activeFlow()?.id).toBe(first.id);
  });

  it('refuses a code that is not one token, and a closed flow', async () => {
    const { service, children } = createService({ signedIn: false });
    const started = await service.startLogin({});
    handoffToChild(children[0].child);

    expect(service.submitCode(started.id, 'two words').error).toBe('invalid-code');
    expect(service.submitCode(started.id, 'x\ny').error).toBe('invalid-code');
    expect(service.submitCode(started.id, '').error).toBe('invalid-code');
    expect(service.submitCode(started.id, undefined).error).toBe('invalid-code');
    expect(service.submitCode('clf_nope', 'x').error).toBe('not-found');
    expect(children[0].child.stdin.writes).toEqual([]);

    expect(service.cancelFlow(started.id).status).toBe('cancelled');
    expect(children[0].child.kill).toHaveBeenCalled();
    expect(service.submitCode(started.id, 'x').error).toBe('closed');
    expect(service.getFlow('clf_nope')).toBeNull();
    expect(service.cancelFlow('clf_nope')).toBeNull();
  });

  it('expires a sign-in nobody finishes', async () => {
    vi.useFakeTimers();
    const { service, children } = createService({ signedIn: false });
    const started = await service.startLogin({});
    handoffToChild(children[0].child);

    vi.advanceTimersByTime(10 * 60_000 + 1);
    expect(service.getFlow(started.id).status).toBe('expired');
    expect(children[0].child.kill).toHaveBeenCalled();
    // An expired flow takes no more codes.
    expect(service.submitCode(started.id, 'x').error).toBe('closed');
  });

  it('logs out through the CLI and reports what is left', async () => {
    const { service, children, state } = createService({ signedIn: true });
    const pending = service.logout();
    await settleSpawn();
    const logout = children[0];
    expect(logout.args).toEqual(['auth', 'logout']);
    state.signedIn = false;
    logout.child.emit('close', 0);

    expect(await pending).toMatchObject({ ok: true, connected: false, account: null });
    expect(service.readAccount().loggedIn).toBe(false);
  });

  it('reports a logout that failed while the CLI is still signed in', async () => {
    const { service, children } = createService({ signedIn: true });
    const pending = service.logout();
    await settleSpawn();
    const { child } = children[0];
    child.stderr.emit('data', 'logout exploded\n');
    child.emit('close', 1);

    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.error).toBe('logout exploded');
    expect(result.account).toEqual(expect.objectContaining({ email: 'me@example.com' }));
  });

  it('falls back to the CLI on PATH when the engine found no executable', async () => {
    const state = { signedIn: false };
    const children = [];
    const service = createClaudeAccountService({
      env: {},
      platform: 'linux',
      spawnFn: (command, args) => {
        const child = createChild();
        children.push({ command, args, child });
        return child;
      },
      spawnSyncFn: createSpawnSync(state),
      resolveExecutable: async () => { throw new Error('no engine'); },
    });

    await service.startLogin({});
    expect(children[0].command).toBe('claude');
  });

  it('fails the flow when the child cannot be spawned at all', async () => {
    const service = createClaudeAccountService({
      env: {},
      platform: 'linux',
      spawnFn: () => { throw new Error('spawn claude ENOENT'); },
      spawnSyncFn: createSpawnSync({ signedIn: false }),
      resolveExecutable: async () => null,
    });

    const flow = await service.startLogin({});
    expect(flow.status).toBe('failed');
    expect(flow.error).toBe('spawn claude ENOENT');
    expect(service.activeFlow()).toBeNull();
  });

  it('reports a spawn error event as a failed flow', async () => {
    const { service, children } = createService({ signedIn: false });
    const started = await service.startLogin({});
    children[0].child.emit('error', new Error('EACCES'));
    expect(service.getFlow(started.id).status).toBe('failed');
    expect(service.getFlow(started.id).error).toBe('EACCES');
  });
});

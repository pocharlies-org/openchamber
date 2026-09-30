/**
 * The Claude Code account OpenChamber's sessions run as, and how to change it.
 *
 * A Claude session is a Claude Code process, so the account is the CLI's, never
 * OpenChamber's: it is read with `claude auth status` and changed with
 * `claude auth login`. `/login` cannot be typed into a session — the Agent SDK
 * answers "isn't available in this environment" — so signing in or switching
 * account happens here, out of band, while the CLI performs the exchange.
 *
 * `claude auth login` prints the URL to open and waits for the code the sign-in
 * page hands back. OpenChamber shows that URL, forwards whatever the user pastes
 * to the child's stdin, and reports what the child says. The OAuth exchange is
 * deliberately not reimplemented: the code challenge is the CLI's, and a copy of
 * it would break the day the CLI changes one.
 *
 * One login runs at a time. Two children writing credentials over each other is
 * how an account ends up half-switched, so a second request joins the flow that
 * is already running instead of starting another.
 *
 * @module claude/account
 */

import { spawn as nodeSpawn } from 'node:child_process';

import { claudeCliChildEnv, getClaudeCliAuthStatus } from '../opencode/claude-cli-auth.js';

/** A sign-in nobody finishes is a hung child, not a pending flow. */
const LOGIN_TTL_MS = 10 * 60_000;

/** `claude auth logout` is a quick one-shot; it should not hang a request. */
const LOGOUT_TIMEOUT_MS = 20_000;

const MESSAGE_LIMIT = 12;

/** The code the sign-in page hands back is one long token: no spaces, no newline. */
const CODE_PATTERN = /^[!-~]{1,4000}$/;

/** Anything still running. A terminal status never goes back. */
const ACTIVE_STATUSES = new Set(['starting', 'waiting-code', 'exchanging']);

/** `claude auth login` signs into a subscription by default; `--console` bills API use. */
const MODES = new Set(['claudeai', 'console']);

/** The CLI paints its prompt with ANSI colours; the messages shown are plain text. */
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

const URL_PATTERN = /https?:\/\/\S+/;

/** What the CLI prints last and never terminates: it then waits on stdin. */
const PROMPT_MARKER = 'Paste code here if prompted';

const isTerminal = (status) => !ACTIVE_STATUSES.has(status);

/**
 * @param {object} dependencies
 * @param {() => Promise<string|null>} [dependencies.resolveExecutable] the CLI the
 *   sessions themselves run on, so the account signed into is the one they get.
 *   Falls back to `claude` on PATH when the engine found no executable.
 */
export const createClaudeAccountService = ({
  env = process.env,
  platform = process.platform,
  spawnFn = nodeSpawn,
  spawnSyncFn,
  resolveExecutable = async () => null,
  now = () => Date.now(),
} = {}) => {
  /** id → flow. Terminal flows are read until the UI stops polling, then swept. */
  const flows = new Map();

  const readStatus = () => getClaudeCliAuthStatus({
    ...(spawnSyncFn ? { spawnSyncFn } : {}),
    env,
    platform,
  });

  const publicFlow = (flow) => ({
    id: flow.id,
    mode: flow.mode,
    status: flow.status,
    url: flow.url,
    messages: [...flow.messages],
    error: flow.error,
    createdAt: flow.createdAt,
    expiresAt: flow.expiresAt,
    account: flow.account,
  });

  const settle = (flow, status, extra = {}) => {
    if (isTerminal(flow.status)) return;
    flow.status = status;
    Object.assign(flow, extra);
    if (flow.timer) {
      clearTimeout(flow.timer);
      flow.timer = null;
    }
  };

  const note = (flow, line) => {
    if (!line) return;
    flow.messages.push(line);
    if (flow.messages.length > MESSAGE_LIMIT) flow.messages.shift();
  };

  const stripAnsi = (value) => value.replace(ANSI_PATTERN, '');

  /** The CLI has said enough for the user to act on. */
  const markWaiting = (flow) => {
    if (flow.status === 'starting' || flow.status === 'exchanging') flow.status = 'waiting-code';
  };

  /**
   * The CLI writes the URL and the prompt to stdout, and its failures to either
   * stream. The prompt ends without a newline, so the CLI's next words — "an
   * invalid code", for instance — land on the same line: the marker is cut out
   * and whatever follows it is kept as the message. The URL line is dropped for
   * the same reason: the dialog renders that as its own link.
   */
  const absorb = (flow, chunk) => {
    flow.pending += stripAnsi(`${chunk}`);
    if (!flow.url) {
      const found = flow.pending.match(URL_PATTERN);
      if (found) flow.url = found[0];
    }
    const lines = flow.pending.split(/[\r\n]+/);
    flow.pending = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      const prompted = line.lastIndexOf(PROMPT_MARKER);
      if (prompted >= 0) {
        markWaiting(flow);
        const answer = line.slice(prompted + PROMPT_MARKER.length).replace(/^[\s>:—-]+/, '').trim();
        if (answer) note(flow, answer);
        continue;
      }
      if (flow.url && line.includes(flow.url)) {
        markWaiting(flow);
        continue;
      }
      // The child is still talking, so it is still asking: a wrong code costs a
      // retry, not a new sign-in page.
      markWaiting(flow);
      note(flow, line);
    }
  };

  const sweep = () => {
    const at = now();
    for (const [id, flow] of flows) {
      if (isTerminal(flow.status) && flow.settledAt && at - flow.settledAt > 60_000) flows.delete(id);
    }
  };

  const findActiveFlow = () => {
    for (const flow of flows.values()) {
      if (isTerminal(flow.status)) continue;
      return flow;
    }
    return null;
  };

  const kill = (flow) => {
    try {
      flow.child?.kill('SIGTERM');
    } catch {
      // Already gone: the exit handler owns the outcome.
    }
  };

  const startLogin = async ({ mode = 'claudeai' } = {}) => {
    sweep();
    const running = findActiveFlow();
    if (running) return publicFlow(running);

    const authMode = MODES.has(mode) ? mode : 'claudeai';
    const executable = await resolveExecutable().catch(() => null);

    const flow = {
      id: `clf_${now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      mode: authMode,
      status: 'starting',
      url: null,
      messages: [],
      pending: '',
      error: null,
      account: null,
      codes: 0,
      child: null,
      timer: null,
      createdAt: now(),
      expiresAt: now() + LOGIN_TTL_MS,
      settledAt: null,
    };
    flows.set(flow.id, flow);

    let child;
    try {
      child = spawnFn(executable || 'claude', ['auth', 'login', authMode === 'console' ? '--console' : '--claudeai'], {
        env: claudeCliChildEnv(env),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      settle(flow, 'failed', {
        error: error?.message || 'Could not start the Claude sign-in',
        settledAt: now(),
      });
      return publicFlow(flow);
    }
    flow.child = child;

    child.stdout?.on('data', (chunk) => absorb(flow, chunk));
    child.stderr?.on('data', (chunk) => absorb(flow, chunk));
    child.on('error', (error) => {
      settle(flow, 'failed', {
        error: error?.message || 'Could not run the Claude sign-in',
        settledAt: now(),
      });
      flow.child = null;
    });
    child.on('close', (code) => {
      flow.child = null;
      if (isTerminal(flow.status)) return;
      if (flow.codes === 0) {
        // The child ended with nothing pasted: the user walked away, or the
        // browser flow completed on its own. Say which by asking the CLI.
        const after = readStatus();
        if (after.connected) {
          settle(flow, 'signed-in', { account: after.account, settledAt: now() });
          return;
        }
        settle(flow, 'cancelled', { settledAt: now() });
        return;
      }
      const after = readStatus();
      if (after.connected) {
        settle(flow, 'signed-in', { account: after.account, settledAt: now() });
        return;
      }
      settle(flow, 'failed', {
        error: flow.messages.at(-1) || (code === 0
          ? 'The sign-in finished but Claude Code is still not logged in'
          : `The sign-in ended with code ${code}`),
        settledAt: now(),
      });
    });

    flow.timer = setTimeout(() => {
      if (!isTerminal(flow.status)) {
        kill(flow);
        settle(flow, 'expired', { settledAt: now() });
      }
    }, LOGIN_TTL_MS);

    return publicFlow(flow);
  };

  const getFlow = (id) => {
    const flow = flows.get(id);
    return flow ? publicFlow(flow) : null;
  };

  /**
   * One code per call. The CLI re-prompts after an invalid one, so the flow
   * stays open and the user can try again without a new sign-in page.
   */
  const submitCode = (id, code) => {
    const flow = flows.get(id);
    if (!flow) return { error: 'not-found' };
    if (isTerminal(flow.status)) return { error: 'closed', flow: publicFlow(flow) };
    const value = `${code ?? ''}`.trim();
    if (!CODE_PATTERN.test(value)) return { error: 'invalid-code', flow: publicFlow(flow) };
    if (!flow.child?.stdin?.writable) return { error: 'closed', flow: publicFlow(flow) };
    flow.child.stdin.write(`${value}\n`);
    flow.codes += 1;
    flow.status = 'exchanging';
    return { flow: publicFlow(flow) };
  };

  const cancelFlow = (id) => {
    const flow = flows.get(id);
    if (!flow) return null;
    if (!isTerminal(flow.status)) {
      kill(flow);
      settle(flow, 'cancelled', { settledAt: now() });
    }
    return publicFlow(flow);
  };

  /**
   * Signing out is the CLI's own: it clears the credential the sessions read.
   * Running Claude sessions keep the token they already hold until their next
   * turn spawns a new process, which is why the dialog says so.
   */
  const logout = async () => {
    const executable = await resolveExecutable().catch(() => null);
    const result = await new Promise((resolve) => {
      let child;
      try {
        child = spawnFn(executable || 'claude', ['auth', 'logout'], {
          env: claudeCliChildEnv(env),
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (error) {
        resolve({ ok: false, message: error?.message || 'Could not run claude auth logout' });
        return;
      }
      let output = '';
      child.stdout?.on('data', (chunk) => { output += `${chunk}`; });
      child.stderr?.on('data', (chunk) => { output += `${chunk}`; });
      const timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
        resolve({ ok: false, message: 'claude auth logout did not finish' });
      }, LOGOUT_TIMEOUT_MS);
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ ok: false, message: error?.message || 'Could not run claude auth logout' });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const message = stripAnsi(output).trim().split(/[\r\n]+/).filter(Boolean).at(-1) || null;
        resolve(code === 0 ? { ok: true, message } : { ok: false, message: message || `claude auth logout ended with code ${code}` });
      });
    });

    const status = readStatus();
    if (!result.ok && status.connected) return { ok: false, error: result.message, account: status.account };
    // Logged out is the outcome the caller asked for even when the CLI grumbled
    // (nothing to log out of): report the account the CLI actually has.
    return { ok: true, error: null, account: status.account, connected: status.connected };
  };

  return {
    readAccount: () => {
      const status = readStatus();
      return { loggedIn: status.connected, account: status.account, reason: status.reason };
    },
    startLogin,
    /** The sign-in in flight, if any: a reloaded dialog rejoins it instead of starting a second. */
    activeFlow: () => {
      const flow = findActiveFlow();
      return flow ? publicFlow(flow) : null;
    },
    getFlow,
    submitCode,
    cancelFlow,
    logout,
  };
};

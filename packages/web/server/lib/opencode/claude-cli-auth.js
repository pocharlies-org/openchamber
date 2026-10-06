/**
 * Reading and changing the Claude Code account through the CLI.
 *
 * Claude Code owns its own credentials: OpenChamber never holds an Anthropic
 * token of its own for a Claude session, it asks the CLI. `auth status --json`
 * is the authoritative answer (who is signed in, on which plan), and
 * `auth login` / `auth logout` are the only ways to change it — the OAuth
 * exchange, including the code challenge, stays inside the CLI.
 *
 * The child environment drops every API-key variable first. With one set, the
 * CLI authenticates with it and reports that instead of the claude.ai account,
 * so a status read would answer about a credential the sessions are not using
 * and a login would sign in over a key that keeps winning.
 *
 * @module opencode/claude-cli-auth
 */

import { spawnSync } from 'node:child_process';

/** Variables that make the CLI ignore the claude.ai account. */
const API_KEY_ENVIRONMENT = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];

/** The environment a Claude CLI auth call runs with. */
export const claudeCliChildEnv = (env = process.env) => {
  const childEnv = { ...env };
  for (const name of API_KEY_ENVIRONMENT) delete childEnv[name];
  return childEnv;
};

const readStatus = (spawnSyncFn, command, env) => spawnSyncFn(command, ['auth', 'status', '--json'], {
  encoding: 'utf8',
  timeout: 6000,
  env,
  windowsHide: true,
});

const resolveFromLoginShell = (spawnSyncFn, env, platform) => {
  if (platform === 'win32') {
    const result = spawnSyncFn('where', ['claude'], {
      encoding: 'utf8',
      timeout: 6000,
      env,
      windowsHide: true,
    });
    return `${result.stdout || ''}`.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null;
  }

  const shell = env.SHELL || '/bin/zsh';
  const result = spawnSyncFn(shell, ['-lic', 'command -v claude'], {
    encoding: 'utf8',
    timeout: 6000,
    env,
    windowsHide: true,
  });
  return `${result.stdout || ''}`.trim().split(/\s+/).pop() || null;
};

/**
 * The account's identity as the CLI reports it. `email` and `orgName` are
 * absent for an API-key sign-in, so an account can be known by its method alone.
 */
const toAccount = (payload) => ({
  authMethod: typeof payload.authMethod === 'string' ? payload.authMethod : null,
  email: typeof payload.email === 'string' && payload.email.trim() ? payload.email.trim() : null,
  orgName: typeof payload.orgName === 'string' && payload.orgName.trim() ? payload.orgName.trim() : null,
  subscriptionType: typeof payload.subscriptionType === 'string' && payload.subscriptionType.trim()
    ? payload.subscriptionType.trim()
    : null,
  configDirectory: typeof payload.configDirectory === 'string' ? payload.configDirectory : null,
});

/**
 * What Claude Code says about its own login. `connected` stays the answer the
 * provider-source route asks for; `account` is the same read, undiscarded, for
 * the surfaces that show or change who is signed in.
 */
export const getClaudeCliAuthStatus = ({
  spawnSyncFn = spawnSync,
  env = process.env,
  platform = process.platform,
} = {}) => {
  const childEnv = claudeCliChildEnv(env);

  try {
    let result = readStatus(spawnSyncFn, 'claude', childEnv);
    if (!`${result.stdout || ''}`.trim() && result.error) {
      const resolved = resolveFromLoginShell(spawnSyncFn, childEnv, platform);
      if (resolved) result = readStatus(spawnSyncFn, resolved, childEnv);
    }
    const output = `${result.stdout || ''}`.trim();
    if (!output) return { connected: false, reason: 'empty-status', account: null };
    const payload = JSON.parse(output);
    const connected = payload?.loggedIn === true;
    return {
      connected,
      reason: connected ? 'logged-in' : 'logged-out',
      account: connected ? toAccount(payload) : null,
    };
  } catch (error) {
    return {
      connected: false,
      reason: error instanceof Error ? error.message : String(error),
      account: null,
    };
  }
};

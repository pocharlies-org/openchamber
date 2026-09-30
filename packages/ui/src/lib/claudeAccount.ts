import { runtimeFetch } from '@/lib/runtime-fetch';

/**
 * The Claude Code account OpenChamber's Claude sessions run as, and the sign-in
 * that changes it (`GET/POST /api/claude/account*`). Claude Code owns the
 * credential: what is read here is the CLI's own answer, and switching account
 * is the CLI's OAuth flow with OpenChamber relaying its URL and the code the
 * browser hands back. `/login` typed into a Claude session is not that flow —
 * the Agent SDK refuses it — which is why the composer opens this instead.
 */
export type ClaudeAccount = {
  authMethod: string | null;
  email: string | null;
  orgName: string | null;
  subscriptionType: string | null;
  configDirectory: string | null;
};

export type ClaudeLoginMode = 'claudeai' | 'console';

/**
 * `starting` → `waiting-code` (URL shown, code can be pasted) → `exchanging`
 * (a code went in; a wrong one returns the flow to `waiting-code`) → terminal.
 */
export type ClaudeLoginStatus =
  | 'starting'
  | 'waiting-code'
  | 'exchanging'
  | 'signed-in'
  | 'failed'
  | 'cancelled'
  | 'expired';

export type ClaudeLoginFlow = {
  id: string;
  mode: ClaudeLoginMode;
  status: ClaudeLoginStatus;
  url: string | null;
  messages: string[];
  error: string | null;
  createdAt: number;
  expiresAt: number;
  /** The account reached when the flow ended, for `signed-in`. */
  account: ClaudeAccount | null;
};

type ClaudeAccountState = {
  loggedIn: boolean;
  account: ClaudeAccount | null;
  reason: string;
  /** A sign-in already running, so a reopened dialog rejoins it. */
  flow: ClaudeLoginFlow | null;
};

type ClaudeAccountResult<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * How often the dialog asks the server what the CLI's sign-in reached. The CLI
 * owns the exchange and reports nothing to us until it ends, so this is a poll,
 * not a stream — the same shape the GitHub device flow uses.
 */
export const CLAUDE_LOGIN_POLL_MS = 1500;

const ACTIVE_STATUSES: readonly ClaudeLoginStatus[] = ['starting', 'waiting-code', 'exchanging'];

export const isClaudeLoginActive = (status: ClaudeLoginStatus | undefined): boolean =>
  !!status && ACTIVE_STATUSES.includes(status);

/**
 * One request shape for all of them: the server answers errors as OpenCode 2
 * tagged bodies, whose `message` is what the user should read — never a generic
 * "it failed" over a reason the CLI already gave.
 */
const request = async <T>(path: string, init?: RequestInit): Promise<ClaudeAccountResult<T>> => {
  try {
    const response = await runtimeFetch(path, init);
    const payload = await response.json().catch(() => null) as ({ message?: string } & T) | null;
    if (!response.ok) {
      return { ok: false, error: payload?.message || `Claude account request failed (${response.status})` };
    }
    return { ok: true, data: payload as T };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const fetchClaudeAccount = (): Promise<ClaudeAccountResult<ClaudeAccountState>> =>
  request<ClaudeAccountState>('/api/claude/account');

export const startClaudeLogin = (mode: ClaudeLoginMode): Promise<ClaudeAccountResult<{ flow: ClaudeLoginFlow }>> =>
  request<{ flow: ClaudeLoginFlow }>('/api/claude/account/login', json({ mode }));

export const fetchClaudeLogin = (id: string): Promise<ClaudeAccountResult<{ flow: ClaudeLoginFlow }>> =>
  request<{ flow: ClaudeLoginFlow }>(`/api/claude/account/login/${encodeURIComponent(id)}`);

export const submitClaudeLoginCode = (id: string, code: string): Promise<ClaudeAccountResult<{ flow: ClaudeLoginFlow }>> =>
  request<{ flow: ClaudeLoginFlow }>(`/api/claude/account/login/${encodeURIComponent(id)}/code`, json({ code }));

export const cancelClaudeLogin = (id: string): Promise<ClaudeAccountResult<{ flow: ClaudeLoginFlow }>> =>
  request<{ flow: ClaudeLoginFlow }>(`/api/claude/account/login/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const signOutClaude = (): Promise<ClaudeAccountResult<{ loggedIn: boolean; account: ClaudeAccount | null }>> =>
  request<{ loggedIn: boolean; account: ClaudeAccount | null }>('/api/claude/account/logout', json({}));

/**
 * How to name an account in one line: the email when the CLI reports one, the
 * sign-in method when it does not (an API key has no email to show).
 */
export const describeClaudeAccount = (account: ClaudeAccount | null): string | null => {
  if (!account) return null;
  const who = account.email || account.orgName;
  if (!who) return account.authMethod || null;
  return account.subscriptionType ? `${who} · ${account.subscriptionType}` : who;
};

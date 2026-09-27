/**
 * Which session system owns a session, and what the UI may say and do about it.
 *
 * OpenChamber runs two session systems side by side: OpenCode (the native one)
 * and Claude Code (server/lib/claude). They answer the same wire protocol, so
 * most of the UI never needs to ask. Where it does — which model picker, which
 * error copy, which status report — it asks HERE, and never sniffs ids,
 * provider names or labels on its own.
 *
 * The engine is DECLARED by the server that owns the session:
 * `metadata.backend` (server/lib/claude/v2-wire.js `toV2Session` sets
 * `'claude'`). The id prefix (`ses_ccc…`, `ses_ccs…` for its subagents) is only
 * a fallback for a session the client knows by id alone — a URL, a draft, a
 * record not yet synced — and a declared backend always wins over it.
 */

export type SessionEngine = 'opencode' | 'claude';

export const SESSION_ENGINES: readonly SessionEngine[] = ['opencode', 'claude'];

/** What an engine can do, for the parts of the UI that differ between them. */
export type SessionEngineInfo = {
  id: SessionEngine;
  /** Product name, as the user knows it. Never translated. */
  label: string;
  /** OpenCode's status report (process, providers, recent errors) applies. */
  hasOpenCodeStatus: boolean;
  /** Models come from the engine's own catalog, not OpenCode's providers. */
  ownModelCatalog: boolean;
  /**
   * How long a prompt may sit unanswered on an idle session before the UI calls
   * it a reply that never began. A Claude turn spawns (or resumes) a CLI
   * process before its first line, which takes longer than OpenCode's.
   */
  unansweredAfterMs: number;
};

export const SESSION_ENGINE_INFO = {
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    hasOpenCodeStatus: true,
    ownModelCatalog: false,
    unansweredAfterMs: 5_000,
  },
  claude: {
    id: 'claude',
    label: 'Claude Code',
    hasOpenCodeStatus: false,
    ownModelCatalog: true,
    unansweredAfterMs: 30_000,
  },
} as const satisfies Record<SessionEngine, SessionEngineInfo>;

const CLAUDE_ID_PREFIXES = ['ses_ccc', 'ses_ccs'] as const;

type SessionLike = { id?: string | null; metadata?: unknown } | null | undefined;

const declaredBackend = (session: SessionLike): SessionEngine | null => {
  const metadata = session?.metadata;
  if (!metadata || typeof metadata !== 'object') return null;
  const backend = (metadata as { backend?: unknown }).backend;
  return backend === 'claude' || backend === 'opencode' ? backend : null;
};

export const isClaudeSessionId = (id: string | null | undefined): boolean =>
  typeof id === 'string' && CLAUDE_ID_PREFIXES.some((prefix) => id.startsWith(prefix));

export const resolveSessionEngine = (session: SessionLike): SessionEngine =>
  declaredBackend(session) ?? (isClaudeSessionId(session?.id) ? 'claude' : 'opencode');

export const getSessionEngineInfo = (session: SessionLike): SessionEngineInfo =>
  SESSION_ENGINE_INFO[resolveSessionEngine(session)];

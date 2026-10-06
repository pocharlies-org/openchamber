/**
 * Which session system owns a session, and what the UI may say and do about it.
 *
 * OpenChamber runs two session systems side by side: OpenCode (the native one)
 * and Claude Code (server/lib/claude). They answer the same wire protocol, so
 * most of the UI never needs to ask. Where it does — which model picker, which
 * error copy, whether to offer fork, revert, shell or compaction — it asks
 * HERE, and never sniffs ids, provider names or labels on its own.
 *
 * The engine is DECLARED by the server that owns the session:
 * `metadata.backend` (server/lib/claude/v2-wire.js `toV2Session` sets
 * `'claude'`). The id prefix (`ses_ccc…`, `ses_ccs…` for its subagents) is only
 * a fallback for a session the client knows by id alone — a URL, a draft, a
 * record not yet synced — and a declared backend always wins over it.
 *
 * What each engine can do is declared by the server too (`GET /api/engines`,
 * server/lib/engines/engines.js), loaded per runtime by `useEngineStore`.
 * The table below is the fallback until that answer arrives, and mirrors it.
 */

export type SessionEngine = 'opencode' | 'claude';

/** Every boolean operation a session can be asked for (server ENGINE_OPERATIONS). */
export type EngineOperation =
  | 'prompt'
  | 'interrupt'
  | 'rename'
  | 'delete'
  | 'archive'
  | 'synthetic'
  | 'fork'
  | 'forkAtMessage'
  | 'compact'
  | 'shell'
  | 'revert'
  | 'move'
  | 'generate'
  | 'diff'
  | 'permissions'
  | 'forms'
  | 'metadata'
  | 'goals';

const ENGINE_OPERATIONS: readonly EngineOperation[] = [
  'prompt', 'interrupt', 'rename', 'delete', 'archive', 'synthetic', 'fork', 'forkAtMessage', 'compact',
  'shell', 'revert', 'move', 'generate', 'diff', 'permissions', 'forms', 'metadata', 'goals',
];

export type EngineCapabilities = Record<EngineOperation, boolean> & {
  /** `providers`: OpenCode's provider catalog; `catalog`: the engine's own (`/api/claude/models`). */
  models: 'providers' | 'catalog';
  /** `agents`: OpenCode agents; `modes`: the engine's permission modes. */
  agents: 'agents' | 'modes';
  /** `server`: OpenCode runs command templates; `prompt`: sent as `/name args`, the engine expands it. */
  commands: 'server' | 'prompt';
};

/** What an engine is and can do, for the parts of the UI that differ between them. */
export type SessionEngineInfo = {
  id: SessionEngine;
  /** Product name, as the user knows it. Never translated. */
  label: string;
  /** Served by this runtime right now (`false` when its backend is off or did not load). */
  available: boolean;
  capabilities: EngineCapabilities;
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

const everything = Object.fromEntries(ENGINE_OPERATIONS.map((operation) => [operation, true])) as Record<EngineOperation, boolean>;

const OPENCODE_CAPABILITIES: EngineCapabilities = {
  ...everything,
  models: 'providers',
  agents: 'agents',
  commands: 'server',
};

const CLAUDE_CAPABILITIES: EngineCapabilities = {
  ...everything,
  shell: false,
  revert: false,
  move: false,
  generate: false,
  diff: false,
  goals: false,
  models: 'catalog',
  agents: 'modes',
  commands: 'prompt',
};

const withDerived = (info: Omit<SessionEngineInfo, 'ownModelCatalog'>): SessionEngineInfo => ({
  ...info,
  ownModelCatalog: info.capabilities.models === 'catalog',
});

export const SESSION_ENGINE_INFO: Record<SessionEngine, SessionEngineInfo> = {
  opencode: withDerived({
    id: 'opencode',
    label: 'OpenCode',
    available: true,
    capabilities: OPENCODE_CAPABILITIES,
    hasOpenCodeStatus: true,
    unansweredAfterMs: 5_000,
  }),
  claude: withDerived({
    id: 'claude',
    label: 'Claude Code',
    available: true,
    capabilities: CLAUDE_CAPABILITIES,
    hasOpenCodeStatus: false,
    unansweredAfterMs: 30_000,
  }),
};

const CLAUDE_ID_PREFIXES = ['ses_ccc', 'ses_ccs'] as const;

type SessionLike = { id?: string | null; metadata?: unknown } | null | undefined;

const declaredBackend = (session: SessionLike): SessionEngine | null => {
  const metadata = session?.metadata;
  if (!metadata || typeof metadata !== 'object') return null;
  const backend = (metadata as { backend?: unknown }).backend;
  return backend === 'claude' || backend === 'opencode' ? backend : null;
};

export const isSessionEngine = (value: unknown): value is SessionEngine =>
  value === 'opencode' || value === 'claude';

const isClaudeSessionId = (id: string | null | undefined): boolean =>
  typeof id === 'string' && CLAUDE_ID_PREFIXES.some((prefix) => id.startsWith(prefix));

export const resolveSessionEngine = (session: SessionLike): SessionEngine =>
  declaredBackend(session) ?? (isClaudeSessionId(session?.id) ? 'claude' : 'opencode');

export const getSessionEngineInfo = (session: SessionLike): SessionEngineInfo =>
  SESSION_ENGINE_INFO[resolveSessionEngine(session)];

/**
 * An engine's info with what the server declared laid over the fallback.
 * Unknown keys and wrong types in the answer are ignored, never trusted: an
 * older server that does not know an operation keeps the fallback for it.
 */
export const mergeDeclaredEngine = (fallback: SessionEngineInfo, declared: unknown): SessionEngineInfo => {
  if (!declared || typeof declared !== 'object') return fallback;
  const record = declared as { label?: unknown; available?: unknown; capabilities?: unknown };
  const capabilities: EngineCapabilities = { ...fallback.capabilities };
  if (record.capabilities && typeof record.capabilities === 'object') {
    const incoming = record.capabilities as Record<string, unknown>;
    for (const operation of ENGINE_OPERATIONS) {
      if (typeof incoming[operation] === 'boolean') capabilities[operation] = incoming[operation] as boolean;
    }
    if (incoming.models === 'providers' || incoming.models === 'catalog') capabilities.models = incoming.models;
    if (incoming.agents === 'agents' || incoming.agents === 'modes') capabilities.agents = incoming.agents;
    if (incoming.commands === 'server' || incoming.commands === 'prompt') capabilities.commands = incoming.commands;
  }
  return withDerived({
    ...fallback,
    label: typeof record.label === 'string' && record.label.trim() ? record.label : fallback.label,
    available: typeof record.available === 'boolean' ? record.available : fallback.available,
    capabilities,
  });
};

/**
 * An operation the session's engine does not have, refused before it leaves
 * the client. The UI hides such affordances; this is the backstop for a path
 * that still reaches one (a stale view, a keyboard shortcut).
 */
export class EngineUnsupportedError extends Error {
  readonly engine: SessionEngine;
  readonly operation: EngineOperation;

  constructor(engine: SessionEngineInfo, operation: EngineOperation) {
    super(`${engine.label} sessions do not support ${operation}`);
    this.name = 'EngineUnsupportedError';
    this.engine = engine.id;
    this.operation = operation;
  }
}

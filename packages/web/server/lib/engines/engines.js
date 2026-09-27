/**
 * The session engines OpenChamber serves side by side, and what each can do.
 *
 * OpenCode is the native engine; Claude Code (lib/claude) answers the same
 * `/api/session*` surface for its own ids. The UI never guesses what an
 * engine supports: it reads this declaration (`GET /api/engines`) and hides
 * what the session's engine cannot do. A call that still reaches an engine
 * for an operation it does not have is answered with a typed
 * `UnsupportedOperationError` naming the engine and the operation — never
 * forwarded to the other engine, which would report "session not found".
 *
 * Capabilities are wire operations, one per `/api/session/:id/<op>` route
 * family, plus how the engine chooses models and agents:
 *
 *   models: 'providers' — OpenCode's provider catalog
 *           'catalog'   — the engine's own list (`/api/claude/models`)
 *   agents: 'agents'    — OpenCode agents
 *           'modes'     — the engine's permission modes
 *   commands: 'server'  — OpenCode runs the command template
 *             'prompt'  — the command is sent as `/name args` and the engine
 *                         interprets it (Claude Code's slash commands)
 */

/** Every boolean operation a session can be asked for. */
export const ENGINE_OPERATIONS = Object.freeze([
  'prompt',
  'interrupt',
  'rename',
  'delete',
  'archive',
  'synthetic',
  'fork',
  'forkAtMessage',
  'compact',
  'shell',
  'revert',
  'move',
  'generate',
  'diff',
  'permissions',
  'forms',
  'metadata',
  'goals',
]);

const ALL = Object.fromEntries(ENGINE_OPERATIONS.map((operation) => [operation, true]));

export const ENGINES = Object.freeze({
  opencode: Object.freeze({
    id: 'opencode',
    label: 'OpenCode',
    capabilities: Object.freeze({
      ...ALL,
      models: 'providers',
      agents: 'agents',
      commands: 'server',
    }),
  }),
  claude: Object.freeze({
    id: 'claude',
    label: 'Claude Code',
    capabilities: Object.freeze({
      ...ALL,
      // Claude Code keeps the transcript in its own files, tied to the
      // directory it runs in: nothing to stage a revert on, no shell recorded
      // in the transcript, no move between directories, no side generation.
      shell: false,
      revert: false,
      move: false,
      generate: false,
      // Turn diffs come from OpenCode's snapshots; Claude has none to diff.
      diff: false,
      // Permission and question prompts are Claude Code's own; OpenChamber has
      // no channel for them in a Claude session.
      permissions: false,
      forms: false,
      // OpenChamber's per-session state (pins, `/btw` links, the knowledge
      // cursor) is kept for it in OpenChamber's own store
      // (openchamber-sessions/engine-metadata-store.js). Goals are not: the
      // goal loop drives continuation prompts through OpenCode.
      metadata: true,
      goals: false,
      models: 'catalog',
      agents: 'modes',
      commands: 'prompt',
    }),
  }),
});

/**
 * The operation an `/api/session/:id/<rest>` path asks for, in the
 * vocabulary above: `revert/stage` → `revert`, `permission/…` → `permissions`.
 */
export const operationOfPath = (rest) => {
  const head = String(rest || '').replace(/^\/+/, '').split('/')[0] || '';
  switch (head) {
    case 'permission': return 'permissions';
    case 'form': return 'forms';
    case 'command': return 'commands';
    default: return head || 'unknown';
  }
};

/**
 * The typed refusal for an operation an engine does not have. 400 because
 * every OpenCode 2 SDK method declares it: an undeclared status reaches the
 * UI as an opaque transport error instead of this message.
 */
export const sendUnsupportedOperation = (res, engineId, operation) => {
  const engine = ENGINES[engineId];
  const label = engine?.label || engineId;
  res.status(400).json({
    _tag: 'UnsupportedOperationError',
    message: `${label} sessions do not support ${operation}`,
    engine: engineId,
    operation,
  });
};

/**
 * `GET /api/engines`: which engines this server runs and what each can do.
 * `available` is false for an engine that is configured off or whose backend
 * did not load (no Agent SDK, no `claude` executable).
 */
export const registerEnginesRoute = (app, { isClaudeEnabled = () => false, isClaudeAvailable = async () => false } = {}) => {
  app.get('/api/engines', async (_req, res) => {
    const claudeEnabled = isClaudeEnabled();
    let claudeAvailable = false;
    if (claudeEnabled) {
      try {
        claudeAvailable = Boolean(await isClaudeAvailable());
      } catch {
        claudeAvailable = false;
      }
    }
    res.json({
      engines: [
        { ...ENGINES.opencode, available: true },
        { ...ENGINES.claude, available: claudeEnabled && claudeAvailable },
      ],
    });
  });
};

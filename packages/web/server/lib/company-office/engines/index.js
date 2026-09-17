/**
 * Picks the engine a dispatch cycle runs on.
 *
 * The choice follows where the model lives, which is why it is configuration and
 * not a flag on a single implementation:
 *
 *   `opencode` — an OpenCode server already holds the model. The right engine
 *                for the local resident: a turn is a request, sessions are
 *                listable and archivable, and nothing is spawned per ticket.
 *   `claude`   — a real Claude Code session on the account's own subscription.
 *   `codex`    — a real Codex session on the account's own ChatGPT login.
 *
 * The two CLI engines exist so the work happens inside the clients those
 * subscriptions are actually sold for, instead of being re-published as a
 * generic API, and so every session the dispatcher starts stays openable by hand
 * afterwards with `claude --resume` or `codex exec resume`.
 */

import { createOpenCodeEngine } from './opencode.js';
import { createClaudeEngine } from './claude.js';
import { createCodexEngine } from './codex.js';

export const ENGINE_KINDS = Object.freeze(['opencode', 'claude', 'codex']);

const FACTORIES = {
  opencode: createOpenCodeEngine,
  claude: createClaudeEngine,
  codex: createCodexEngine,
};

export const createEngine = ({ kind = 'opencode', ...options } = {}) => {
  const factory = FACTORIES[kind];
  // An unknown engine must not quietly fall back to another one: dispatching a
  // ticket through the wrong runtime is not a degraded result, it is a different
  // account being charged and a session the operator will not find.
  if (!factory) {
    throw new Error(`Unknown company office engine "${kind}". Expected one of: ${ENGINE_KINDS.join(', ')}.`);
  }
  if (kind === 'opencode' && !options.buildOpenCodeUrl) {
    throw new Error('The opencode engine needs buildOpenCodeUrl.');
  }
  return factory(options);
};

export { createOpenCodeEngine, createClaudeEngine, createCodexEngine };

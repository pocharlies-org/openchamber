/**
 * Engine that works a ticket as a real Claude Code session.
 *
 * WHAT MAKES THIS ENGINE DIFFERENT
 * --------------------------------
 * Claude Code accepts `--session-id <uuid>`, so we choose the id instead of
 * discovering it. That single fact replaces the OpenCode claim mechanism:
 *
 *   OpenCode  : create a session, put the ticket in its TITLE, and later scan
 *               every session looking for that title.
 *   Claude    : derive the id from the ticket key. The ticket IS the id.
 *
 * The derived id is what the sync invariants call a deterministic authoritative
 * record. A crash between starting the turn and writing the Jira pointer cannot
 * orphan the work: the next cycle recomputes the same id and finds the same
 * session, with no scan to be stale and no title to be rewritten.
 *
 * The session lands in Claude's own store, so `claude --resume <id>` inside the
 * ticket's repository opens exactly what the dispatcher started. That is the
 * requirement this engine exists to satisfy -- the sessions must remain the
 * user's, openable by hand, not hidden inside a wrapper.
 */

import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createProcessRegistry, startTurn } from './cli-runtime.js';

/**
 * Environment that would take the turn off the subscription, removed before every
 * spawn.
 *
 * This is the counterpart to the Codex engine forcing its provider on every run.
 * Both engines exist to keep the work on the account's own login, and in both
 * cases the danger is ambient configuration nobody meant to apply: a base URL
 * exported for an unrelated tool silently reroutes these sessions through a
 * gateway, and an API key silently moves them onto metered billing. Neither
 * failure is visible in the transcript, so the guard cannot be "the host is
 * clean today".
 */
const OFF_SUBSCRIPTION = Object.freeze([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
]);

export const subscriptionEnv = (env, home) => {
  const clean = { ...env, CLAUDE_CONFIG_DIR: home };
  for (const key of OFF_SUBSCRIPTION) delete clean[key];
  return clean;
};

/**
 * Fixed namespace for ticket->session derivation.
 *
 * PERSISTED CONTRACT: changing this value renames every future session and
 * silently detaches every ticket already in flight from its history. It is a
 * migration, not a tweak.
 */
const TICKET_NAMESPACE = '6f1d2a54-7b3c-4e18-9a60-2c5f0b7d4e91';

const SESSION_FILE = /^(?<id>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** RFC 4122 v5 (SHA-1). Same ticket key, same id, on every host and forever. */
export const sessionIdForTicket = (ticketKey, namespace = TICKET_NAMESPACE) => {
  const namespaceBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1').update(namespaceBytes).update(ticketKey, 'utf8').digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/**
 * Every session id Claude has on disk.
 *
 * Deliberately keyed by id alone rather than by the project directory: the id is
 * globally unique, and the directory-name encoding is Claude's private business.
 * Guessing that encoding would put an unverified rule on the path that decides
 * whether a ticket gets a second session.
 */
const readSessionIds = async ({ home, readdirImpl }) => {
  const root = join(home, 'projects');
  const projects = await readdirImpl(root, { withFileTypes: true });
  const ids = new Set();
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    let entries;
    try {
      entries = await readdirImpl(join(root, project.name));
    } catch {
      // One unreadable project directory hides its own sessions. Failing the
      // whole scan here would report every other ticket as unclaimed and start
      // duplicates for all of them.
      continue;
    }
    for (const entry of entries) {
      const id = SESSION_FILE.exec(entry)?.groups?.id;
      if (id) ids.add(id.toLowerCase());
    }
  }
  return ids;
};

export const createClaudeEngine = ({
  command = 'claude',
  home = join(homedir(), '.claude'),
  model = null,
  permissionMode = 'acceptEdits',
  env = process.env,
  registry = createProcessRegistry(),
  readdirImpl = readdir,
  spawnImpl = undefined,
  startTimeoutMs = 120_000,
  now = () => Date.now(),
} = {}) => {
  const argv = (plan, sessionId, { resume }) => [
    '--print',
    plan.prompt,
    '--output-format', 'json',
    resume ? '--resume' : '--session-id', sessionId,
    ...(plan.model ?? model ? ['--model', plan.model ?? model] : []),
    // The role folder carries the boundary, including which mode it is in, so it
    // wins over any default. An absent role config falls back to the plain mode
    // rather than running the turn unrestricted.
    ...(plan.roleConfig
      ? ['--settings', plan.roleConfig.claudeSettingsPath]
      : (permissionMode ? ['--permission-mode', permissionMode] : [])),
    // The repository is the workspace; nothing outside it is in scope.
    '--add-dir', plan.directory,
  ];

  const run = async (plan, { resume }) => {
    const sessionId = sessionIdForTicket(plan.ticketKey);
    await startTurn({
      command,
      args: argv(plan, sessionId, { resume }),
      cwd: plan.directory,
      env: subscriptionEnv(env, home),
      registry,
      presetSessionId: sessionId,
      spawnImpl,
      startTimeoutMs,
    });
    return sessionId;
  };

  return {
    kind: 'claude',

    /**
     * Which tickets already own a session.
     *
     * Answered per requested ticket, not by scanning for ticket markers: the id
     * is derivable, so the question is only ever "is this exact file there?".
     */
    async findSessionsByTicket(ticketKeys = []) {
      let known;
      try {
        known = await readSessionIds({ home, readdirImpl });
      } catch (error) {
        // Failure is not empty. Reporting "no sessions" here would start a
        // second session for every ticket already being worked.
        throw new Error(`Claude session scan failed: ${error.message}`);
      }
      const byTicket = new Map();
      for (const ticketKey of ticketKeys) {
        const sessionId = sessionIdForTicket(ticketKey);
        if (!known.has(sessionId)) continue;
        byTicket.set(ticketKey, { ticketKey, sessionId, agent: null, phase: null, startedAt: null });
      }
      // A derived id cannot collide across tickets, so duplicates are impossible
      // by construction rather than filtered after the fact.
      return { byTicket, duplicates: [], state: 'ready' };
    },

    async spawn(plan) {
      const sessionId = await run(plan, { resume: false });
      return { ticketKey: plan.ticketKey, sessionId, agent: plan.agent, startedAt: now() };
    },

    async adopt(plan, existing) {
      const sessionId = await run(plan, { resume: true });
      return {
        ticketKey: plan.ticketKey,
        sessionId: existing?.sessionId ?? sessionId,
        agent: plan.agent,
        startedAt: now(),
        reused: true,
      };
    },

    readStatuses: async () => registry.statuses(),
    abort: async (sessionId) => { await registry.abort(sessionId); },

    /**
     * Claude owns its transcripts and they are the deliverable of this design:
     * the operator must be able to open the ticket's session by hand. Deleting
     * or hiding them here would remove the only durable claim as well.
     */
    async archive() {
      return { archived: false, reason: 'claude_sessions_are_not_archivable' };
    },

    /** Subagents live inside the session file, not as sessions of their own. */
    descendantsOf: () => [],
  };
};

/**
 * Engine that works a ticket as a real Codex CLI session.
 *
 * TALKING TO CHATGPT, NOT TO A GATEWAY
 * ------------------------------------
 * `model_provider` is forced on every invocation and that is not a preference.
 * `~/.codex/config.toml` on the dispatch host is pinned to a LiteLLM provider,
 * and the `litellm-model-sync` plugin REWRITES it on every session start -- an
 * edit to that file is reverted before the next turn. Passing `-c` per run is
 * the only setting a plugin cannot take back, so it is what keeps these sessions
 * on the account's own OAuth instead of an in-cluster gateway.
 *
 * CLAIMING A TICKET WITHOUT BEING ABLE TO NAME THE SESSION
 * -------------------------------------------------------
 * Codex mints its own id and announces it on the first JSONL line, so the id
 * cannot be derived from the ticket the way the Claude engine derives it. The
 * durable claim is therefore the same shape OpenCode uses -- a marker that
 * travels with the work -- except it lives in the transcript instead of a title:
 * the ticket marker is prepended to the prompt, so the rollout Codex writes
 * carries the ticket from its first line, and the session id is already in the
 * rollout's filename.
 *
 * The rollout stays in `~/.codex/sessions`, which is what makes
 * `codex exec resume <id>` open the dispatcher's session by hand.
 */

import { readdir, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createProcessRegistry, startTurn } from './cli-runtime.js';

/** `rollout-<iso>-<session id>.jsonl` */
const ROLLOUT_FILE = /^rollout-.*?-(?<id>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const TICKET_MARKER = /\[(?<ticket>[A-Z][A-Z0-9_]*-\d+)\]/;

/** How much of a rollout is read looking for the marker. The prompt is first. */
const HEAD_BYTES = 64 * 1024;

export const ticketMarker = (ticketKey) => `[${ticketKey}]`;

const rolloutDirectories = async ({ root, readdirImpl, lookbackDays, now }) => {
  const wanted = new Set();
  for (let back = 0; back < lookbackDays; back += 1) {
    const day = new Date(now() - back * 86_400_000);
    wanted.add([
      String(day.getUTCFullYear()),
      String(day.getUTCMonth() + 1).padStart(2, '0'),
      String(day.getUTCDate()).padStart(2, '0'),
    ].join('/'));
  }

  const found = [];
  for (const relative of wanted) {
    const directory = join(root, ...relative.split('/'));
    try {
      for (const entry of await readdirImpl(directory)) {
        const id = ROLLOUT_FILE.exec(entry)?.groups?.id;
        if (id) found.push({ sessionId: id.toLowerCase(), path: join(directory, entry) });
      }
    } catch {
      // A day with no sessions is a missing directory, not a failure.
    }
  }
  return found;
};

const readHead = async (path, openImpl) => {
  const handle = await openImpl(path, 'r');
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
};

export const createCodexEngine = ({
  command = 'codex',
  home = join(homedir(), '.codex'),
  model = null,
  /**
   * The built-in provider that carries the ChatGPT OAuth session. Overriding it
   * per run is what keeps this engine off the LiteLLM bridge; see the header.
   */
  modelProvider = 'openai',
  env = process.env,
  registry = createProcessRegistry(),
  readdirImpl = readdir,
  openImpl = open,
  spawnImpl = undefined,
  startTimeoutMs = 120_000,
  lookbackDays = 14,
  now = () => Date.now(),
} = {}) => {
  const root = join(home, 'sessions');

  const baseArgs = (plan) => [
    '-c', `model_provider=${modelProvider}`,
    // The role's sandbox and approval policy, read out of its mode folder. They
    // follow the provider override so a role can never widen it back.
    ...(plan.roleConfig?.codexOverrides ?? []).flatMap((override) => ['-c', override]),
    ...(plan.model ?? model ? ['-m', plan.model ?? model] : []),
    '--json',
  ];

  // The marker is what a later cycle finds; the prompt alone would not identify
  // the ticket once the summary changes.
  const markedPrompt = (plan) => `${ticketMarker(plan.ticketKey)} ${plan.title ?? ''}\n\n${plan.prompt}`.trim();

  const readSessionId = (event) => (
    event?.type === 'thread.started' && typeof event.thread_id === 'string' ? event.thread_id : null
  );

  const run = async (plan, { resumeFrom }) => {
    const args = resumeFrom
      ? ['exec', 'resume', resumeFrom, ...baseArgs(plan), markedPrompt(plan)]
      : ['exec', ...baseArgs(plan), markedPrompt(plan)];
    const { sessionId } = await startTurn({
      command,
      args,
      cwd: plan.directory,
      env: { ...env, CODEX_HOME: home },
      registry,
      readSessionId,
      spawnImpl,
      startTimeoutMs,
    });
    return sessionId;
  };

  return {
    kind: 'codex',

    /**
     * Which tickets already own a rollout.
     *
     * Bounded by `lookbackDays` and by reading only each rollout's head: the
     * store grows without limit (thousands of files) and a full read on every
     * dispatch cycle would cost more than the work it guards.
     */
    async findSessionsByTicket(ticketKeys = []) {
      const wanted = new Set(ticketKeys);
      let rollouts;
      try {
        rollouts = await rolloutDirectories({ root, readdirImpl, lookbackDays, now });
      } catch (error) {
        // Failure is not empty: an unreadable store must not present every
        // ticket as free and start a duplicate session for each one.
        throw new Error(`Codex session scan failed: ${error.message}`);
      }

      const byTicket = new Map();
      const duplicates = new Set();
      let complete = true;

      for (const rollout of rollouts) {
        let head;
        try {
          head = await readHead(rollout.path, openImpl);
        } catch {
          // One unreadable rollout may be the claim for a ticket we are about to
          // dispatch, so the scan is no longer complete enough to create.
          complete = false;
          continue;
        }
        const ticket = TICKET_MARKER.exec(head)?.groups?.ticket;
        if (!ticket || !wanted.has(ticket)) continue;

        const existing = byTicket.get(ticket);
        if (existing && existing.sessionId !== rollout.sessionId) {
          // Never pick one: resuming the wrong rollout grafts a ticket onto
          // somebody else's history.
          duplicates.add(ticket);
          continue;
        }
        byTicket.set(ticket, {
          ticketKey: ticket,
          sessionId: rollout.sessionId,
          agent: null,
          phase: null,
          startedAt: null,
        });
      }

      for (const ticket of duplicates) byTicket.delete(ticket);
      return {
        byTicket,
        duplicates: [...duplicates],
        state: complete && duplicates.size === 0 ? 'ready' : 'partial',
      };
    },

    async spawn(plan) {
      const sessionId = await run(plan, { resumeFrom: null });
      return { ticketKey: plan.ticketKey, sessionId, agent: plan.agent, startedAt: now() };
    },

    async adopt(plan, existing) {
      const sessionId = await run(plan, { resumeFrom: existing.sessionId });
      return {
        ticketKey: plan.ticketKey,
        sessionId: sessionId ?? existing.sessionId,
        agent: plan.agent,
        startedAt: now(),
        reused: true,
      };
    },

    readStatuses: async () => registry.statuses(),
    abort: async (sessionId) => { await registry.abort(sessionId); },

    /** The rollout is the claim and the operator's copy; it is never removed. */
    async archive() {
      return { archived: false, reason: 'codex_rollouts_are_not_archivable' };
    },

    descendantsOf: () => [],
  };
};

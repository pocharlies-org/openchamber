/**
 * Shared machinery for the engines that drive a real agent CLI as a child
 * process (`claude`, `codex`) instead of an OpenCode server.
 *
 * WHY THIS EXISTS AT ALL
 * ----------------------
 * The OpenCode engine talks to a server: `prompt_async` returns immediately, the
 * turn runs somewhere else, and `/session/status` answers "is it busy?". A CLI
 * has none of that. `claude -p` and `codex exec` run the whole turn inside a
 * child process and exit, so the only authority for "this ticket is working" is
 * the process itself.
 *
 * That difference is the reason this file is not a transport detail:
 *
 *   - LIVENESS is the child, not a remote status map. A registered child that is
 *     still running IS the busy state; there is nothing else to ask.
 *   - ABORT is a signal, not a request.
 *   - ARCHIVE does not exist. The session is a file in the CLI's own store, and
 *     keeping it is the point: it must stay visible to `claude --resume` and
 *     `codex exec resume`.
 *
 * THE ONE THING WE WAIT FOR
 * -------------------------
 * Dispatch must not block on a turn -- a ticket can think for minutes and the
 * cycle has other tickets to start. But the caller cannot be handed nothing
 * either: the session id is what links the ticket to its work, and losing it
 * strands a running child no supervisor can find or kill.
 *
 * So a start resolves at the FIRST moment the id is known and never later:
 * Claude is told which id to use, Codex announces one on its first JSONL line.
 * After that the child runs unattended under the registry.
 */

import { spawn } from 'node:child_process';

/** A start that produced no session id is a failure, however the process ends. */
export class TurnStartError extends Error {
  constructor(message, { stderr = '', code = null } = {}) {
    super(message);
    this.name = 'TurnStartError';
    this.stderr = stderr;
    this.code = code;
  }
}

/**
 * Tracks the children a dispatcher started, keyed by the session they belong to.
 *
 * Liveness is read from the child, never from a cached boolean: a flag set at
 * spawn time and cleared on exit is exactly the "impossible state" the sync
 * invariants warn about, because a crash between the two leaves a ticket busy
 * forever and its slot never returns.
 */
export const createProcessRegistry = () => {
  const children = new Map();

  return {
    register(sessionId, child) {
      children.set(sessionId, child);
      const forget = () => {
        // Only drop the entry if it is still this child: a ticket resumed into a
        // second turn must not be erased by the first one's late exit.
        if (children.get(sessionId) === child) children.delete(sessionId);
      };
      child.once('exit', forget);
      child.once('error', forget);
    },

    /** Live children only. An unknown session is finished, not busy. */
    isBusy(sessionId) {
      const child = children.get(sessionId);
      return Boolean(child) && child.exitCode === null && child.signalCode === null;
    },

    /** `{ [sessionId]: { type: 'busy' } }`, shaped like the OpenCode status map. */
    statuses() {
      const map = {};
      for (const sessionId of children.keys()) {
        if (this.isBusy(sessionId)) map[sessionId] = { type: 'busy' };
      }
      return map;
    },

    /**
     * Ends a turn. SIGTERM first so the CLI can close its session file cleanly --
     * a half-written transcript is what makes a session unresumable, which would
     * defeat the reason these engines exist.
     */
    async abort(sessionId, { graceMs = 5_000 } = {}) {
      const child = children.get(sessionId);
      if (!child || !this.isBusy(sessionId)) return false;
      child.kill('SIGTERM');
      const died = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), graceMs);
        timer.unref?.();
        child.once('exit', () => { clearTimeout(timer); resolve(true); });
      });
      if (!died) child.kill('SIGKILL');
      return true;
    },

    size() {
      return children.size;
    },
  };
};

/** Splits a stream into whole lines, holding the trailing partial one back. */
const lineReader = (onLine) => {
  let buffer = '';
  return (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) onLine(line);
      index = buffer.indexOf('\n');
    }
  };
};

/**
 * Starts a turn and resolves as soon as its session id is known.
 *
 * `readSessionId` receives each stdout line already parsed as JSON (or the raw
 * string when it is not JSON) and returns the session id when it recognises it.
 * `presetSessionId` short-circuits that for CLIs we can tell which id to use.
 *
 * The returned promise settles once. The child outlives it on purpose.
 */
export const startTurn = ({
  command,
  args,
  cwd,
  env = process.env,
  registry,
  presetSessionId = null,
  readSessionId = () => null,
  spawnImpl = spawn,
  startTimeoutMs = 120_000,
  onExit = null,
}) => new Promise((resolve, reject) => {
  const child = spawnImpl(command, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let settled = false;
  let stderr = '';
  const claim = (sessionId) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    registry?.register(sessionId, child);
    resolve({ sessionId, child });
  };
  const fail = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    reject(error);
  };

  // A CLI that never announces an id would otherwise hold the cycle open for as
  // long as the turn runs, which for these agents is unbounded.
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    fail(new TurnStartError(`${command} produced no session id in ${startTimeoutMs}ms`, { stderr }));
  }, startTimeoutMs);
  timer.unref?.();

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4_000); });

  if (presetSessionId) {
    // Still attach the reader: the CLI may correct us, and a mismatch must win
    // over our assumption or the supervisor would track a session nobody wrote.
    child.stdout?.on('data', lineReader((line) => {
      let parsed = line;
      try { parsed = JSON.parse(line); } catch { /* plain text line */ }
      readSessionId(parsed);
    }));
    claim(presetSessionId);
  } else {
    child.stdout?.on('data', lineReader((line) => {
      if (settled) return;
      let parsed = line;
      try { parsed = JSON.parse(line); } catch { return; }
      const sessionId = readSessionId(parsed);
      if (sessionId) claim(sessionId);
    }));
  }

  child.once('error', (error) => fail(new TurnStartError(`${command} failed to start: ${error.message}`, { stderr })));
  child.once('exit', (code, signal) => {
    onExit?.({ code, signal, stderr });
    // Exiting before an id means the turn never began: report the CLI's own
    // stderr rather than a generic failure, because that text is the diagnosis.
    fail(new TurnStartError(
      `${command} exited (${signal ?? code}) before starting a session: ${stderr.trim().slice(-500) || 'no stderr'}`,
      { stderr, code },
    ));
  });
});

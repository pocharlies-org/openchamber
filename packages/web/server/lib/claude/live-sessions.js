/**
 * Which Claude Code sessions are live in a process OpenChamber does not own.
 *
 * Claude Code keeps its own registry of running sessions: one
 * `<config>/sessions/<pid>.json` per CLI process — terminal, VS Code, Claude
 * Desktop, a Remote Control server child, an SDK host. It carries the session
 * id, the process status (`busy`/`idle`), where it was started from and, when
 * the process is linked to claude.ai, its `bridgeSessionId`. That registry is
 * the authority on "someone else is writing this transcript"; a transcript's
 * mtime is not.
 *
 * An entry outlives a crashed process, and pids are reused, so an entry only
 * counts while its pid is alive AND started at the recorded `procStart`
 * (field 22 of /proc/<pid>/stat on Linux).
 */

import path from 'path';

const ENTRY_FILE = /^\d+\.json$/;

const readProcStart = async (fsPromises, pid) => {
  try {
    const stat = await fsPromises.readFile(`/proc/${pid}/stat`, 'utf8');
    // `comm` (field 2) is parenthesised and may contain spaces: count fields
    // from the closing parenthesis. Field 3 is the first one after it.
    const afterComm = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return afterComm[22 - 3] ?? null;
  } catch {
    return null;
  }
};

const isProcessAlive = (kill, pid) => {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: alive, owned by someone else.
    return error?.code === 'EPERM';
  }
};

const toOwner = (entry) => ({
  pid: entry.pid,
  sessionId: entry.sessionId,
  cwd: typeof entry.cwd === 'string' ? entry.cwd : '',
  entrypoint: typeof entry.entrypoint === 'string' ? entry.entrypoint : 'cli',
  name: typeof entry.name === 'string' ? entry.name : '',
  status: entry.status === 'busy' ? 'busy' : 'idle',
  bridgeSessionId: typeof entry.bridgeSessionId === 'string' ? entry.bridgeSessionId : '',
  updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0,
});

/**
 * @param {object} dependencies
 * @param {object} dependencies.fsPromises
 * @param {string} dependencies.sessionsDir `<CLAUDE_CONFIG_DIR>/sessions`
 * @param {(pid: number, signal: number | string) => void} [dependencies.kill]
 * @param {string} [dependencies.platform]
 */
export const createLiveSessionRegistry = ({
  fsPromises,
  sessionsDir,
  kill = process.kill.bind(process),
  platform = process.platform,
}) => {
  /** Map<sessionId, owner> of sessions running in a live CLI process. */
  const read = async () => {
    let names;
    try {
      names = await fsPromises.readdir(sessionsDir);
    } catch (error) {
      if (error?.code === 'ENOENT') return new Map();
      throw error;
    }
    const owners = new Map();
    await Promise.all(names.filter((name) => ENTRY_FILE.test(name)).map(async (name) => {
      let entry;
      try {
        entry = JSON.parse(await fsPromises.readFile(path.join(sessionsDir, name), 'utf8'));
      } catch {
        return;
      }
      if (!entry || typeof entry.sessionId !== 'string' || !Number.isInteger(entry.pid)) return;
      if (!isProcessAlive(kill, entry.pid)) return;
      if (platform === 'linux' && entry.procStart !== undefined) {
        const procStart = await readProcStart(fsPromises, entry.pid);
        if (procStart !== null && String(procStart) !== String(entry.procStart)) return;
      }
      const owner = toOwner(entry);
      const previous = owners.get(owner.sessionId);
      // Two live entries for one session means it was resumed while still
      // open; the most recently active one is the writer that matters.
      if (!previous || owner.updatedAt >= previous.updatedAt) owners.set(owner.sessionId, owner);
    }));
    return owners;
  };

  const isAlive = (owner) => isProcessAlive(kill, owner.pid);

  /**
   * Ask the owning process to exit and wait until it has. Resolves `true`
   * once the pid is gone, `false` if it outlived `timeoutMs`.
   */
  const stop = async (owner, { timeoutMs = 15000, pollMs = 250, sleep } = {}) => {
    const wait = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    if (!isAlive(owner)) return true;
    try {
      kill(owner.pid, 'SIGTERM');
    } catch (error) {
      if (error?.code === 'ESRCH') return true;
      throw error;
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await wait(pollMs);
      if (!isAlive(owner)) return true;
    }
    return !isAlive(owner);
  };

  return { read, stop };
};

/** claude.ai link of a session published through Remote Control. */
export const remoteControlUrl = (bridgeSessionId) => (
  bridgeSessionId ? `https://claude.ai/code/${bridgeSessionId.replace(/^cse_/, 'session_')}` : ''
);

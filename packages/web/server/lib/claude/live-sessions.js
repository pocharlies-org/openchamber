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

import { execFile } from 'child_process';
import path from 'path';

const ENTRY_FILE = /^\d+\.json$/;

/** Start time (field 22) and parent pid (field 4) of a process, from /proc. */
const readProcStat = async (fsPromises, pid) => {
  try {
    const stat = await fsPromises.readFile(`/proc/${pid}/stat`, 'utf8');
    // `comm` (field 2) is parenthesised and may contain spaces: count fields
    // from the closing parenthesis. Field 3 is the first one after it.
    const afterComm = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ppid = Number.parseInt(afterComm[4 - 3], 10);
    return { start: afterComm[22 - 3] ?? null, ppid: Number.isInteger(ppid) ? ppid : null };
  } catch {
    return null;
  }
};

// A session revived for Remote Control runs alone in a transient unit
// (`claude-rc-revive-<uuid8>.service`, see rc-sessions.py). SIGTERM leaves
// that unit `failed`, and a failed unit still counts against the revive cap
// and blocks reviving the same session — so it is reset once its pid exits.
const REVIVE_UNIT = /(?:^|\/)(claude-rc-revive-[A-Za-z0-9_.-]+\.service)$/;

const readReviveUnit = async (fsPromises, pid) => {
  try {
    const cgroup = await fsPromises.readFile(`/proc/${pid}/cgroup`, 'utf8');
    for (const line of cgroup.split('\n')) {
      const cgroupPath = line.slice(line.lastIndexOf(':') + 1).trim();
      const match = REVIVE_UNIT.exec(cgroupPath);
      if (match) return match[1];
    }
  } catch {
    // No /proc (not Linux) or the process is already gone.
  }
  return null;
};

const defaultResetFailedUnit = (unit) => new Promise((resolve) => {
  execFile('systemctl', ['--user', 'reset-failed', unit], { timeout: 10000 }, () => resolve());
});

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
  ppid: Number.isInteger(entry.ppid) ? entry.ppid : null,
});

/**
 * @param {object} dependencies
 * @param {object} dependencies.fsPromises
 * @param {string} dependencies.sessionsDir `<CLAUDE_CONFIG_DIR>/sessions`
 * @param {(pid: number, signal: number | string) => void} [dependencies.kill]
 * @param {string} [dependencies.platform]
 * @param {(unit: string) => Promise<void>} [dependencies.resetFailedUnit]
 */
export const createLiveSessionRegistry = ({
  fsPromises,
  sessionsDir,
  kill = process.kill.bind(process),
  platform = process.platform,
  resetFailedUnit = defaultResetFailedUnit,
}) => {
  /**
   * Map<sessionId, owner> of sessions running in a live CLI process.
   * `ignoreParentPid` leaves out the processes that pid spawned — the caller's
   * own CLI children — so what remains are writers someone else runs.
   */
  const read = async ({ ignoreParentPid } = {}) => {
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
      let ppid = null;
      if (platform === 'linux') {
        const stat = await readProcStat(fsPromises, entry.pid);
        if (stat && entry.procStart !== undefined && stat.start !== null
          && String(stat.start) !== String(entry.procStart)) return;
        ppid = stat?.ppid ?? null;
      }
      if (ignoreParentPid !== undefined && ppid === ignoreParentPid) return;
      const owner = toOwner({ ...entry, ppid });
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
    const unit = platform === 'linux' ? await readReviveUnit(fsPromises, owner.pid) : null;
    const exited = async () => {
      if (unit) await resetFailedUnit(unit).catch(() => {});
      return true;
    };
    try {
      kill(owner.pid, 'SIGTERM');
    } catch (error) {
      if (error?.code === 'ESRCH') return exited();
      throw error;
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await wait(pollMs);
      if (!isAlive(owner)) return exited();
    }
    return isAlive(owner) ? false : exited();
  };

  return { read, stop };
};

/** claude.ai link of a session published through Remote Control. */
export const remoteControlUrl = (bridgeSessionId) => (
  bridgeSessionId ? `https://claude.ai/code/${bridgeSessionId.replace(/^cse_/, 'session_')}` : ''
);

// Read-only index of Claude Code sessions stored on disk under
// `~/.claude/projects/*/*.jsonl` (one jsonl per session; nested transcripts
// under `<session>/subagents/` belong to their parent session and are
// deliberately not listed as sessions themselves).
//
// Design constraints (SC-688):
// - Partial reads only. The corpus is multiple GB with files over 10 MB, so
//   each file is read through a bounded head window and a bounded tail
//   window (one read when the file fits the head window). A transcript is
//   never loaded whole.
// - Incremental cache keyed by mtime+size. `listSessions()` serves the
//   in-memory cache and never touches disk, so `/api/session` stays inside
//   its latency budget; refreshes only re-read files whose mtime or size
//   changed.
// - `live` is a boolean heuristic, never null: a session is live when a
//   running process references its id (Linux: the session uuid appears in
//   `/proc/<pid>/cmdline`, e.g. `claude --resume <uuid>`) or when its jsonl
//   was written within `liveMtimeMs` (a session being actively appended to).
//   Without `/proc` (non-Linux) only the mtime rule applies.
// - Privacy: transcripts contain work and secrets. Only derived scalars are
//   kept (id, cwd, truncated title, timestamps, token counters). Message
//   content is never copied beyond the title fallback, which is truncated.

import fsDefault from "node:fs";
import osDefault from "node:os";
import pathDefault from "node:path";

const HEAD_BYTES = 64 * 1024;
const HEAD_MAX_BYTES = 512 * 1024;
const TAIL_BYTES = 64 * 1024;
const TITLE_MAX_CHARS = 160;
const DEFAULT_LIVE_MTIME_MS = 120_000;
const DEFAULT_REFRESH_STALE_MS = 15_000;
const READ_CONCURRENCY = 16;

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const collapseText = (value) => {
  if (typeof value !== "string") return null;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  return collapsed.length > TITLE_MAX_CHARS ? `${collapsed.slice(0, TITLE_MAX_CHARS - 1)}…` : collapsed;
};

const parseTimestamp = (value) => {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const firstUserText = (record) => {
  const content = record?.message?.content;
  if (typeof content === "string") return collapseText(content);
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part?.type === "text" && typeof part.text === "string") {
        const collapsed = collapseText(part.text);
        if (collapsed) return collapsed;
      }
    }
  }
  return null;
};

// Walks complete JSONL lines of a head window. The final line is dropped
// when the window cut it mid-record.
const parseHeadWindow = (text, dropLastLine) => {
  const out = { cwd: null, created: null, title: null };
  const lines = text.split("\n");
  if (dropLastLine && lines.length > 1) lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || typeof record !== "object") continue;
    if (!out.cwd && typeof record.cwd === "string" && record.cwd) out.cwd = record.cwd;
    if (!out.created) out.created = parseTimestamp(record.timestamp);
    if (record.type === "ai-title" && typeof record.aiTitle === "string" && record.aiTitle.trim()) {
      out.title = collapseText(record.aiTitle);
    }
    if (!out.title && record.type === "queue-operation" && typeof record.content === "string") {
      out.title = collapseText(record.content);
    }
    if (!out.title && record.type === "user") out.title = firstUserText(record);
    if (out.cwd && out.created && out.title) break;
  }
  return out;
};

// Walks complete JSONL lines of a tail window, keeping the LAST value seen
// for each field (the window is read forward; only complete lines count).
const parseTailWindow = (text, dropFirstLine) => {
  const out = { cwd: null, updated: null, tokens: null, aiTitle: null, lastPrompt: null };
  const lines = text.split("\n");
  if (dropFirstLine && lines.length > 1) lines.shift();
  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || typeof record !== "object") continue;
    if (typeof record.cwd === "string" && record.cwd) out.cwd = record.cwd;
    const ts = parseTimestamp(record.timestamp);
    if (ts !== null) out.updated = ts;
    if (record.type === "ai-title" && typeof record.aiTitle === "string" && record.aiTitle.trim()) {
      out.aiTitle = collapseText(record.aiTitle);
    }
    if (record.type === "last-prompt" && typeof record.lastPrompt === "string") {
      out.lastPrompt = collapseText(record.lastPrompt);
    }
    const usage = record.type === "assistant" ? record.message?.usage : null;
    if (usage && typeof usage === "object") {
      const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
      out.tokens = {
        input: num(usage.input_tokens),
        output: num(usage.output_tokens),
        reasoning: num(usage.output_tokens_details?.thinking_tokens),
        cache_read: num(usage.cache_read_input_tokens),
        cache_creation: num(usage.cache_creation_input_tokens),
      };
    }
  }
  return out;
};

// The jsonl folder name encodes the project path by replacing separators with
// dashes, which is lossy. Only used when no record carries a real `cwd`.
const decodeProjectDirName = (dirName) => {
  if (!dirName.startsWith("-")) return null;
  return `/${dirName.slice(1).replace(/-/g, "/")}`;
};

const runPool = async (items, worker, concurrency) => {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
};

export const createClaudeCodeSessionIndex = (options = {}) => {
  const fs = options.fs ?? fsDefault;
  const os = options.os ?? osDefault;
  const path = options.path ?? pathDefault;
  const fsp = fs.promises;
  const platform = options.platform ?? process.platform;
  const projectsDir = options.projectsDir ?? path.join(os.homedir(), ".claude", "projects");
  const liveMtimeMs = options.liveMtimeMs ?? DEFAULT_LIVE_MTIME_MS;
  const refreshStaleMs = options.refreshStaleMs ?? DEFAULT_REFRESH_STALE_MS;
  const now = options.now ?? (() => Date.now());

  // filePath -> { entry..., mtimeMs, size }
  const entries = new Map();
  const stats = {
    initialScanMs: null,
    lastRefreshMs: null,
    lastRefreshAt: 0,
    totalBytesRead: 0,
    reindexed: 0,
    removed: 0,
  };
  let started = false;
  let refreshing = null;
  let stopped = false;

  const readWindow = async (fileHandle, position, length) => {
    if (length <= 0) return { text: "", bytesRead: 0 };
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await fileHandle.read(buffer, 0, length, position);
    stats.totalBytesRead += bytesRead;
    return { text: buffer.subarray(0, bytesRead).toString("utf8"), bytesRead };
  };

  const indexFile = async (filePath) => {
    const stat = await fsp.stat(filePath);
    const id = path.basename(filePath, ".jsonl");
    const dirName = path.basename(path.dirname(filePath));

    let head = { cwd: null, created: null, title: null };
    let tail = { cwd: null, updated: null, tokens: null, aiTitle: null, lastPrompt: null };
    const fileHandle = await fsp.open(filePath, "r");
    try {
      if (stat.size <= HEAD_BYTES) {
        const { text } = await readWindow(fileHandle, 0, stat.size);
        head = parseHeadWindow(text, false);
        tail = parseTailWindow(text, false);
      } else {
        const headWindow = await readWindow(fileHandle, 0, HEAD_BYTES);
        head = parseHeadWindow(headWindow.text, true);
        if (!head.cwd && stat.size > HEAD_BYTES) {
          const extended = await readWindow(fileHandle, 0, Math.min(HEAD_MAX_BYTES, stat.size));
          head = parseHeadWindow(extended.text, extended.bytesRead < stat.size);
        }
        const tailOffset = Math.max(HEAD_BYTES, stat.size - TAIL_BYTES);
        const tailWindow = await readWindow(fileHandle, tailOffset, stat.size - tailOffset);
        tail = parseTailWindow(tailWindow.text, tailOffset > 0);
      }
    } finally {
      await fileHandle.close();
    }

    const title = tail.aiTitle || head.title || tail.lastPrompt || id;
    const updated = tail.updated ?? head.created ?? stat.mtimeMs;
    const entry = {
      id,
      directory: head.cwd || tail.cwd || decodeProjectDirName(dirName),
      title,
      time: { created: head.created, updated },
      live: false,
      ...(tail.tokens ? { tokens: tail.tokens } : {}),
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    };
    entries.set(filePath, entry);
    return entry;
  };

  const collectLiveIds = async () => {
    const liveIds = new Set();
    if (platform !== "linux") return liveIds;
    let procEntries;
    try {
      procEntries = await fsp.readdir("/proc");
    } catch {
      return liveIds;
    }
    const pids = procEntries.filter((name) => /^\d+$/.test(name));
    await runPool(pids, async (pid) => {
      try {
        const cmdline = await fsp.readFile(path.join("/proc", pid, "cmdline"), "utf8");
        for (const match of cmdline.match(UUID_RE) ?? []) liveIds.add(match.toLowerCase());
      } catch {
        // Process vanished or cmdline unreadable: not a live session.
      }
    }, READ_CONCURRENCY);
    return liveIds;
  };

  const runRefresh = async () => {
    const startedAt = now();

    let projectDirs = [];
    try {
      const dirEntries = await fsp.readdir(projectsDir, { withFileTypes: true });
      projectDirs = dirEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      // Missing projects dir: the index is simply empty.
    }

    const filePaths = [];
    await runPool(projectDirs, async (dirName) => {
      let files = [];
      try {
        files = await fsp.readdir(path.join(projectsDir, dirName));
      } catch {
        return;
      }
      for (const file of files) {
        if (file.endsWith(".jsonl")) filePaths.push(path.join(projectsDir, dirName, file));
      }
    }, READ_CONCURRENCY);
    const found = new Set(filePaths);

    const pending = [];
    await runPool(filePaths, async (filePath) => {
      let stat = null;
      try {
        stat = await fsp.stat(filePath);
      } catch {
        return;
      }
      const cached = entries.get(filePath);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return;
      pending.push(filePath);
    }, READ_CONCURRENCY);

    for (const filePath of [...entries.keys()]) {
      if (!found.has(filePath)) {
        entries.delete(filePath);
        stats.removed += 1;
      }
    }

    await runPool(pending, (filePath) => indexFile(filePath).catch(() => {}), READ_CONCURRENCY);
    stats.reindexed += pending.length;

    const liveIds = await collectLiveIds();
    const nowMs = now();
    for (const entry of entries.values()) {
      entry.live = liveIds.has(entry.id) || nowMs - entry.mtimeMs < liveMtimeMs;
    }

    const durationMs = now() - startedAt;
    stats.lastRefreshMs = durationMs;
    stats.lastRefreshAt = nowMs;
    if (stats.initialScanMs === null) stats.initialScanMs = durationMs;
    return { scanned: found.size, reindexed: pending.length, durationMs };
  };

  const startRefresh = () => {
    if (refreshing) return refreshing;
    refreshing = runRefresh()
      .catch((error) => {
        console.error(`[claude-code-sessions] refresh failed: ${error?.message ?? error}`);
        return null;
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  };

  const ensureStarted = () => {
    if (stopped || started) return refreshing;
    started = true;
    return startRefresh();
  };

  const refreshIfStale = () => {
    if (stopped) return null;
    if (!started) return ensureStarted();
    if (refreshing) return refreshing;
    if (now() - stats.lastRefreshAt > refreshStaleMs) return startRefresh();
    return null;
  };

  const listSessions = () =>
    [...entries.values()]
      .map(({ mtimeMs, size, ...publicEntry }) => publicEntry)
      .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));

  const getStats = () => ({
    entries: entries.size,
    ...stats,
    refreshing: Boolean(refreshing),
  });

  const stop = () => {
    stopped = true;
  };

  return { ensureStarted, refreshIfStale, refresh: runRefresh, listSessions, getStats, stop };
};

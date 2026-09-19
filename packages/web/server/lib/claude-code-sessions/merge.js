// Fusion of the on-disk Claude Code session index into the sanitized
// `/api/session` payload (SC-688 S2). Pure function over already-fetched
// lists: the disk side always comes from the in-memory index cache, never
// from a per-request scan.
//
// Dedupe rule (measured empirically on the live server on 2026-09-19): the
// Agent-SDK runtime lists each Claude session with an id of the form
// `ses_<prefix><raw jsonl uuid>` (observed prefix `ses_ccc`, e.g.
// `ses_ccca868b39e-…` for the raw session `a868b39e-…`). The rule is kept
// prefix-agnostic: the trailing uuid of a `ses_…` id is extracted structurally
// (uuid shape) and only counts as a match when that uuid exists in the disk
// index, so OpenCode ids (`ses_f4dbce944ffe…`, no uuid shape) and runtime
// sessions without a disk counterpart pass through untouched.
//
// Visibility contract (fixed by pm): every disk entry leaves with a `title`
// prefixed `Claude: ` exactly once, `directory` = real cwd from the
// transcript records, `time.updated` = last transcript timestamp, and a
// boolean `live`. When a runtime duplicate is folded in, the disk entry keeps
// the raw id and inherits the runtime `cost`/`tokens` when they carry real
// values (the runtime reports zeros for untracked usage; disk token counters
// win in that case).

export const CLAUDE_TITLE_PREFIX = "Claude: ";

const UUID_TAIL_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const extractClaudeSessionId = (session) => {
  const id = session?.id;
  if (typeof id !== "string" || !id.startsWith("ses_")) return null;
  const match = id.slice(4).match(UUID_TAIL_RE);
  return match ? match[0].toLowerCase() : null;
};

export const prefixClaudeTitle = (title) => {
  const base = typeof title === "string" && title.trim() ? title.trim() : "Claude session";
  return base.startsWith(CLAUDE_TITLE_PREFIX) ? base : `${CLAUDE_TITLE_PREFIX}${base}`;
};

const normalizeDirectory = (value) =>
  typeof value === "string" ? value.trim().replace(/\/+$/, "") : null;

const toResponseEntry = (entry) => ({
  id: entry.id,
  directory: entry.directory,
  title: prefixClaudeTitle(entry.title),
  time: entry.time,
  live: Boolean(entry.live),
  ...(entry.tokens ? { tokens: entry.tokens } : {}),
  ...(entry.cost !== undefined && entry.cost !== null ? { cost: entry.cost } : {}),
});

const hasMeaningfulTokens = (tokens) =>
  Boolean(tokens) &&
  typeof tokens === "object" &&
  !Array.isArray(tokens) &&
  Object.values(tokens).some((value) => typeof value === "number" && value > 0);

export const mergeClaudeCodeSessions = (upstreamSessions, { diskSessions = [], directory = null } = {}) => {
  if (!Array.isArray(upstreamSessions)) return upstreamSessions;

  const diskById = new Map();
  for (const entry of diskSessions) diskById.set(entry.id, entry);

  const merged = [];
  const foldedDiskIds = new Set();
  for (const session of upstreamSessions) {
    const rawId = extractClaudeSessionId(session);
    const diskEntry = rawId ? diskById.get(rawId) : null;
    if (!diskEntry) {
      merged.push(session);
      continue;
    }
    const entry = toResponseEntry(diskEntry);
    if (typeof session.cost === "number" && (session.cost > 0 || entry.cost === undefined)) {
      entry.cost = session.cost;
    }
    if (hasMeaningfulTokens(session.tokens)) entry.tokens = session.tokens;
    merged.push(entry);
    foldedDiskIds.add(rawId);
  }

  const directoryFilter = normalizeDirectory(directory);
  for (const entry of diskSessions) {
    if (foldedDiskIds.has(entry.id)) continue;
    if (directoryFilter && normalizeDirectory(entry.directory) !== directoryFilter) continue;
    merged.push(toResponseEntry(entry));
  }
  return merged;
};

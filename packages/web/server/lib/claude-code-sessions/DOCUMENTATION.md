# Claude Code Sessions Index

## Purpose

Read-only, server-side index of the Claude Code sessions stored on disk under
`~/.claude/projects/*/*.jsonl`, so they can be listed through the existing
`/api/session` route without the OpenCode runtime knowing about them
(SC-688). The UI is untouched: disk entries are folded into the upstream
payload by the `/api/session` handler in `../opencode/proxy.js`.

## Entrypoints and structure

- `index.js`: `createClaudeCodeSessionIndex(options)` — scan + cache runtime.
  Options: `fs`, `os`, `path` (injectable for tests), `projectsDir` (defaults
  to `~/.claude/projects`), `platform`, `liveMtimeMs`, `refreshStaleMs`,
  `now`. API: `ensureStarted()`, `refreshIfStale()`, `refresh()` (awaitable,
  for tests/evidence), `listSessions()`, `getStats()`, `stop()`.
- `merge.js`: `mergeClaudeCodeSessions(upstreamSessions, { diskSessions,
  directory })` — pure fusion of the sanitized upstream list with the index
  cache, plus `extractClaudeSessionId` / `prefixClaudeTitle`.
- Tests run under `node --test` (node:test + node:assert), not vitest; the
  vitest config for `packages/web` excludes this directory.

## Invariants

- Partial reads only. Each jsonl is read through a 64 KiB head window and a
  64 KiB tail window (a single read when the file fits the head window; head
  may extend to 512 KiB only when no `cwd` was found). Transcripts are
  gigabytes and files exceed 10 MB — a whole-file read is never issued.
- Cache keyed by file path, invalidated by mtime+size. `listSessions()`
  serves the in-memory cache and never touches disk; `/api/session` therefore
  never scans per request. The initial scan runs in the background on the
  first `/api/session` request (that first response may lack disk sessions);
  later requests trigger a non-blocking refresh when the cache is older than
  `refreshStaleMs` (15 s). Stale-while-revalidate is intentional.
- `live` is a boolean, never null: true when a running process references the
  session uuid (`/proc/<pid>/cmdline` scan on Linux) or the jsonl was written
  within `liveMtimeMs` (2 min). Without `/proc`, only the mtime rule applies.
- Privacy: transcripts contain work and secrets. Entries carry only derived
  scalars (id, cwd, title, timestamps, token counters). Message content is
  never copied beyond the title fallback, which is truncated to 160 chars.
- Title fallback chain: `ai-title` record → first prompt text (truncated) →
  raw jsonl basename.

## Fusion contract (`/api/session`, SC-1180)

- The disk entry is the base: `id` = raw jsonl basename (uuid), `directory` =
  real `cwd` from the transcript records (the encoded folder name is lossy
  and only a last-resort fallback), `title` = index title prefixed `Claude: `
  exactly once, `time.updated` = last transcript timestamp, `live` boolean.
- Dedupe: the Agent-SDK runtime lists the same sessions with ids shaped
  `ses_<prefix><raw uuid>` (observed prefix `ses_ccc` on the live server).
  `extractClaudeSessionId` structurally extracts the trailing uuid and a
  duplicate is folded only when that uuid exists in the index. The folded
  entry keeps the raw id and inherits the runtime `cost`/`tokens` when they
  carry real values (runtime zeros do not overwrite disk counters). Runtime
  entries without a disk counterpart pass through untouched, as do OpenCode
  entries (their ids lack the uuid shape).
- With `?directory=`, disk-only entries are filtered to that directory so the
  project tree is not polluted; folded entries stay (they came from the
  upstream scoped response).
- `/api/experimental/session` deliberately does not merge (the fusion is
  wired only into the `/api/session` handler; no new routes).

## Failure behavior

- Missing/unreadable `~/.claude/projects`: empty index, no throw.
- A failed per-file read leaves the previous cached entry (if any) intact.
- Upstream failure: `/api/session` keeps its existing 503/504 behavior — the
  disk cache is only merged into a successful upstream array.

## Validation

`node --test packages/web/server/lib/claude-code-sessions/*.test.js` covers
field extraction, the >10 MB bounded-read assertion, incremental refresh, the
live heuristic, the fusion/dedupe rules, and a handler-level integration of
`/api/session` with a stub upstream.

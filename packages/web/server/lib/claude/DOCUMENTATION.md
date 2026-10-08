# Claude Code engine

## Purpose

Serves Claude Code sessions (the transcripts under `~/.claude/projects`) as a
second session engine next to OpenCode, through the same OpenCode 2 routes,
shapes and events the UI already speaks. A session is driven by one Claude
Code CLI process per session through the Agent SDK (`@anthropic-ai/claude-agent-sdk`),
the way the Claude Code VS Code extension drives its panel.

## Modules

| File | Role |
|---|---|
| `routes.js` | Express routes (`createClaudeSurface`): public ids, the OpenCode 2 routes for a Claude session, the v2 event translator, the queue transport, the merges the proxy calls. |
| `runtime.js` | Sessions, transcripts, processes, modes, subagent child sessions, per-session engine state. The list is built with bounded concurrency (`LIST_BUILD_CONCURRENCY`, `lib/concurrency.js`). |
| `session-process.js` | One live CLI process: turns, streaming, tool calls, subagent streams, usage, mode reports. |
| `claude-requests.js` | Claude Code asking the user (`canUseTool`): permission prompts, `AskUserQuestion` forms, plan approvals. |
| `claude-tools.js` | Claude Code tool calls as OpenCode v2 tool parts (names, input keys, diffs, subagent links). |
| `claude-transcript.js` | Transcript records → OpenChamber records (read back). |
| `transcript-sidecar.js` | What the SDK's reader drops: structured tool results (`toolUseResult`), subagent `.meta.json`. Reads transcripts **by lines** (`fsPromises.open` + `readline`), never the whole file; `readFirstPrompt` stops at the first match. |
| `v2-wire.js` | Internal events → OpenCode 2 wire events; records → v2 shapes. |
| `live-sessions.js`, `remote-attach.js` | Sessions live in another CLI process; writing to them through Remote Control. |
| `account.js` | The Claude Code account these sessions run as: its status, and the sign-in that changes it. |

## Ids

- Public session id: `ses_ccc<uuid>` (the UI's source filter keys on the prefix).
- A subagent is a read-only child session: `ses_ccc<uuid>~<agentId>`, `parentID`
  = the session that ran it. Every depth hangs off the root session (Claude
  Code files all subagents under `<session>/subagents/agent-<id>.jsonl`).
  A child answers GET routes and `POST …/interrupt` (stops that subagent,
  `Query.stopTask`); every other write is refused (`subagentWrite`).
- Permission requests `per_ccc…`, forms `frm_ccc…`.

## What a new session starts on

Three layers, highest first, for the model, the thinking effort and the mode:

1. **The pick of the session** — `POST /api/session` with
   `metadata.claude = { model, effort, mode }` (the UI's new-Claude-session
   dialog). `createSession` keeps only the values this host offers, persists
   them in the Claude overlay (`claude-sessions.json` → `selections`) so a
   restart before the first turn loses nothing, and seeds `metadata.claude`.
2. **OpenChamber's defaults** — `claudeDefaultModel` / `claudeDefaultEffort` /
   `claudeDefaultMode` (Settings › Defaults, scope `profile`), read through the
   `readAppSettings` the surface is given in `index.js`.
3. **Claude Code's own** — `modelPicker.options`/`model`, `effortLevel`,
   `permissions.defaultMode` in `~/.claude/settings.json`.

A turn's own pick (`POST …/model`, `…/claude/mode`, the live session state)
outranks all three; `GET /api/claude/models` reports the layer-2/3 defaults so
the dialog opens on them. Nothing here changes a session already running.

## Parity with the VS Code extension

| VS Code | Here |
|---|---|
| Mode indicator: Manual, Edit automatically, Plan, Auto, Bypass | `GET /api/claude/models` → `modes`, `defaultMode`; `POST /api/session/:id/claude/mode {mode}` switches at once (a running turn included). Bypass is offered only when `~/.claude/settings.json` has `skipDangerousModePermissionPrompt: true` or `OPENCHAMBER_CLAUDE_ALLOW_BYPASS=1`. The start mode is, in order: what this session picked at creation (`metadata.claude.mode`), OpenChamber's `claudeDefaultMode` (Settings › Defaults), `permissions.defaultMode` in `~/.claude/settings.json` — each only when this host offers it — else Manual. A mode the CLI switches to by itself (`/plan`, an approved plan) is read from its `system` `init`/`status` messages. OpenCode's agent (`POST …/agent`) never sets it. |
| Permission prompt (allow once / always / deny / "tell Claude what to do instead") | `canUseTool` → `permission.asked`; reply `POST /api/session/:id/permission/:rid/reply {decision, message?}` → 204. `always` saves the SDK's suggestions (`updatedPermissions`); `save` names them with where they are saved. A plain refusal stops the turn; one with a message hands it to Claude. |
| `AskUserQuestion` dialog with "Other" | A form: one field per question (`string`/`multiselect`, `custom: true`); the answer goes back as the tool's `answers` (multi-select comma-separated). A cancelled form refuses. |
| Plan review | `ExitPlanMode` → a permission with `action: 'plan_exit'`, `metadata.plan`. `once` = approve, ask before edits; `always` = approve, edit automatically; `reject` + message = keep planning with that feedback. |
| Subagents: live rows, agent map, read-only transcript, stop | `task_started` links the call (`metadata.sessionID`) and announces the child (`session.created`, busy); the subagent's own frames (`parent_tool_use_id`) stream into the child session; `task_notification` ends it. `GET /api/session?parentID=` lists children (live and from disk). |
| Diffs | Edits carry `metadata.files[{file, patch, additions, deletions}]`: exact hunks from `structuredPatch` when known, else built from the call's strings. |
| To-do list | `TodoWrite` and the task tools render as a checklist; `TaskCreate` results carry `metadata.task` so updates find their task. |
| Context indicator | `result.modelUsage[].contextWindow` → `metadata.claude.contextWindow`; tokens per API message (not per content block). |
| Prompt cache clock | The lifetime the API reported (`cache_creation.ephemeral_1h/5m_input_tokens`) → the answer's `metadata.claude.cacheTtlMs` (read back) and the session's `metadata.claude.cacheTtlMs` (live). A local model's prefix cache reports none: no clock. |

Checkpoint rewind (`rewindFiles`) is not wired yet.

## The account the sessions run as

Claude Code owns the credential: OpenChamber never holds an Anthropic token of
its own for a Claude session. `account.js` asks the CLI (`auth status --json`,
the same read `lib/opencode/claude-cli-auth.js` does for the provider source)
and changes it with `auth login` / `auth logout`, on the same executable the
sessions spawn — so the account picked here is the one a turn is billed to.

`/login` is not available to a process the Agent SDK drives ("isn't available in
this environment"), so the composer's `/login` opens this surface instead of
sending the text to the session. The OAuth exchange stays inside the CLI: it
prints the URL to open and waits for the code the sign-in page hands back, and
OpenChamber shows the URL, writes the pasted code to the child's stdin, and
reports what the child said. A wrong code costs a retry in the same flow — the
CLI re-prompts — not a new sign-in page.

- One login runs at a time: a second `POST /api/claude/account/login` returns
  the flow already in flight rather than starting a second child to write
  credentials over the first. A flow nobody finishes dies at 10 minutes.
- Outcomes come from the CLI, not from scraping its words: when the child ends,
  the account is read again, and that answer is what `signed-in` or `failed`
  means. The child's own lines ride along as `messages` for the user to read.
- Every API-key variable is stripped from the child's environment first, or the
  CLI would authenticate with the key and report that instead of the account.
- A session already running keeps the token it started with until its next turn
  spawns a process. Switching account is not a restart of what is answering.

Routes: `GET /api/claude/account`, `POST /api/claude/account/login`,
`GET|DELETE /api/claude/account/login/:id`,
`POST /api/claude/account/login/:id/code`, `POST /api/claude/account/logout`.

## Pending requests

`claude-requests.js` keeps every open request until it is answered, cancelled
or withdrawn. An ask the SDK aborts (turn interrupted, answered on claude.ai)
settles and publishes `permission.replied` / `form.cancelled`; a process that
exits withdraws its session's requests. The proxy folds them into OpenCode's
global lists (`GET /api/permission/request`, `GET /api/form`), which the UI
rebuilds its cards from on every (re)connect.

A session set to auto-accept in OpenChamber answers Claude's permission prompts
too, through the routing safety net (`isAutoAccepting`, `evaluatePermission`
from `index.js`): the auto-accept runtime only watches OpenCode's stream, and
the UI hides requests of an auto-accepting session.

## Session metadata published

`metadata.claude = { directory, mode?, model?, effort?, cacheTtlMs?, contextWindow? }`
(`model`/`effort` are what the session was created with; the composer reads its
own per-answer model from the transcript, not from here);
`metadata.subagent = { agentType, toolUseId, status, startedAt?, endedAt? }` on
child sessions; `metadata.liveElsewhere`, `metadata.remoteControl` as before.

## Environment

| Variable | Effect |
|---|---|
| `OPENCHAMBER_CLAUDE_LIST_DISABLED=1` | Kill switch: no Claude routes, no Claude sessions listed. |
| `OPENCHAMBER_CLAUDE_REMOTE_CONTROL=1` | Link every process OpenChamber starts to claude.ai. |
| `OPENCHAMBER_CLAUDE_BASE_URL` | `ANTHROPIC_BASE_URL` for the processes OpenChamber starts. |
| `OPENCHAMBER_CLAUDE_ALLOW_BYPASS=1` | Offer Bypass permissions in the mode menu. |
| `CLAUDE_CONFIG_DIR` | Claude Code's config directory (transcripts, sessions registry). |

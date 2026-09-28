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
| `runtime.js` | Sessions, transcripts, processes, modes, subagent child sessions, per-session engine state. |
| `session-process.js` | One live CLI process: turns, streaming, tool calls, subagent streams, usage, mode reports. |
| `claude-requests.js` | Claude Code asking the user (`canUseTool`): permission prompts, `AskUserQuestion` forms, plan approvals. |
| `claude-tools.js` | Claude Code tool calls as OpenCode v2 tool parts (names, input keys, diffs, subagent links). |
| `claude-transcript.js` | Transcript records → OpenChamber records (read back). |
| `transcript-sidecar.js` | What the SDK's reader drops: structured tool results (`toolUseResult`), subagent `.meta.json`. |
| `v2-wire.js` | Internal events → OpenCode 2 wire events; records → v2 shapes. |
| `live-sessions.js`, `remote-attach.js` | Sessions live in another CLI process; writing to them through Remote Control. |

## Ids

- Public session id: `ses_ccc<uuid>` (the UI's source filter keys on the prefix).
- A subagent is a read-only child session: `ses_ccc<uuid>~<agentId>`, `parentID`
  = the session that ran it. Every depth hangs off the root session (Claude
  Code files all subagents under `<session>/subagents/agent-<id>.jsonl`).
  A child answers GET routes and `POST …/interrupt` (stops that subagent,
  `Query.stopTask`); every other write is refused (`subagentWrite`).
- Permission requests `per_ccc…`, forms `frm_ccc…`.

## Parity with the VS Code extension

| VS Code | Here |
|---|---|
| Mode indicator: Manual, Edit automatically, Plan, Auto, Bypass | `GET /api/claude/models` → `modes`, `defaultMode`; `POST /api/session/:id/claude/mode {mode}` switches at once (a running turn included). Bypass is offered only when `~/.claude/settings.json` has `skipDangerousModePermissionPrompt: true` or `OPENCHAMBER_CLAUDE_ALLOW_BYPASS=1`. The start mode is `permissions.defaultMode` when offered, else Manual. A mode the CLI switches to by itself (`/plan`, an approved plan) is read from its `system` `init`/`status` messages. OpenCode's agent (`POST …/agent`) never sets it. |
| Permission prompt (allow once / always / deny / "tell Claude what to do instead") | `canUseTool` → `permission.asked`; reply `POST /api/session/:id/permission/:rid/reply {decision, message?}` → 204. `always` saves the SDK's suggestions (`updatedPermissions`); `save` names them with where they are saved. A plain refusal stops the turn; one with a message hands it to Claude. |
| `AskUserQuestion` dialog with "Other" | A form: one field per question (`string`/`multiselect`, `custom: true`); the answer goes back as the tool's `answers` (multi-select comma-separated). A cancelled form refuses. |
| Plan review | `ExitPlanMode` → a permission with `action: 'plan_exit'`, `metadata.plan`. `once` = approve, ask before edits; `always` = approve, edit automatically; `reject` + message = keep planning with that feedback. |
| Subagents: live rows, agent map, read-only transcript, stop | `task_started` links the call (`metadata.sessionID`) and announces the child (`session.created`, busy); the subagent's own frames (`parent_tool_use_id`) stream into the child session; `task_notification` ends it. `GET /api/session?parentID=` lists children (live and from disk). |
| Diffs | Edits carry `metadata.files[{file, patch, additions, deletions}]`: exact hunks from `structuredPatch` when known, else built from the call's strings. |
| To-do list | `TodoWrite` and the task tools render as a checklist; `TaskCreate` results carry `metadata.task` so updates find their task. |
| Context indicator | `result.modelUsage[].contextWindow` → `metadata.claude.contextWindow`; tokens per API message (not per content block). |
| Prompt cache clock | The lifetime the API reported (`cache_creation.ephemeral_1h/5m_input_tokens`) → the answer's `metadata.claude.cacheTtlMs` (read back) and the session's `metadata.claude.cacheTtlMs` (live). A local model's prefix cache reports none: no clock. |

Checkpoint rewind (`rewindFiles`) is not wired yet.

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

`metadata.claude = { directory, mode?, cacheTtlMs?, contextWindow? }`;
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

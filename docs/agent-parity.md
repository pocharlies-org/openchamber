# Agent parity: OpenCode vs Claude Code

One row per feature a session can be asked for. Source of truth is `ENGINES` in
`packages/web/server/lib/engines/engines.js` (served at `GET /api/engines`, mirrored by
`SESSION_ENGINE_INFO` in `packages/ui/src/lib/sessionEngine.ts`). The `parity` tests
(`packages/ui/src/lib/parity.test.ts`, `packages/web/server/lib/engines/engines.test.js`) fail when this table
and the declarations disagree, and when a `GAP` has no reason.

`OK` = the engine does it. `GAP` = the engine does not; the reason is in the last column. A `GAP` is answered by the
server with `UnsupportedOperationError` and hidden in the UI; it is never forwarded to the other engine.

| Feature | OpenCode | Claude | Estado | Motivo |
| --- | --- | --- | --- | --- |
| `prompt` | yes | yes | OK | |
| `interrupt` | yes | yes | OK | |
| `rename` | yes | yes | OK | |
| `delete` | yes | yes | OK | |
| `archive` | yes | yes | OK | |
| `synthetic` | yes | yes | OK | |
| `fork` | yes | yes | OK | |
| `forkAtMessage` | yes | yes | OK | |
| `compact` | yes | yes | OK | |
| `shell` | yes | no | GAP | Motivo: Claude Code records no shell run in its transcript, so there is nothing to show or replay. |
| `revert` | yes | no | GAP | Motivo: the transcript lives in Claude Code's own files, tied to its directory; there is nothing to stage a revert on. |
| `move` | yes | no | GAP | Motivo: a Claude Code transcript is tied to the directory it runs in; it cannot move to another one. |
| `generate` | yes | no | GAP | Motivo: Claude Code has no side generation (titles, summaries) endpoint to call. |
| `diff` | yes | no | GAP | Motivo: turn diffs come from OpenCode snapshots; Claude Code keeps none to diff. |
| `permissions` | yes | yes | OK | Claude's `canUseTool` prompts are served as OpenCode permission requests. |
| `forms` | yes | yes | OK | Claude's `AskUserQuestion` and plan approvals are served as OpenCode form requests. |
| `metadata` | yes | yes | OK | Pins, `/btw` links and the knowledge cursor live in OpenChamber's own store. |
| `goals` | yes | no | GAP | Motivo: the goal loop drives continuation prompts through OpenCode; Claude has no goal runner yet. |
| `models` | providers | catalog | OK | Different source, same picker: OpenCode provider catalog vs `/api/claude/models`. |
| `agents` | agents | modes | OK | Different source: OpenCode agents vs Claude permission modes. |
| `commands` | server | prompt | OK | OpenCode runs the template; Claude receives `/name args` and expands it itself. |

## Adding an engine

An engine is one entry in `ENGINES`, one in `SESSION_ENGINE_INFO` (the type is exported as `AgentProvider`) and a
`server/lib/<engine>/` module with its routes. Add its column here; the `parity` tests enforce the rest. No third
engine ships today: the only `codex` code is quota reading (`server/lib/quota/providers/codex.js`), not an engine.

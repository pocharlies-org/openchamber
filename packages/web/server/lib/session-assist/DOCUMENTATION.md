# Session assist

The server generates a short reminder of recent work and an optional next user
message with Small Model. Results live in `metadata.openchamber.assist` with
`recap`, `suggestion`, `forMessageID`, and `generatedAt`. The payload shape is
unchanged; an empty suggestion is a successful outcome.

## Ownership

- `runtime.js` owns idle timers, cancellation, provider selection, SDK reads,
  freshness checks, settings gates, and metadata writes.
- `context.js` reads bounded history and constructs human turns. It removes
  tool payloads and injected prompts before retaining message text.
- `prompt.js` owns the generation instructions and total input budget.
- `../small-model/DOCUMENTATION.md` owns provider/auth resolution, generation,
  output limits, and overflow behavior.

## What the model receives

Read backward through the official SDK in pages of 200 messages (the largest
page v2 serves) until history ends or fifty pages have been read: the model
sees the whole session, not a tail. A failed page or repeated cursor aborts
generation; it is not treated as complete history. If the latest answer's human
request has not been found, skip generation rather than invent its context.

The whole session is what lets the suggestion judge the next step against what
the user asked for at the START — a tail window cannot see the original request
once a long task has run for a while, and then invents follow-up work (this
fork's change, upstream #3311). Each turn keeps the names of the tools the
assistant ran (`Tools the assistant used: Bash×3, Read`), never their input or
output: a session can be almost all tool calls, and without them it reads as an
empty conversation. The language sample still comes from the last three turns.

Attached quote bodies have their own 4,000-character limit so a large quote
does not consume the user's comment. Excerpts preserve both ends with an
explicit omission marker, including the conclusion of a long final report.

The complete user prompt is sized by the resolved small model's input
allowance, reserving space for the system prompt; there is no fixed cap. Under
pressure, drop the oldest turns — only in chunks of eight, and turns keep their
number in the session — so the start of the transcript moves in steps: the
prompt goes to the session's own model, and consecutive assists on a session
then share a token prefix the backend can cache. Everything that varies per
call (language sample, requested fields) comes after the transcript.
If the latest pair itself is too large, excerpt
both its user request and answer rather than discarding either side. If even
the minimum prompt cannot fit, skip generation. `onOverflow: 'error'` prevents
the Small Model service from silently cutting off the instructions. Expected
context/output-budget failures are quiet and do not write metadata.

OpenCode message pages still contain complete tool payloads on the wire. A
single long turn can therefore require substantial I/O even though its retained
model context is small. Page/count bounds are not a network-byte quota.

## Generation and lifecycle

1. The server's existing global event fan-out calls `processPayload`. An idle
   event arms the 60-second quiet window. No history scan or startup backfill runs.
2. Busy/retry events and newly created user messages clear pending work and
   abort in-flight reads/generation. Re-emitted old user updates do not cancel it.
3. One generation runs per session. If a newer quiet window expires while an
   old canceled request is still settling, retain that pending run and start it
   after the old one finishes. Later activity cancels the pending run as well.
4. Resolve the small model using the last answer's provider/model and the
   existing explicit settings/config overrides. `restrictToPreferredProvider`
   prevents an implicit cross-provider fallback. Production does not pin the
   experimental model. Generation accepts an abort signal and a 120-second limit.
5. Recap describes the substantive work and its current result, including the
   work behind a closing commit or acknowledgment. Suggestion is independent:
   only unfinished requested agent work should produce a sendable user message.
   Completed work, optional offers, or a decision/action belonging to the user
   should return an empty suggestion. This is model judgment, not authorization
   enforcement or a guarantee that every generated field is factually correct.
6. Re-read the latest message and fresh session before writing. A moved tail,
   canceled run, changed endpoint/directory, archive, revert, or failed fresh
   read discards the result. Never merge from the old pre-generation metadata.
7. Re-check settings, clamp the enabled fields, and merge into fresh metadata.
   The OpenCode update endpoint has no compare-and-set operation; another
   writer after the final read is not guarded atomically.

Stopping the runtime clears pending timers/runs and aborts in-flight operations.
No failed session blocks another session.

## Settings and consumers

`sessionRecapEnabled` and `sessionSuggestionEnabled` default on and are checked
before work and before writing. With both off there are no reads, model calls,
or writes. With one on, the shared recent context is still available, but only
that field is requested. An empty suggestion does not erase a valid recap.

Freshness has one rule, `getCurrentSessionAssist` in
`packages/ui/src/lib/sessionAssistMetadata.ts`, computed from the session
record alone so the chat and the sidebar row always agree: the payload is
current while `generatedAt >= session.time.idle` and the session is not
reverted. OpenCode moves `time.idle` at every turn end, succeeded or failed.
Do not compare `forMessageID` with the last loaded message: in v2 the newest
record is the turn's `idle` marker or a switch record, never the answer.
When a session turns busy, the runtime also deletes the assist it wrote
(`persistSessionAssist(id, dir, null)`), so stored state goes stale only for
payloads written by an earlier process; the `time.idle` rule retires those.

- `packages/ui/src/lib/sessionAssistMetadata.ts` parses the payload and owns freshness.
- `packages/ui/src/hooks/useSessionAssist.ts` adds live-status and settings gating.
- `SessionRecapSpacer` shows the reminder in the reserved gap under the reply.
- `SessionSuggestionChip` fills the composer; it never sends automatically.
- Sidebar rows (`SessionNodeItem`, both Projects and Timeline) mark a session
  whose suggestion is still open with a small icon and the suggestion as its
  title, using the same freshness rule (`getOpenSessionSuggestion`). The marker hides while a turn runs, on the open session, and
  when `sessionSuggestionEnabled` is off.

Web, Electron, hosted mobile, and Capacitor use the server watcher. VS Code's
extension-only runtime does not generate assists; shared UI can render payloads
produced by a server. The background watcher cannot use the browser's message
store when the UI is closed. Manual AI rename uses that store through
`SessionMessageLoader`; these are intentionally different retrieval lifecycles.

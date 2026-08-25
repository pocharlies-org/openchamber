# Company Office Server Module

## Ownership

This module owns the server-side Company Office projection. It reads company-owned
configuration, roster/runtime files, OpenCode session state, and one configured work
tracker. It returns a bounded browser DTO; credentials and raw upstream payloads remain
server-side.

`routes.js` registers the explicit OpenChamber endpoint before the generic OpenCode
proxy. The route is authenticated by the existing `/api` access middleware and returns
`Cache-Control: no-store`.

The declarative UI manifest is activation metadata only. It cannot register this route
or execute connector code.

## Components

- `config.js`: versioned Company Office configuration parser and legacy schema support.
- `work-trackers/jira.js`: Jira Cloud transport, bounded pagination, and normalized work
  item projection.
- `runtime.js`: roster/OpenCode orchestration and final Company Office snapshot.
- `routes.js`: HTTP status and error contract.
- `engines/`: the runtimes a ticket can be worked on, and the routing that picks one.

## Configuration Contract

Schema version 1 supports:

- nested, provider-neutral configuration for new installations;
- the original flat private-installation shape for persisted compatibility.

Both normalize into:

```text
company.id, company.displayName
roster.manifestPath, roster.registryPath
intake.employeeId, intake.sessionTitle
workTracker.provider
workTracker.jira.baseUrl, projectKey, email, tokenFile, initiativeIssueTypes,
                 acceptanceCriteriaField, sessionField, repoField
```

Only `provider: jira` is implemented. Unknown providers fail configuration validation.

`acceptanceCriteriaField`, `sessionField` and `repoField` are optional custom-field ids.
They are instance-specific (`customfield_10042`), so they stay configuration and never
become repository constants. Absent means the corresponding value is simply `null`.

## Dispatch Model

The unit of parallel work is the **ticket**, not the employee and not the epic. Roles are
stateless configuration, so one role agent runs on as many tickets as the pool allows.

`dispatcher.js` owns this:

- `planDispatch` is pure. It refuses to exceed the pool, refuses tickets that already have
  a live worker, and records a reason for everything it skips.
- `spawn` creates the session already bound to its role agent and dispatches with
  `prompt_async`. The agent id must travel in the message body; setting it on the session
  record alone is ignored by the dispatch path.
- `supervise` is the watchdog. A worker past its deadline is aborted and its slot
  reclaimed, so a hung turn can only stall its own ticket.
- `retire` archives finished workers.

The session title is `[KEY] summary`, which the projection already parses, so dispatch and
read stay consistent without a second mechanism.

## Engines

A ticket is worked by an **engine**, and which one is decided per ticket by the model its
role is configured with. The company does not have one kind of worker: triage belongs on
the local resident, while a review can be worth a subscription turn.

| Role model | Engine | Runtime |
| --- | --- | --- |
| `claude/<model>` | `claude` | a real Claude Code session, on the operator's subscription |
| `codex/<model>` | `codex` | a real Codex session, on the operator's ChatGPT login |
| anything else | `opencode` | the OpenCode server, i.e. LiteLLM and the local models |

`engines/routing.js` reads the `<providerID>/<modelID>` spelling roles already use, so
this adds no new configuration format and every existing role keeps its behaviour.

### Why the CLI engines exist

Re-publishing a subscription's credentials as a generic completions endpoint is what these
engines exist **not** to do. They drive the vendor's own client instead, so the work stays
inside the product the subscription is sold for, and each session is left in that client's
own store — openable afterwards with `claude --resume <id>` or `codex exec resume <id>`.

Each engine guards that on every spawn, because the danger is ambient configuration nobody
meant to apply and neither failure is visible in the transcript afterwards:

- the Codex engine **forces `model_provider`**, so a config file rewritten by a plugin
  cannot route a turn back through a gateway;
- the Claude engine **removes `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN`** from the child environment, which
  would otherwise reroute the session or move it onto metered billing.

### Lifecycles are genuinely different

OpenCode is a server: a turn is a request, `prompt_async` returns immediately, and
`/session/status` answers whether it is busy. A CLI has none of that, so for the CLI
engines:

- **liveness is the child process**, not a remote status map. A registered child that is
  still running is the busy state; nothing else can be asked.
- **abort is a signal**, sent as `SIGTERM` first so the session file closes cleanly. A
  half-written transcript is unresumable, which would defeat the point.
- **archiving does not exist.** `archive` reports `archived: false`, and `retire` treats
  that as a deliberate retention rather than a leak. The transcript is both the operator's
  copy and the ticket's claim.

Dispatch must not block on a turn, so a start resolves at the first moment its session id
is known — Claude is told which id to use, Codex announces one on its first JSONL line —
and the child then runs unattended under the registry. Losing that id would strand a
running child that no supervisor could find or kill.

### Consequences the dispatcher carries

- **A worker remembers its engine.** A session id only means something to the engine that
  minted it; supervising or retiring through another one reports a live ticket as finished.
- **Claims are merged across engines.** A ticket claimed on two engines is the same
  ambiguity as two sessions on one, and resumes neither.
- **A role configured for an engine that is not enabled fails that ticket only**, and never
  falls back. Routing elsewhere would bill a different account and write the session where
  the operator will not look for it.

## One Ticket, One Session

Duplicates had a single cause: the claim was written after the work started. Creating the
session and recording its pointer in Jira are two separate writes, so a crash between them
left a live session that nothing referenced, and the next cycle saw a free ticket.

The fix removes the window instead of narrowing it: the session is its own claim, written
as the work starts. How that claim is spelled is the engine's business — OpenCode puts
`[KEY] …` in the title in the same request that creates the session, Codex carries the same
marker in the prompt so it lands in the rollout, and Claude needs no marker at all because
the session id is **derived from the ticket key**, which cannot go stale or be rewritten.
Every cycle:

1. scans live OpenCode sessions and maps them back to tickets by title prefix;
2. **reuses** the session a ticket already owns, sending the new prompt to it;
3. repairs the Jira pointer if it was lost, so the human-facing link heals by itself.

Consequences that are deliberate:

- **A failed scan creates nothing.** Without it there is no proof a ticket is free, and
  creating anyway is precisely how duplicates appear. Rescued sessions still get fed.
- **Two live sessions for one ticket are never resolved by guessing.** The ticket is
  reported `ambiguous_session` and left alone; picking one silently splits its history.
- The Jira pointer is a convenience for humans and may lag. It is never the only evidence.

## The Loop

`dispatch-loop.js` runs one cycle per `tick()`. It holds **no authoritative state of its
own**: the live worker set is rebuilt every cycle from durable evidence — the session
pointer recorded on the ticket, plus OpenCode's live status. A crash mid-cycle therefore
cannot orphan a worker or double-dispatch a ticket, and the loop needs no recovery logic.

### Why a duplicate could happen, and what closes it

Creating a session and recording its pointer in Jira are two writes. A crash between them
left a live session that Jira knew nothing about, so the next cycle saw a free ticket and
created a second one.

The fix is not a lock: **the session is its own claim.** Its title carries `[KEY]` and is
written in the same request that creates it, so there is no window where work exists
without evidence. Each cycle scans live sessions by title first and only falls back to the
Jira pointer, which may lag.

Consequences, all covered by focused tests:

- A ticket that already owns a session is **reused**, never duplicated, and its lost Jira
  pointer is repaired on the way.
- If the scan fails, nothing new is created: an unreadable list cannot prove a ticket is
  free, and creating anyway is precisely how duplicates appear.
- A ticket found owning two live sessions is reported `ambiguous_session` and skipped.
  Choosing one silently would split that ticket's history in two.
- A full page is never treated as the end of the list; the scan pages on and degrades to
  `partial` rather than concluding from a truncated read.

Failure rules, each chosen so a bad source cannot cause worse behaviour than doing nothing:

- **A tick never throws.** The caller is a service loop; one exception would stop every
  other ticket.
- **Tracker unreachable → stop the cycle.** An empty issue list is not evidence that there
  is no work.
- **Role config unreadable → refuse to dispatch.** Dispatching then would mean dispatching
  with no permission boundary at all.
- **Status unreadable → treat every claimed ticket as still running.** Over-counting only
  delays work; under-counting duplicates it.
- **Heartbeat failure → degrade visibility only.** Reporting is not the job.
- **AIOPS space selection is authoritative once saved.** The Jira query includes only the
  selected project keys; an explicitly empty selection dispatches nothing. Installations
  without saved AIOPS configuration retain the server-side `projectKey` fallback.
- **AIOPS routing is phase-aware.** Schema v2 resolves exact issue-type/status rules before
  status defaults and issue-type defaults. Each result carries a closed action and role;
  unmatched work is not dispatched. A session is reused only while agent and phase still
  match. A changed responsibility archives the old permission boundary before creating the
  next phase session.

## Jira Is The Bus

Agent-to-agent messaging is deliberately absent: OpenCode offers no way to speak to a live
session, and side channels would remove the work from human view. Progress travels as Jira
comments, and the ticket-to-session link travels as a recorded custom field rather than a
title heuristic.

The tracker exposes exactly three write verbs — `addComment`, `transition`,
`recordSession`. They are narrow on purpose: an agent must never need the Jira token in
`bash`, because the permission map bounds commands and files, not network access.

## How A Denied Tool Actually Behaves

Measured against OpenCode 1.18.18 with an A/B on one prompt and one model:

| session | ruleset | result |
| --- | --- | --- |
| no `permission` | — | `bash` runs, `status: completed` |
| `[{bash,*,deny}]` | applied | the model answers that it has no `bash` tool at all |

A `deny` does not block the call at execution time: it **removes the tool from the set the
model can see**. That is why neither session logs an `evaluated permission` line — there is
nothing to evaluate when the tool was never offered.

Two consequences worth knowing before debugging:

- A model emitting `<bash>…</bash>` as plain text is the expected shape of a missing tool,
  not a broken model. Suspect a `deny` in that session first.
- `POST /session/{id}/shell` does **not** consult the ruleset. Verified with a control:
  zero evaluations both with `bash * deny` and with no ruleset, and the command ran in both
  cases. Role boundaries constrain agent tool use; they do not constrain that endpoint, so
  reaching the OpenCode API is equivalent to bypassing every role.

## Authority And Failure

- Jira is authoritative only for Jira work fields.
- The engine that started a session is authoritative for its existence and live activity;
  no other engine can answer for it.
- The registry is authoritative for employee office directories and effective models.
- When role configuration comes from Forge, a role-level model overrides the installation's
  `defaultModel`; roles without an override inherit that default for their next dispatched turn.
- Company Office is a read projection and never authorizes work.
- Title-based ticket mapping is explicitly reconstructed and non-canonical.
- A source failure remains distinguishable from empty success.
- Pagination safety caps produce `partial`, never false `ready`.
- Rosters are limited to 50 unique employee IDs, and upstream employee reads run in
  bounded batches rather than creating unbounded request fan-out.
- Malformed session or activity rows are discarded without erasing valid sibling rows;
  the affected source reports `partial`.

## Jira Connector Boundary

The Jira connector exposes only normalized work items and completeness. It has no access
to Express route registration, UI state, OpenCode credentials, or filesystem locations
outside its provided configuration/token.

Jira issue-type grouping is installation configuration. The core does not hardcode
`Story` as a universal work model.

`acceptanceCriteriaField` is optional and instance-specific: Jira custom-field IDs differ
per instance, so the ID is configuration and never a repository constant. Values may be
plain text or an Atlassian Document Format tree; both flatten to bounded plain text
(depth-capped, 2000 characters) so no raw upstream payload reaches the browser DTO.

## Epic Session Ownership

An epic is a workplace, not a container. `buildInitiatives` resolves a session for the
initiative key itself using the same ticket-prefix convention as its children, so an epic
carries `session` and `mapping` exactly like a delegated ticket. Two sessions sharing one
key resolve to `ambiguous` with a null session; the projection never picks a winner.

## Webhook Boundary

Webhook ingress is not implemented. A future receiver belongs under a separate public
integration route such as `/integrations/jira/v1/webhook/:installationId`, not the
ordinary browser `/api` namespace. It must verify raw-body signatures before parsing,
deduplicate durably, acknowledge quickly, and enqueue authoritative reconciliation.

Webhook data must never activate sessions or mutate canonical governance directly.

## Validation

Focused tests must cover:

- nested and legacy configuration normalization;
- malformed and unsupported provider configuration;
- Jira pagination and incomplete results;
- epic-owned sessions, including ambiguous duplicates;
- acceptance-criteria flattening, bounding, and absence;
- recorded session/repo fields, including their absence;
- narrow Jira writes: comment shape, refused empty bodies, refused malformed issue keys,
  refused transitions without an id, and refused session records without a field;
- dispatch planning: pool ceiling, already-running tickets, every skip reason;
- dispatch transport: agent bound at creation and repeated in the body, one failed spawn
  not cancelling the batch, a lost session pointer degrading to partial;
- watchdog: only the overdue worker aborted, unusable status maps refused;
- secret non-disclosure;
- Jira failure isolation;
- employee session/activity partial failure;
- exact directory scoping;
- project-key title reconstruction;
- session pagination ambiguity;
- route no-store and unavailable behavior.
- engine routing: each provider segment reaching its own engine, the local default
  unchanged, and an unavailable engine failing only its own ticket;
- CLI engines: a derived session id staying stable, a start settling before the turn ends,
  a partial stdout line not being parsed early, exit-before-session-id reporting the CLI's
  own stderr, abort signalling the child, and a retained transcript not counting as a leak;
- subscription guards: forced Codex provider, and off-subscription environment stripped
  from the Claude child.

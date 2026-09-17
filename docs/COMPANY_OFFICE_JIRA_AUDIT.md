# Company Office Jira Audit

## Purpose

This document preserves the reusable lessons from the first Company Office/Jira
installation without copying its people, project identifiers, session IDs, internal
paths, or credentials. It is both an audit record and a checklist for installing the
same automation in another company.

Evidence cutoff: 2026-08-17. The live validation performed for this audit was read-only.
No Jira issue, workflow, project, token, or webhook was changed.

## Current Maturity

| Capability | State |
| --- | --- |
| Jira project, workflow, and issue hierarchy | Implemented in the reference company |
| Jira API search used by Company Office | Implemented and tested |
| Company roster and OpenCode session projection | Implemented and tested |
| Session links reconstructed from `[PROJECT-N]` titles | Implemented, non-canonical |
| Dedicated Company Office installation guide | Implemented in this repository |
| Provider-neutral tracker boundary | Implemented for Jira reads |
| Canonical ticket/session governance ledger | Designed, not implemented |
| Automatic preflight and lifecycle enforcement | Designed, not implemented |
| Jira webhook receiver | Designed, not implemented or exposed |
| Webhook registration/refresh control plane | Designed, not configured |
| Periodic authoritative reconciliation | Designed, not implemented |

Company Office must not present planned controls as operational. Its current
`mappingMode` is `reconstructed` because a title prefix and Jira issue key do not replace
a canonical durable ledger.

## Read-Only Audit Method

The reference Jira project was queried through REST API v3 without retaining issue
content. The audit collected only aggregate issue-type/status/parent counts, webhook
inventory metadata, and authentication-capability flags. Reference-company values are
kept outside this reusable repository.

The audit confirmed that authentication identity and effective automation actor can be
different concepts and must be recorded separately. It also confirmed that webhook
inventory must be inspected explicitly rather than inferred from Jira activity.

## What Was Built In Jira

The reference installation established:

- one Jira project for formal work;
- Stories as aggregate outcomes;
- Subtasks as assignable/executable work;
- a board with Backlog, In Progress, Review, QA, Sign-off, and Done phases;
- replacement links for migrated legacy tasks;
- comments containing session and actor evidence;
- ticket keys in session titles, branches, commits, and pull requests;
- a real create/assign/transition smoke test that was independently reread.

The Jira workflow permits broad transitions. Therefore Jira alone does not enforce the
proposed gate order. Any strict execution policy must be enforced by accepted governance,
preflight, merge controls, and reconciliation rather than inferred from columns.

## Authority Model To Reuse

| Domain | Authority |
| --- | --- |
| Issue key, scope, parent, criteria, assignee, work status | Work tracker |
| Code, commits, branches, and pull requests | Source-control platform |
| Real conversation and activity | OpenCode session server |
| Operational ticket/session identity | Future durable governance ledger |
| Human-readable projection | Company Office |

Webhooks, caches, comments, and title reconstruction are evidence or acceleration paths.
They never outrank an authoritative tracker read.

## Recommended Work Model

Use one aggregate issue for the outcome and one executable child issue for every unit or
role boundary. A reusable sequence is:

1. Product criteria.
2. Architecture or coordination.
3. Implementation.
4. Independent peer review.
5. QA.
6. Product sign-off.
7. Architecture/governance gate.
8. Integration and deployment.
9. Aggregate roll-up.

Each executable child issue has one assignee and, while active, at most one canonical
session. Intake or inbox sessions may receive communication but must not authorize formal
work.

## Session Lifecycle Target

The proposed governance policy defines a durable SQLite registry outside Git with:

```text
ticket_key, generation, session_id, actor_id, office_directory,
session_title, link_state, created_at, updated_at, archived_at, revision
```

Target link states:

```text
reserved -> active -> closing -> archived
                   \-> blocked
```

Required invariants:

- one non-archived generation per executable ticket;
- a session ID is globally unique in history;
- archived sessions are never resurrected;
- reassignment archives the previous actor's generation;
- tracker outage, invalid response, race, or disagreement blocks execution;
- all mutations produce an append-only audit event;
- comments may publish revision/session evidence but are not the ledger.

This target remains unimplemented. Do not enable fail-closed global governance until the
ledger, transactional CLI, backup, restore test, and recovery runbook exist and the policy
is accepted.

## Webhook Audit

The reference Jira site had zero configured admin webhooks at the audit cutoff. Company
Office currently reads Jira on demand.

Atlassian's current Jira Cloud documentation establishes these constraints:

- callback URLs must be public HTTPS with a trusted certificate;
- admin webhooks can be signed with a secret and deliver `X-Hub-Signature`;
- Jira may retry failed delivery up to five times with randomized backoff;
- `X-Atlassian-Webhook-Identifier` is stable across retries and unique within one Jira
  tenant; deduplication must use `(installationId, webhookIdentifier)` or an equivalent
  tenant-scoped composite key;
- primary and secondary deliveries can arrive concurrently and with different latency;
- receivers should acknowledge quickly and process asynchronously;
- webhook payloads may contain sensitive issue data;
- dynamic app webhooks require OAuth 2.0/Connect permissions and expire after 30 days;
- Atlassian no longer accepts new Connect Marketplace apps, so a distributable future
  integration should target Forge or OAuth 2.0 rather than Connect;
- webhooks accelerate detection but do not guarantee complete state.

Recommended first event set for Company Office:

```text
jira:issue_created
jira:issue_updated
jira:issue_deleted
comment_created
comment_updated
comment_deleted
```

Filter issue-related events to the configured project. Do not subscribe globally unless
the operator explicitly accepts the data-exposure scope.

## Webhook Processing Contract

The safe flow is:

```text
Jira HTTPS callback
  -> bounded raw-body reader
  -> installation-specific HMAC or OAuth JWT verification
  -> project and event allowlist
  -> durable deduplication
  -> append-only receipt journal
  -> fast 2xx acknowledgement
  -> asynchronous reconciliation request
  -> authoritative Jira GET
  -> normalized tracker snapshot
  -> Company Office refresh/invalidation
```

The webhook payload itself must not:

- activate a session;
- change a canonical mapping;
- authorize continuation of work;
- transition Jira;
- merge or deploy code;
- bypass an authoritative preflight.

## Installation Audit Checklist

### Company identity and roster

- [ ] Company ID is stable and contains no secret.
- [ ] Manifest and registry employee IDs match exactly.
- [ ] Every office directory exists and is owned by the service account.
- [ ] Intake employee and exact intake title are documented.
- [ ] No real employee data is copied into a reusable template.

### Jira project

- [ ] Jira origin uses HTTPS.
- [ ] Project key is stable.
- [ ] Aggregate and executable issue types are identified by configured names.
- [ ] Parent-child behavior is verified with a read-only query.
- [ ] Workflow states and transition permissions are recorded.
- [ ] A dedicated least-privilege account or approved OAuth/Forge app is used.
- [ ] Authentication identity and effective actor attribution are distinct.

### Secret handling

- [ ] Token and webhook secret are stored outside Git.
- [ ] Secret files are readable only by the OpenChamber service identity.
- [ ] Browser profiles, screenshots, setup recordings, and logs contain no reusable
      credentials.
- [ ] Rotation and revocation procedures are documented.

### Company Office

- [ ] Catalog advertises Company Office only when configured.
- [ ] Snapshot returns normalized JSON and `Cache-Control: no-store`.
- [ ] Jira outage is shown as `error`, not empty success.
- [ ] Intake action opens the expected existing session.
- [ ] Session links stay scoped to registered employee directories.
- [ ] External links remain on the configured Jira origin.

### Webhooks

- [ ] Public HTTPS callback and certificate are available.
- [ ] Signature method and secret/JWT verification are tested with exact raw bytes.
- [ ] Event and project allowlists are explicit.
- [ ] Request-body and concurrency limits are set.
- [ ] Delivery identifiers are persisted for deduplication.
- [ ] Processing is asynchronous and idempotent.
- [ ] Retry, dead-letter, retention, and replay procedures exist.
- [ ] Periodic authoritative reconciliation exists.
- [ ] Read-only mode can remain available while automatic mutation is disabled.
- [ ] Registration, refresh, rotation, and deletion require an audited operator action.

### Governance activation

- [ ] One canonical accepted policy exists; draft/worktree copies are not authoritative.
- [ ] Company manuals name one work-state authority.
- [ ] Ledger schema and transactional CLI exist.
- [ ] Backup and restoration have been tested.
- [ ] Reassignment, reopen, duplicate session, archive failure, Jira outage, malformed
      response, webhook loss/replay, and policy-version mismatch tests pass.
- [ ] Rollback returns to a documented manual fail-closed procedure.

## Findings From The Reference Installation

1. Multiple draft policy copies can diverge. A company must designate one canonical
   approved policy before automation is activated.
2. A mutable per-employee session pointer cannot represent several active tickets or act
   as a canonical mapping.
3. All operator and agent manuals must name the same work-state authority.
4. Journal entries must distinguish credential identity from effective actor.
5. One-off browser automation and persistent browser profiles are evidence, not a safe
   reusable installer.
6. Broad tracker workflow transitions can allow skipped gates. Governance tooling must
   not assume the board enforces sequencing.
7. Prompt-level delegation policy is not an authorization boundary; enforce role
   restrictions at tools and runtime boundaries where required.

## Reusable Evidence Record

For each installation, save a redacted report with:

| Field | Requirement |
| --- | --- |
| Audit ID and cutoff | Stable identifier and UTC timestamp |
| Company/config schema | Version only, no secrets or absolute private paths |
| Jira origin/project | Redacted or internally controlled report |
| Auth method | API token, OAuth 2.0, or Forge; never token value |
| Issue type/status counts | Aggregate counts only |
| Webhook inventory | ID, event count, signed flag, project scope; no secret or payload |
| Company Office checks | Catalog, snapshot, intake, links, partial/error behavior |
| Governance controls | Designed/implemented/tested/deployed matrix |
| Contradictions | Exact documents and required canonicalization |
| Approval | Operator, date, activation and rollback decision |

## Official References Used

- Atlassian, **Webhooks**, retrieved 2026-08-17:
  `https://developer.atlassian.com/cloud/jira/platform/webhooks/`
- Atlassian, **Jira Cloud REST API v3 - Webhooks**, retrieved 2026-08-17:
  `https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-webhooks/`
- Atlassian, **Basic auth for REST APIs**, retrieved 2026-08-17:
  `https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/`

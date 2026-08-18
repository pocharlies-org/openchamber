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
workTracker.jira.baseUrl, projectKey, email, tokenFile, initiativeIssueTypes
```

Only `provider: jira` is implemented. Unknown providers fail configuration validation.

## Authority And Failure

- Jira is authoritative only for Jira work fields.
- OpenCode is authoritative for session existence and live activity.
- The registry is authoritative for employee office directories and effective models.
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
- secret non-disclosure;
- Jira failure isolation;
- employee session/activity partial failure;
- exact directory scoping;
- project-key title reconstruction;
- session pagination ambiguity;
- route no-store and unavailable behavior.

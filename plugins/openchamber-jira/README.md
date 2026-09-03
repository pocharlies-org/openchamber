# OpenChamber Jira Connector

This directory defines the Jira connector boundary used by Company Office and the
security model for future Jira webhooks.

It is an in-repository architecture boundary, not an independently published package or
dynamically loaded OpenChamber/OpenCode plugin. The current extension
system accepts declarative UI manifests only; server routes, credentials, rendering, and
Jira transport remain host-owned. The connector is a statically composed server module
so it cannot register arbitrary routes or obtain broader host privileges.

## Current Capability

The connector:

- authenticates server-side to one Jira Cloud origin;
- searches one configured project through REST API v3;
- requests only fields consumed by Company Office;
- paginates with explicit safety bounds;
- normalizes Jira responses into tracker-neutral work items;
- reports incomplete pagination as `partial`;
- keeps Jira credentials and raw responses out of the browser;
- creates canonical Jira links only on the configured HTTPS origin.

Company Office groups configured initiative issue types and places direct children under
them. It reconstructs session links from `[PROJECT-N]` titles. That link is navigation
evidence, not a canonical governance record.

## Connector Contract

The host-facing contract is intentionally narrow:

```text
connector.id
connector.projectKey
connector.projectUrl
connector.loadSnapshot()
  -> { state: ready|partial, issues: NormalizedWorkItem[] }
```

Normalized work item fields:

```text
key, summary, status, type, assignee, parentKey, updatedAt, url
```

Failure is represented by a rejected load and converted by Company Office into
`sources.jira: error`. It is never converted into a successful empty issue array.

## Configuration

New installations use the nested Company Office configuration documented in
`docs/COMPANY_OFFICE.md`:

```json
{
  "workTracker": {
    "provider": "jira",
    "jira": {
      "baseUrl": "https://company.atlassian.net",
      "projectKey": "ENG",
      "email": "automation@example.com",
      "tokenFile": "/run/secrets/company-jira-token",
      "initiativeIssueTypes": ["Story"]
    }
  }
}
```

API-token basic authentication is for private controlled installations. A distributable
integration should use one approved OAuth 2.0 or Forge app. Atlassian no longer accepts
new Connect Marketplace apps.

## Webhook Architecture

Webhooks are not enabled yet. They require a separate public trust boundary and must not
be added to the authenticated browser API by accident.

Target flow:

```text
POST /integrations/jira/v1/webhook/:installationId
  -> bounded raw bytes
  -> resolve installation and its registered authentication mode
  -> verify admin-webhook HMAC or OAuth bearer JWT
  -> allowlist installation, event, project
  -> deduplicate installationId + X-Atlassian-Webhook-Identifier
  -> append receipt metadata
  -> enqueue reconciliation
  -> return 2xx quickly
```

The worker then performs an authoritative Jira GET before changing any derived state.
Webhook payloads are hints, never authorization.

### Required controls

- Public HTTPS callback with a globally trusted certificate.
- One authentication mode per installation. Admin webhooks require `X-Hub-Signature`
  HMAC with that installation's secret; OAuth dynamic webhooks require bearer JWT
  validation with the app client secret and expected claims. Never accept either mode
  opportunistically on the same installation.
- Exact raw-body signature verification with timing-safe comparison.
- Secret rotation with overlap or an explicit maintenance procedure.
- Request-size limits much smaller than Jira's maximum delivery size.
- Project and event allowlists after signature verification.
- Durable deduplication using `(installationId, X-Atlassian-Webhook-Identifier)` because
  Jira guarantees the identifier only within a tenant.
- Retry metadata from `X-Atlassian-Webhook-Retry` retained without payload logging.
- Bounded concurrency and asynchronous processing.
- Idempotent reconciliation and a dead-letter/replay procedure.
- Periodic polling/reconciliation for missed, delayed, or out-of-order events.
- Metrics for receipt lag, invalid signatures, duplicates, failures, and backlog.
- Read-only degradation when automatic mutation is disabled.

### Initial event scope

```text
jira:issue_created
jira:issue_updated
jira:issue_deleted
comment_created
comment_updated
comment_deleted
```

Issue-related events should be filtered to the configured project. Subscribing to all
projects can reveal sensitive information and requires a separate operator decision.

### Registration control plane

Registration is a privileged operation and is intentionally separate from event intake.
An eventual operator API or CLI should support:

```text
inspect -> plan -> register -> verify -> refresh/rotate -> disable -> delete
```

Every mutation needs explicit operator intent, an idempotency key, an audit record, and a
read-after-write verification. Dynamic OAuth/Connect webhooks expire after 30 days and
must be refreshed. Admin webhooks can instead be created with a secret through Jira
Administration or its admin webhook API. Forge owns webhook modules/triggers through the
Forge application lifecycle; it does not use this REST v3 dynamic-webhook refresh control
plane.

No webhook should be registered until the callback URL, certificate, secret storage,
deduplication store, queue, reconciliation worker, retention policy, and rollback have
all been tested.

## AgentGateway

This connector currently adds no agent-facing capability. If agents later need Jira
reads, publish individual typed read tools through AgentGateway. Webhook registration,
rotation, deletion, issue mutation, and replay belong on a separately gated admin plane;
a generic HTTP proxy is not an acceptable substitute.

## Related Documents

- `docs/COMPANY_OFFICE.md`
- `docs/COMPANY_OFFICE_JIRA_AUDIT.md`
- `packages/web/server/lib/company-office/DOCUMENTATION.md`

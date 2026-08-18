# Company Office

Company Office is an optional OpenChamber workspace that combines a company roster,
live OpenCode sessions, activity, and work-tracker data. It gives operators one place
to inspect the team, open an employee's existing session, and follow work without
placing tracker credentials in the browser.

This guide is company-neutral. Paths, project keys, people, and credentials shown below
are placeholders.

## What It Does

When configured, OpenChamber publishes a declarative `company-office` workspace view.
The host renders the view and reads a normalized snapshot from:

```text
GET /api/company-office/snapshot
```

The current snapshot joins four sources:

| Source | Purpose |
| --- | --- |
| Company manifest | Employee identity, role, specialty, and CEO display name |
| Runtime registry | Employee office directory and effective model |
| OpenCode | Root sessions and live activity for each office directory |
| Jira Cloud | Stories, child work items, assignees, statuses, and safe links |

The UI reports each source as `ready`, `partial`, or `error`. A failed source is never
presented as an authoritative empty result.

## How Conversation Works

Company Office does not create a new messaging protocol. It opens real OpenCode
sessions through OpenChamber's normal session store.

The primary call-to-action resolves an intake session as follows:

1. Find the configured employee using `intake.employeeId`.
2. List root sessions in that employee's registered office directory.
3. Match the configured `intake.sessionTitle` exactly.
4. Return the session ID and directory in the snapshot.
5. When the operator selects the action, OpenChamber calls
   `setCurrentSession(session.id, session.directory)` and opens the normal chat.

No message is sent automatically. The operator sees the existing history and decides
what to write. Any employee session listed in Company Office can be opened in the same
way.

## Runtime Support

| Runtime | Support |
| --- | --- |
| Web and PWA | Supported |
| Electron Desktop | Supported through the embedded Web server |
| Hosted mobile | Supported |
| Capacitor mobile | Supported through a connected OpenChamber server |
| VS Code | Unsupported in schema version 1 |

Company Office is advertised only when `OPENCHAMBER_COMPANY_OFFICE_CONFIG` is set.
That indicates configuration is present, not that every upstream source is healthy.

## Prepare A Company

### 1. Create a company manifest

The manifest is YAML and must provide a CEO and employees. Employee IDs are stable join
keys; roles and names are display data.

```yaml
company:
  ceo:
    name: Company Lead

employees:
  - id: cto
    persona: Technical Lead
    role: cto
    specialty: architecture
    model: provider/model
  - id: developer-1
    persona: Developer One
    role: dev
    specialty: backend
    model: provider/model
```

### 2. Create a runtime registry

The registry maps every manifest employee to the real office directory and effective
model. Every listed employee must have one registry entry.

```json
{
  "cto": {
    "directory": "/srv/companies/acme/employees/cto/office",
    "model": "provider/model"
  },
  "developer-1": {
    "directory": "/srv/companies/acme/employees/developer-1/office",
    "model": "provider/model"
  }
}
```

OpenCode session queries are scoped to these directories. A session returned for a
different directory is discarded.

### 3. Prepare Jira access

For the current private/self-hosted integration, use a dedicated least-privilege Jira
account and an API token stored in a server-only file. Atlassian recommends OAuth 2.0 or
Forge for a distributable integration; API-token basic authentication is suitable only
for private scripts and controlled installations.

Required read access:

- Browse the configured Jira project.
- Search issues through Jira REST API v3.
- Read summary, status, issue type, assignee, parent, and update timestamp.

Protect the token file with operating-system permissions such as `0600`. Never put the
token in this repository, the JSON config, a URL, browser storage, a plugin manifest, or
logs.

### 4. Create the Company Office configuration

Start from `packages/web/company-office.config.example.json`:

```json
{
  "schemaVersion": 1,
  "company": {
    "id": "acme",
    "displayName": "Acme"
  },
  "roster": {
    "manifestPath": "/srv/companies/acme/company.yaml",
    "registryPath": "/srv/companies/acme/registry.json"
  },
  "intake": {
    "employeeId": "cto",
    "sessionTitle": "Executive intake - Technical Lead"
  },
  "workTracker": {
    "provider": "jira",
    "jira": {
      "baseUrl": "https://acme.atlassian.net",
      "projectKey": "ENG",
      "email": "automation@example.com",
      "tokenFile": "/run/secrets/acme-jira-token",
      "initiativeIssueTypes": ["Story"]
    }
  }
}
```

Schema version 1 also accepts the original flat configuration for existing private
installations. New installations should use the nested shape so another work tracker can
be added without changing company, roster, or intake settings.

Configuration rules:

- `company.id`, employee IDs, and the Jira project key are stable identifiers.
- `baseUrl` must use HTTPS; only its origin is retained.
- `initiativeIssueTypes` contains the Jira issue-type names grouped as initiatives.
- `intake.sessionTitle` is an exact match and should name a durable intake session.
- Paths are server paths. Authenticated Company Office snapshots include employee and
  session directories because OpenChamber needs them to open sessions; do not expose the
  snapshot endpoint outside OpenChamber's authenticated API boundary.

### 5. Create the intake session

Create one root OpenCode session in the intake employee's registered directory. Give it
the exact configured title. It may be a permanent executive/technical office because it
is an intake channel, not an executable work-ticket session.

Formal work sessions should instead use one tracker key in the title:

```text
[ENG-123] Implement bounded webhook ingestion
```

Company Office reconstructs tracker links from this prefix. This mapping is useful for
navigation and audit, but it is not a canonical governance ledger.

### 6. Enable the service

Set the configuration path in the OpenChamber server environment:

```text
OPENCHAMBER_COMPANY_OFFICE_CONFIG=/etc/openchamber/company-office.json
```

Apply the environment change through the installation's normal service-management
procedure and restart OpenChamber in an authorized maintenance window.

## Verify An Installation

### Server checks

1. Fetch `/api/ui-plugins/catalog` through an authenticated OpenChamber client.
2. Confirm it contains `@pocharlies/openchamber-company-office`.
3. Fetch `/api/company-office/snapshot` through the same authenticated runtime.
4. Confirm the response is JSON with `schemaVersion: 1` and `Cache-Control: no-store`.
5. Confirm no token, authorization header, raw Jira response, or secret path appears.

Expected failure responses:

| HTTP | Error | Meaning |
| --- | --- | --- |
| 404 | `company_office_not_configured` | No configuration path was provided |
| 503 | `company_office_unavailable` | Configuration, roster, registry, OpenCode, or required parsing failed |

Jira failure is isolated inside a valid snapshot as `sources.jira: "error"`; it does not
erase roster or OpenCode session data.

### User checks

1. Open **Company Office** from desktop/web navigation or the mobile sessions footer.
2. Confirm the roster and source-state chips appear.
3. Select the intake action and verify the configured existing session opens.
4. Open an employee session and verify its directory and history are correct.
5. Open a Jira link and verify it stays on the configured Jira origin.
6. Test one ticket titled `[PROJECT-N] ...` and verify Company Office offers its session.

## Operational Model

- Snapshot reads are pull-based and uncached by the route.
- OpenCode sessions are paginated with bounded safety limits.
- Jira search is bounded; hitting a cap reports `partial`.
- Archived and child OpenCode sessions are excluded.
- `busy` and `retry` OpenCode states display as busy.
- A runtime switch cancels or invalidates stale Company Office responses.
- Disabling the UI contribution on one client does not disable the server integration.

## Security Boundaries

The host owns:

- authentication and route ordering;
- configuration and secret-file access;
- OpenCode and Jira transport;
- response normalization and URL validation;
- rendering, navigation, localization, and runtime policy.

The declarative manifest cannot execute JavaScript, register routes, supply iframes, or
choose arbitrary endpoints. Installing a manifest alone does not install Company Office;
the matching host implementation must exist in the OpenChamber version.

## Backup And Portability

Back up only durable company-owned inputs:

- company manifest;
- runtime registry;
- non-secret Company Office configuration;
- secret reference and restoration procedure, not the token in source control;
- accepted work-governance policy and installation audit.

OpenCode session history and Jira remain their own systems of record. Company Office is
a read projection and can be rebuilt from them.

## Troubleshooting

### Company Office is absent

- Confirm `OPENCHAMBER_COMPANY_OFFICE_CONFIG` is present in the running service.
- Confirm the deployed OpenChamber version contains Company Office.
- Refresh the UI-plugin catalog or reconnect the runtime.
- Confirm the plugin is not disabled on that client.

### The intake action is disabled

- Confirm `intake.employeeId` exists in both manifest and registry.
- Confirm the session is a non-archived root session.
- Confirm its title exactly matches `intake.sessionTitle`.
- Confirm its directory exactly matches the employee registry directory.

### Sessions are partial

The session endpoint has bounded pagination and a timestamp-only cursor. Company Office
reports `partial` when it cannot prove a boundary is complete. It must not guess a missing
mapping or advertise completeness.

### Jira is unavailable

- Validate the configured origin, project key, service account, and token file.
- Confirm the account can browse and search the project.
- Check Jira rate limits and service availability.
- Do not treat an empty UI while Jira is in `error` as proof that no work exists.

## Related Documents

- `docs/COMPANY_OFFICE_JIRA_AUDIT.md`: reusable audit and migration record.
- `plugins/openchamber-company-office/README.md`: declarative package boundary.
- `plugins/openchamber-jira/README.md`: Jira connector and webhook design.
- `packages/web/server/lib/company-office/DOCUMENTATION.md`: implementation ownership.

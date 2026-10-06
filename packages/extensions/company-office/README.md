# Company Office (`openchamber-builtin-company-office`)

A read-only rail panel (and full page) over the company: what is running, the
epics the supervisor knows about, and the roster of roles.

## Where each answer comes from

| Shown | Owner | Read by the service from |
|---|---|---|
| On/off, limit, queue, running sessions, each epic's state | the supervisor, `jira-epic-trigger` | `GET /state`, `GET /epics` on `supervisorUrl`, header `X-Company-Token` = `~/.company/jira-trigger/secret` |
| Epic titles and Jira status | Jira | `POST /rest/api/3/search/jql` on `jiraSite`, Basic auth from `~/.company/jira/{user,api.token}`; cached 2 min per key |
| Roster (role, description, model) | Claude Code agent definitions | frontmatter of `~/.claude/agents/company-*.md`; cached 1 min |
| Live transcript | the CTO's Claude Code session | not read here: **Open session** calls `host.openSession("ses_ccc<sid>")`, and the host's Claude surface follows it live |

Defaults for `supervisorUrl` (`http://100.83.56.98:19911`), `jiraSite` and
`agentsDir` can be overridden in `~/.config/openchamber/company-office.json`.
The host passes the service no environment beyond PATH/HOME/locale, so these
files are its only configuration.

## What it deliberately does not do

It launches, resumes, parks and moves nothing, and it receives no Jira
webhook. Since the rewrite of 17-09-2026 the company is driven from Jira and
the supervisor alone (its webhook is `jira-webhook.e-dani.com`); a second
writer here would compete with it. Changing the company means changing Jira or
the supervisor's controls, not this panel.

## Service API

Loopback only, bearer `OPENCHAMBER_SERVICE_TOKEN`, as every guest service:
`GET /health`, and `GET /overview` → `{ status, epics[], roster[], jiraBrowse,
errors{supervisor?, jira?, roster?}, fetchedAt }`. A source that fails fills
its `errors` entry and the rest of the overview still answers.

// Company Office service: answers the panel with a read-only overview of the
// company, joined from the supervisor, Jira and the role definitions. Runs
// under the app's Node runtime on 127.0.0.1, reachable only through the host
// proxy. The host passes no environment beyond PATH/HOME/locale, so every
// credential is read from the files its owner already keeps under HOME.
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {
  parseRoleDefinition,
  toCompanyStatus,
  toEpicRows,
  toIssueSummaries,
  type JiraIssueSummary,
  type Overview,
  type RoleDefinition,
} from './model.ts';

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';
if (!port || !token) {
  console.error('OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required');
  process.exit(1);
}

const HOME = os.homedir();
/** Optional overrides: `{ "supervisorUrl", "jiraSite", "agentsDir" }`. */
const CONFIG_FILE = path.join(HOME, '.config', 'openchamber', 'company-office.json');
const DEFAULTS = {
  // Where `jira-epic-trigger` listens (its LISTEN_HOST/PORT defaults: tailnet only).
  supervisorUrl: 'http://100.83.56.98:19911',
  jiraSite: 'https://e-dani.atlassian.net',
  agentsDir: path.join(HOME, '.claude', 'agents'),
};
const SUPERVISOR_SECRET = path.join(HOME, '.company', 'jira-trigger', 'secret');
const JIRA_USER = path.join(HOME, '.company', 'jira', 'user');
const JIRA_TOKEN = path.join(HOME, '.company', 'jira', 'api.token');

const REQUEST_TIMEOUT_MS = 10_000;
const JIRA_TTL_MS = 2 * 60_000;
const ROSTER_TTL_MS = 60_000;

type Config = typeof DEFAULTS;

const readText = async (file: string): Promise<string | null> => {
  try {
    const text = (await fs.readFile(file, 'utf8')).trim();
    return text || null;
  } catch {
    return null;
  }
};

const loadConfig = async (): Promise<Config> => {
  const raw = await readText(CONFIG_FILE);
  if (!raw) return DEFAULTS;
  try {
    const parsed = JSON.parse(raw) as Partial<Record<keyof Config, unknown>>;
    const pick = (key: keyof Config): string =>
      typeof parsed[key] === 'string' && (parsed[key] as string).trim() ? (parsed[key] as string).trim().replace(/\/+$/, '') : DEFAULTS[key];
    return { supervisorUrl: pick('supervisorUrl'), jiraSite: pick('jiraSite'), agentsDir: pick('agentsDir') };
  } catch {
    return DEFAULTS;
  }
};

const fetchJson = async (url: string, init: RequestInit = {}): Promise<unknown> => {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
};

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const supervisorGet = async (config: Config, route: string): Promise<unknown> => {
  const secret = await readText(SUPERVISOR_SECRET);
  if (!secret) throw new Error(`no supervisor token at ${SUPERVISOR_SECRET}`);
  return fetchJson(`${config.supervisorUrl}${route}`, { headers: { 'X-Company-Token': secret, Accept: 'application/json' } });
};

const jiraCache = new Map<string, { at: number; issue: JiraIssueSummary }>();

/** Titles and workflow status, a batch per refresh, each key cached a couple of minutes. */
const jiraSummaries = async (config: Config, keys: string[]): Promise<Map<string, JiraIssueSummary>> => {
  const now = Date.now();
  const out = new Map<string, JiraIssueSummary>();
  const missing: string[] = [];
  for (const key of keys) {
    const cached = jiraCache.get(key);
    if (cached && now - cached.at < JIRA_TTL_MS) out.set(key, cached.issue);
    else missing.push(key);
  }
  if (missing.length === 0) return out;
  const [user, apiToken] = await Promise.all([readText(JIRA_USER), readText(JIRA_TOKEN)]);
  if (!user || !apiToken) throw new Error(`no Jira credentials at ${path.dirname(JIRA_USER)}`);
  const auth = Buffer.from(`${user}:${apiToken}`).toString('base64');
  for (let start = 0; start < missing.length; start += 100) {
    const batch = missing.slice(start, start + 100);
    const payload = await fetchJson(`${config.jiraSite}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ jql: `key in (${batch.join(',')})`, fields: ['summary', 'status'], maxResults: batch.length }),
    });
    for (const [key, issue] of toIssueSummaries(payload)) {
      jiraCache.set(key, { at: now, issue });
      out.set(key, issue);
    }
  }
  return out;
};

let rosterCache: { at: number; roles: RoleDefinition[] } | null = null;

const readRoster = async (config: Config): Promise<RoleDefinition[]> => {
  if (rosterCache && Date.now() - rosterCache.at < ROSTER_TTL_MS) return rosterCache.roles;
  const names = (await fs.readdir(config.agentsDir)).filter((name) => /^company-[\w-]+\.md$/.test(name)).sort();
  const roles: RoleDefinition[] = [];
  for (const name of names) {
    const text = await readText(path.join(config.agentsDir, name));
    const role = text ? parseRoleDefinition(name, text) : null;
    if (role) roles.push(role);
  }
  rosterCache = { at: Date.now(), roles };
  return roles;
};

const buildOverview = async (): Promise<Overview> => {
  const config = await loadConfig();
  const errors: Overview['errors'] = {};
  const [state, epicsPayload] = await Promise.all([
    supervisorGet(config, '/state').catch((error) => { errors.supervisor = describe(error); return null; }),
    supervisorGet(config, '/epics').catch((error) => { errors.supervisor ??= describe(error); return null; }),
  ]);
  const baseRows = toEpicRows(state, epicsPayload, new Map());
  const issues = await jiraSummaries(config, baseRows.map((row) => row.key))
    .catch((error) => { errors.jira = describe(error); return new Map<string, JiraIssueSummary>(); });
  const roster = await readRoster(config).catch((error) => { errors.roster = describe(error); return []; });
  return {
    status: toCompanyStatus(state),
    epics: toEpicRows(state, epicsPayload, issues),
    roster,
    jiraBrowse: `${config.jiraSite}/browse`,
    errors,
    fetchedAt: Date.now(),
  };
};

const json = (res: http.ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    json(res, 401, { error: 'unauthorized' });
    return;
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/health') {
    json(res, 200, { ok: true });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/overview') {
    buildOverview()
      .then((overview) => json(res, 200, overview))
      .catch((error) => json(res, 500, { error: describe(error) }));
    return;
  }
  json(res, 404, { error: 'not-found' });
});

server.listen(port, '127.0.0.1');

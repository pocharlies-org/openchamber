import { parse as parseYaml } from 'yaml';
import { parseCompanyOfficeConfig } from './config.js';
import { createJiraWorkTracker } from './work-trackers/jira.js';

const SNAPSHOT_SCHEMA_VERSION = 1;
const SESSION_PAGE_SIZE = 200;
const MAX_SESSION_PAGES = 10;
const MAX_EMPLOYEES = 50;
const EMPLOYEE_READ_CONCURRENCY = 4;

const roleTitle = (role) => ({
  cto: 'CTO',
  pm: 'Project Manager',
  po: 'Product Owner',
  devops: 'DevOps',
  sre: 'SRE',
  qa: 'QA',
  dev: 'Developer',
}[role] ?? role);

const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const requiredString = (value, field) => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Invalid Company Office config: ${field}`);
  }
  return value.trim();
};

const optionalString = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;

const normalizeDirectory = (value) => {
  const normalized = requiredString(value, 'employee directory').replace(/\\/g, '/');
  return normalized === '/' ? '/' : normalized.replace(/\/+$/, '');
};

const parseRoster = (manifest, registry) => {
  if (!isRecord(manifest) || !isRecord(manifest.company) || !Array.isArray(manifest.employees) || !isRecord(registry)) {
    throw new Error('Invalid Company Office roster');
  }
  if (manifest.employees.length === 0) {
    throw new Error('Company Office roster must contain at least one employee');
  }
  if (manifest.employees.length > MAX_EMPLOYEES) {
    throw new Error(`Company Office roster exceeds ${MAX_EMPLOYEES} employees`);
  }

  const employeeIds = new Set();
  const employees = manifest.employees.map((entry) => {
    if (!isRecord(entry)) throw new Error('Invalid Company Office employee');
    const id = requiredString(entry.id, 'employees.id');
    if (employeeIds.has(id)) throw new Error(`Duplicate Company Office employee: ${id}`);
    employeeIds.add(id);
    const runtime = registry[id];
    if (!isRecord(runtime)) throw new Error(`Missing Company Office runtime employee: ${id}`);
    const role = requiredString(entry.role, `employees.${id}.role`);
    return {
      id,
      name: requiredString(entry.persona, `employees.${id}.persona`),
      role,
      title: roleTitle(role),
      specialty: optionalString(entry.specialty),
      model: requiredString(runtime.model ?? entry.model, `employees.${id}.model`),
      directory: normalizeDirectory(runtime.directory),
    };
  });

  return {
    ceo: requiredString(manifest.company.ceo?.name, 'company.ceo.name'),
    employees,
  };
};

const finiteNumber = (value, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const normalizeSession = (value, expectedDirectory, statusById) => {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim() || value.id !== value.id.trim()) return null;
  if (value.parentID || value.time?.archived) return null;
  const directory = typeof value.directory === 'string' ? normalizeDirectory(value.directory) : '';
  if (directory !== expectedDirectory) return null;
  const status = isRecord(statusById[value.id]) ? statusById[value.id] : null;
  const activity = status?.type === 'busy' || status?.type === 'retry'
    ? 'busy'
    : status
      ? 'idle'
      : 'unknown';
  const title = typeof value.title === 'string' && value.title.trim() ? value.title.trim().slice(0, 240) : value.id;
  const ticketMatch = /^\[(?<ticket>[A-Z][A-Z0-9_]*-\d+)\]/.exec(title);
  return {
    id: value.id,
    title,
    directory,
    updatedAt: finiteNumber(value.time?.updated, finiteNumber(value.time?.created)),
    activity,
    ticketKey: ticketMatch?.groups?.ticket ?? null,
  };
};

const fetchJson = async (fetchImpl, url, options, label) => {
  const response = await fetchImpl(url, options);
  if (!response.ok) throw new Error(`${label} failed (${response.status})`);
  return response.json();
};

const settleWithConcurrency = async (items, concurrency, mapper) => {
  const results = [];
  for (let index = 0; index < items.length; index += concurrency) {
    const batch = items.slice(index, index + concurrency);
    results.push(...await Promise.allSettled(batch.map((item) => mapper(item))));
  }
  return results;
};

const buildDirectoryOpenCodeUrl = (buildOpenCodeUrl, path, directory, query = {}) => {
  const url = new URL(buildOpenCodeUrl('/session', ''));
  url.pathname = path;
  url.searchParams.set('directory', directory);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url;
};

const listEmployeeSessions = async ({ employee, fetchImpl, buildOpenCodeUrl, getOpenCodeAuthHeaders }) => {
  const sessions = [];
  const seenIds = new Set();
  let cursor;
  let complete = true;
  for (let page = 0; page < MAX_SESSION_PAGES; page += 1) {
    const url = buildDirectoryOpenCodeUrl(buildOpenCodeUrl, '/experimental/session', employee.directory, {
      archived: true,
      roots: true,
      limit: SESSION_PAGE_SIZE,
      cursor,
    });
    const payload = await fetchJson(fetchImpl, url, {
      method: 'GET',
      headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
      signal: AbortSignal.timeout(5000),
    }, `Company Office sessions for ${employee.id}`);
    if (!Array.isArray(payload)) throw new Error(`Invalid Company Office sessions for ${employee.id}`);
    for (const value of payload) {
      if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim() || value.id !== value.id.trim()) {
        complete = false;
        continue;
      }
      if (value.parentID || value.time?.archived) continue;
      if (typeof value.directory !== 'string' || !value.directory.trim()) {
        complete = false;
        continue;
      }
      let session;
      try {
        session = normalizeSession(value, employee.directory, {});
      } catch {
        complete = false;
        continue;
      }
      if (session && !seenIds.has(session.id)) {
        seenIds.add(session.id);
        sessions.push(session);
      }
    }
    if (payload.length < SESSION_PAGE_SIZE) break;
    const nextCursor = payload.at(-1)?.time?.updated;
    if (!Number.isFinite(nextCursor) || nextCursor === cursor) {
      complete = false;
      break;
    }
    if (payload.filter((session) => session?.time?.updated === nextCursor).length > 1) {
      // OpenCode's cursor is timestamp-only and excludes the whole boundary on
      // the next page, so ties at a full-page cutoff cannot be proven complete.
      complete = false;
    }
    cursor = nextCursor;
    if (page === MAX_SESSION_PAGES - 1) complete = false;
  }
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  return { sessions, complete };
};

const listEmployeeActivity = async ({ employee, fetchImpl, buildOpenCodeUrl, getOpenCodeAuthHeaders }) => {
  const url = buildDirectoryOpenCodeUrl(buildOpenCodeUrl, '/session/status', employee.directory);
  const payload = await fetchJson(fetchImpl, url, {
    method: 'GET',
    headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
    signal: AbortSignal.timeout(5000),
  }, `Company Office activity for ${employee.id}`);
  if (!isRecord(payload)) throw new Error(`Invalid Company Office activity for ${employee.id}`);
  const statusById = {};
  let complete = true;
  for (const [sessionId, status] of Object.entries(payload)) {
    const validSimpleStatus = isRecord(status) && (status.type === 'idle' || status.type === 'busy');
    const validRetryStatus = isRecord(status)
      && status.type === 'retry'
      && Number.isFinite(status.attempt)
      && typeof status.message === 'string'
      && Number.isFinite(status.next);
    if (!sessionId.trim() || sessionId !== sessionId.trim() || (!validSimpleStatus && !validRetryStatus)) {
      complete = false;
      continue;
    }
    statusById[sessionId] = status;
  }
  return { statusById, complete };
};

const buildInitiatives = ({ issues, sessionsByTicket, initiativeIssueTypes }) => {
  const initiativeTypes = new Set(initiativeIssueTypes.map((type) => type.toLowerCase()));
  return issues.filter((issue) => initiativeTypes.has(issue.type.toLowerCase())).map((initiative) => {
    const tickets = issues
      .filter((issue) => issue.parentKey === initiative.key)
      .map((issue) => {
        const candidates = sessionsByTicket.get(issue.key) ?? [];
        return {
          ...issue,
          session: candidates.length === 1 ? candidates[0] : null,
          mapping: candidates.length === 1 ? 'reconstructed' : candidates.length > 1 ? 'ambiguous' : 'none',
        };
      });
    const counts = tickets.reduce((result, issue) => {
      const key = issue.status.toLowerCase().replace(/\s+/g, '-');
      result[key] = (result[key] ?? 0) + 1;
      return result;
    }, {});
    return { ...initiative, tickets, counts };
  });
};

export const createCompanyOfficeService = ({
  fsPromises,
  fetchImpl = globalThis.fetch,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  configPath,
}) => ({
  isConfigured: () => typeof configPath === 'string' && configPath.trim().length > 0,
  getSnapshot: async () => {
    if (typeof configPath !== 'string' || !configPath.trim()) {
      const error = new Error('Company Office is not configured');
      error.code = 'NOT_CONFIGURED';
      throw error;
    }

    const rawConfig = JSON.parse(await fsPromises.readFile(configPath, 'utf8'));
    const config = parseCompanyOfficeConfig(rawConfig);
    const [manifestText, registryText] = await Promise.all([
      fsPromises.readFile(config.roster.manifestPath, 'utf8'),
      fsPromises.readFile(config.roster.registryPath, 'utf8'),
    ]);
    const roster = parseRoster(parseYaml(manifestText), JSON.parse(registryText));

    const [sessionResults, activityResults] = await Promise.all([
      settleWithConcurrency(roster.employees, EMPLOYEE_READ_CONCURRENCY, (employee) => listEmployeeSessions({
        employee,
        fetchImpl,
        buildOpenCodeUrl,
        getOpenCodeAuthHeaders,
      })),
      settleWithConcurrency(roster.employees, EMPLOYEE_READ_CONCURRENCY, (employee) => listEmployeeActivity({
        employee,
        fetchImpl,
        buildOpenCodeUrl,
        getOpenCodeAuthHeaders,
      })),
    ]);
    const sessionsByTicket = new Map();
    const employees = roster.employees.map((employee, index) => {
      const result = sessionResults[index];
      const activityResult = activityResults[index];
      const statusById = activityResult.status === 'fulfilled' ? activityResult.value.statusById : {};
      const activityComplete = activityResult.status === 'fulfilled' && activityResult.value.complete;
      const sessions = result.status === 'fulfilled'
        ? result.value.sessions.map((session) => ({
          ...session,
          activity: statusById[session.id]?.type === 'busy' || statusById[session.id]?.type === 'retry'
            ? 'busy'
            : activityComplete
              ? 'idle'
              : 'unknown',
        }))
        : [];
      for (const session of sessions) {
        if (!session.ticketKey) continue;
        const candidates = sessionsByTicket.get(session.ticketKey) ?? [];
        candidates.push({ id: session.id, title: session.title, directory: session.directory });
        sessionsByTicket.set(session.ticketKey, candidates);
      }
      return {
        ...employee,
        sessionsAvailable: result.status === 'fulfilled',
        activityAvailable: activityComplete,
        activity: Object.values(statusById).some((status) => status?.type === 'busy' || status?.type === 'retry')
          ? 'busy'
          : activityComplete
            ? 'idle'
            : 'unknown',
        sessions,
      };
    });

    const workTracker = createJiraWorkTracker({ config: config.workTracker.jira, fsPromises, fetchImpl });
    let trackerIssues = [];
    let trackerState = 'ready';
    try {
      const trackerResult = await workTracker.loadSnapshot();
      trackerIssues = trackerResult.issues;
      trackerState = trackerResult.state;
    } catch {
      trackerState = 'error';
    }

    const intakeEmployee = employees.find((employee) => employee.id === config.intake.employeeId) ?? null;
    const intakeSession = intakeEmployee?.sessions.find((session) => session.title === config.intake.sessionTitle) ?? null;
    const sessionFailures = sessionResults.filter((result) => result.status === 'rejected').length;
    const sessionTruncations = sessionResults.filter((result) => result.status === 'fulfilled' && !result.value.complete).length;
    const activityFailures = activityResults.filter((result) => result.status === 'rejected').length;
    const activityTruncations = activityResults.filter((result) => result.status === 'fulfilled' && !result.value.complete).length;

    return {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      company: {
        id: config.company.id,
        displayName: config.company.displayName,
        ceo: roster.ceo,
        jiraProjectUrl: workTracker.projectUrl,
      },
      sources: {
        roster: 'ready',
        sessions: sessionFailures === employees.length
          ? 'error'
          : sessionFailures > 0 || sessionTruncations > 0
            ? 'partial'
            : 'ready',
        activity: activityFailures === employees.length
          ? 'error'
          : activityFailures > 0 || activityTruncations > 0
            ? 'partial'
            : 'ready',
        jira: trackerState,
      },
      mappingMode: 'reconstructed',
      intakeSession: intakeSession ? {
        id: intakeSession.id,
        title: intakeSession.title,
        directory: intakeSession.directory,
      } : null,
      employees,
      initiatives: trackerState !== 'error' ? buildInitiatives({
        issues: trackerIssues,
        sessionsByTicket,
        initiativeIssueTypes: workTracker.initiativeIssueTypes,
      }) : [],
    };
  },
});

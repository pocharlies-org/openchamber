import { runtimeFetch } from '@/lib/runtime-fetch';

type CompanyOfficeSourceState = 'ready' | 'partial' | 'error';
export type CompanyOfficeActivity = 'busy' | 'idle' | 'unknown';
type CompanyOfficeMapping = 'reconstructed' | 'ambiguous' | 'none';

type CompanyOfficeSession = {
  id: string;
  title: string;
  directory: string;
  updatedAt: number;
  activity: CompanyOfficeActivity;
  ticketKey: string | null;
};

type CompanyOfficeEmployee = {
  id: string;
  name: string;
  role: string;
  title: string;
  specialty: string | null;
  model: string;
  directory: string;
  sessionsAvailable: boolean;
  activityAvailable: boolean;
  activity: CompanyOfficeActivity;
  sessions: CompanyOfficeSession[];
};

type CompanyOfficeTicket = {
  key: string;
  summary: string;
  status: string;
  type: string;
  assignee: string | null;
  parentKey: string | null;
  updatedAt: string | null;
  url: string;
  session: Pick<CompanyOfficeSession, 'id' | 'title' | 'directory'> | null;
  mapping: CompanyOfficeMapping;
};

type CompanyOfficeInitiative = Omit<CompanyOfficeTicket, 'session' | 'mapping'> & {
  tickets: CompanyOfficeTicket[];
  counts: Record<string, number>;
};

export type CompanyOfficeSnapshot = {
  schemaVersion: 1;
  generatedAt: string;
  company: {
    id: string;
    displayName: string;
    ceo: string;
    jiraProjectUrl: string;
  };
  sources: {
    roster: CompanyOfficeSourceState;
    sessions: CompanyOfficeSourceState;
    activity: CompanyOfficeSourceState;
    jira: CompanyOfficeSourceState;
  };
  mappingMode: 'reconstructed';
  intakeSession: Pick<CompanyOfficeSession, 'id' | 'title' | 'directory'> | null;
  employees: CompanyOfficeEmployee[];
  initiatives: CompanyOfficeInitiative[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const isString = (value: unknown): value is string => typeof value === 'string';
const isNullableString = (value: unknown): value is string | null => value === null || isString(value);
const isActivity = (value: unknown): value is CompanyOfficeActivity => value === 'busy' || value === 'idle' || value === 'unknown';
const isSourceState = (value: unknown): value is CompanyOfficeSourceState => value === 'ready' || value === 'partial' || value === 'error';
const isMapping = (value: unknown): value is CompanyOfficeMapping => value === 'reconstructed' || value === 'ambiguous' || value === 'none';

const parseSession = (value: unknown): CompanyOfficeSession => {
  if (!isRecord(value) || !isString(value.id) || !isString(value.title) || !isString(value.directory)
    || typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt) || !isActivity(value.activity)
    || !isNullableString(value.ticketKey)) {
    throw new Error('Invalid Company Office session');
  }
  return {
    id: value.id,
    title: value.title,
    directory: value.directory,
    updatedAt: value.updatedAt,
    activity: value.activity,
    ticketKey: value.ticketKey,
  };
};

const parseSessionRef = (value: unknown): Pick<CompanyOfficeSession, 'id' | 'title' | 'directory'> | null => {
  if (value === null) return null;
  if (!isRecord(value) || !isString(value.id) || !isString(value.title) || !isString(value.directory)) {
    throw new Error('Invalid Company Office session reference');
  }
  return { id: value.id, title: value.title, directory: value.directory };
};

const parseIssue = (value: unknown, jiraOrigin: string) => {
  if (!isRecord(value) || !isString(value.key) || !isString(value.summary) || !isString(value.status)
    || !isString(value.type) || !isNullableString(value.assignee) || !isNullableString(value.parentKey)
    || !isNullableString(value.updatedAt) || !isString(value.url)) {
    throw new Error('Invalid Company Office issue');
  }
  const url = new URL(value.url);
  if (url.protocol !== 'https:' || url.origin !== jiraOrigin || url.pathname !== `/browse/${encodeURIComponent(value.key)}`
    || url.search || url.hash) {
    throw new Error('Invalid Company Office issue URL');
  }
  return {
    key: value.key,
    summary: value.summary,
    status: value.status,
    type: value.type,
    assignee: value.assignee,
    parentKey: value.parentKey,
    updatedAt: value.updatedAt,
    url: url.toString(),
  };
};

export const parseCompanyOfficeSnapshot = (value: unknown): CompanyOfficeSnapshot => {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isString(value.generatedAt)
    || !isRecord(value.company) || !isRecord(value.sources) || value.mappingMode !== 'reconstructed'
    || !Array.isArray(value.employees) || !Array.isArray(value.initiatives)
    || !isString(value.company.id) || !isString(value.company.displayName) || !isString(value.company.ceo)
    || !isString(value.company.jiraProjectUrl)
    || !isSourceState(value.sources.roster) || !isSourceState(value.sources.sessions)
    || !isSourceState(value.sources.activity) || !isSourceState(value.sources.jira)) {
    throw new Error('Invalid Company Office snapshot');
  }
  if (!Number.isFinite(Date.parse(value.generatedAt))) {
    throw new Error('Invalid Company Office generatedAt');
  }
  const jiraProjectUrl = new URL(value.company.jiraProjectUrl);
  if (jiraProjectUrl.protocol !== 'https:' || !jiraProjectUrl.pathname.startsWith('/browse/')
    || jiraProjectUrl.search || jiraProjectUrl.hash) {
    throw new Error('Invalid Company Office Jira project URL');
  }

  const employees = value.employees.map((employee) => {
    if (!isRecord(employee) || !isString(employee.id) || !isString(employee.name) || !isString(employee.role)
      || !isString(employee.title) || !isNullableString(employee.specialty) || !isString(employee.model)
      || !isString(employee.directory) || typeof employee.sessionsAvailable !== 'boolean'
      || typeof employee.activityAvailable !== 'boolean' || !isActivity(employee.activity)
      || !Array.isArray(employee.sessions)) {
      throw new Error('Invalid Company Office employee');
    }
    return {
      id: employee.id,
      name: employee.name,
      role: employee.role,
      title: employee.title,
      specialty: employee.specialty,
      model: employee.model,
      directory: employee.directory,
      sessionsAvailable: employee.sessionsAvailable,
      activityAvailable: employee.activityAvailable,
      activity: employee.activity,
      sessions: employee.sessions.map(parseSession),
    };
  });

  const initiatives = value.initiatives.map((initiative) => {
    const issue = parseIssue(initiative, jiraProjectUrl.origin);
    if (!isRecord(initiative) || !Array.isArray(initiative.tickets) || !isRecord(initiative.counts)) {
      throw new Error('Invalid Company Office initiative');
    }
    return {
      ...issue,
      tickets: initiative.tickets.map((ticket) => {
        const parsed = parseIssue(ticket, jiraProjectUrl.origin);
        if (!isRecord(ticket) || !isMapping(ticket.mapping)) throw new Error('Invalid Company Office ticket');
        return { ...parsed, mapping: ticket.mapping, session: parseSessionRef(ticket.session) };
      }),
      counts: Object.fromEntries(Object.entries(initiative.counts).map(([key, count]) => {
        if (typeof count !== 'number' || !Number.isFinite(count)) throw new Error('Invalid Company Office counts');
        return [key, count];
      })),
    };
  });

  return {
    schemaVersion: 1,
    generatedAt: value.generatedAt,
    company: {
      id: value.company.id,
      displayName: value.company.displayName,
      ceo: value.company.ceo,
      jiraProjectUrl: jiraProjectUrl.toString(),
    },
    sources: {
      roster: value.sources.roster,
      sessions: value.sources.sessions,
      activity: value.sources.activity,
      jira: value.sources.jira,
    },
    mappingMode: 'reconstructed',
    intakeSession: parseSessionRef(value.intakeSession),
    employees,
    initiatives,
  };
};

export const loadCompanyOfficeSnapshot = async (endpoint: '/api/company-office/snapshot', signal?: AbortSignal): Promise<CompanyOfficeSnapshot> => {
  const response = await runtimeFetch(endpoint, { signal });
  if (!response.ok) throw new Error(`Company Office snapshot failed (${response.status})`);
  return parseCompanyOfficeSnapshot(await response.json());
};

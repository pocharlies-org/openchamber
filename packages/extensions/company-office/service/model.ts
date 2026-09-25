/**
 * The company, as the panel shows it, from the systems that own it.
 *
 * The supervisor (`jira-epic-trigger`) decides everything: which epic runs,
 * which waits, which session a CTO lives in. Jira owns titles and workflow
 * status; role definitions live as Claude Code agents. This module only joins
 * those answers into one read-only overview. Nothing here launches, resumes or
 * moves anything: the company is driven from Jira and the supervisor, never
 * from this panel.
 */

export type RoleDefinition = {
  id: string;
  name: string;
  description: string;
  model: string | null;
};

export type JiraIssueSummary = {
  key: string;
  summary: string;
  status: string | null;
  statusCategory: string | null;
};

export type EpicRow = {
  key: string;
  /** The supervisor's own words for what it did with this epic in its last sweep. */
  state: string;
  /** Claude Code session the epic runs in; open as `ses_ccc<sessionId>`. */
  sessionId: string | null;
  live: boolean;
  queuePosition: number | null;
  questionPending: boolean;
  reason: string | null;
  difficulty: string | null;
  resumes24h: number;
  title: string | null;
  jiraStatus: string | null;
  jiraStatusCategory: string | null;
};

export type CompanyStatus = {
  on: boolean;
  dryRun: boolean;
  llmStopped: boolean;
  running: number;
  runningIt: number;
  limit: number | null;
  queued: number;
  sweptAt: string | null;
};

export type Overview = {
  status: CompanyStatus | null;
  epics: EpicRow[];
  roster: RoleDefinition[];
  /** Base of an issue's Jira page: `${jiraBrowse}/${key}`. */
  jiraBrowse: string;
  errors: { supervisor?: string; jira?: string; roster?: string };
  fetchedAt: number;
};

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** `activas` and the queues hold epic keys; older states stored `{ key }` records. */
const keysOf = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [])
    .map((entry) => (typeof entry === 'string' ? entry : isRecord(entry) ? str(entry.key) : null))
    .filter((key): key is string => Boolean(key));

/** The frontmatter fields the roster shows, from a Claude Code agent file. */
export const parseRoleDefinition = (fileName: string, text: string): RoleDefinition | null => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return null;
  const fields = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!field) continue;
    fields.set(field[1], field[2].trim().replace(/^(["'])(.*)\1$/, '$2'));
  }
  const name = fields.get('name') || fileName.replace(/\.md$/, '');
  if (!name.startsWith('company-')) return null;
  return {
    id: name,
    name: name.slice('company-'.length),
    description: fields.get('description') || '',
    model: fields.get('model') || null,
  };
};

export const toCompanyStatus = (state: unknown): CompanyStatus | null => {
  if (!isRecord(state)) return null;
  return {
    on: state.encendida === true,
    dryRun: state.dry_run === true,
    llmStopped: state.llm_parado === true,
    running: keysOf(state.activas).length,
    runningIt: keysOf(state.activas_it).length,
    limit: num(state.tope_dinamico) ?? num(state.max_activas),
    queued: keysOf(state.en_cola).length + keysOf(state.en_cola_it).length,
    sweptAt: str(state.barrido_at),
  };
};

/**
 * One row per epic the supervisor reported on, live ones first, then the
 * queue in its order, then everything else by key.
 */
export const toEpicRows = (
  state: unknown,
  epicsPayload: unknown,
  issues: ReadonlyMap<string, JiraIssueSummary>,
): EpicRow[] => {
  const live = new Set([...keysOf(isRecord(state) ? state.activas : null), ...keysOf(isRecord(state) ? state.activas_it : null)]);
  const list = isRecord(epicsPayload) && Array.isArray(epicsPayload.epics) ? epicsPayload.epics : [];
  const rows: EpicRow[] = [];
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const key = str(entry.key);
    if (!key) continue;
    const issue = issues.get(key);
    rows.push({
      key,
      state: str(entry.estado) ?? '',
      sessionId: str(entry.sid),
      live: live.has(key),
      queuePosition: num(entry.cola_pos),
      questionPending: entry.pregunta_pendiente === true,
      reason: str(entry.motivo),
      difficulty: str(entry.dificultad_letra) ?? str(entry.dificultad),
      resumes24h: num(entry.reanudaciones_24h) ?? 0,
      title: issue?.summary ?? null,
      jiraStatus: issue?.status ?? null,
      jiraStatusCategory: issue?.statusCategory ?? null,
    });
  }
  const rank = (row: EpicRow): number => (row.live ? 0 : row.queuePosition !== null ? 1 : 2);
  return rows.sort((a, b) =>
    rank(a) - rank(b)
    || (a.queuePosition ?? 0) - (b.queuePosition ?? 0)
    || a.key.localeCompare(b.key, 'en', { numeric: true }));
};

/** Jira's search answer, reduced to what the panel shows. */
export const toIssueSummaries = (payload: unknown): Map<string, JiraIssueSummary> => {
  const out = new Map<string, JiraIssueSummary>();
  const issues = isRecord(payload) && Array.isArray(payload.issues) ? payload.issues : [];
  for (const issue of issues) {
    if (!isRecord(issue) || !isRecord(issue.fields)) continue;
    const key = str(issue.key);
    if (!key) continue;
    const status = isRecord(issue.fields.status) ? issue.fields.status : null;
    out.set(key, {
      key,
      summary: str(issue.fields.summary) ?? key,
      status: status ? str(status.name) : null,
      statusCategory: status && isRecord(status.statusCategory) ? str(status.statusCategory.key) : null,
    });
  }
  return out;
};

const MAX_JIRA_PAGES = 5;
const MAX_ISSUES = 500;

const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const optionalString = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;

const fetchJson = async (fetchImpl, url, options) => {
  const response = await fetchImpl(url, options);
  if (!response.ok) throw new Error(`Company Office Jira search failed (${response.status})`);
  return response.json();
};

const normalizeIssue = (issue, baseUrl) => {
  if (!isRecord(issue) || !isRecord(issue.fields)) return null;
  const key = optionalString(issue.key);
  const summary = optionalString(issue.fields.summary);
  if (!key || !summary) return null;
  return {
    key,
    summary: summary.slice(0, 300),
    status: optionalString(issue.fields.status?.name) ?? 'Unknown',
    type: optionalString(issue.fields.issuetype?.name) ?? 'Unknown',
    assignee: optionalString(issue.fields.assignee?.displayName),
    parentKey: optionalString(issue.fields.parent?.key),
    updatedAt: optionalString(issue.fields.updated),
    url: `${baseUrl}/browse/${encodeURIComponent(key)}`,
  };
};

export const createJiraWorkTracker = ({ config, fsPromises, fetchImpl = globalThis.fetch }) => ({
  id: 'jira',
  projectKey: config.projectKey,
  projectUrl: `${config.baseUrl}/browse/${encodeURIComponent(config.projectKey)}`,
  initiativeIssueTypes: config.initiativeIssueTypes,
  loadSnapshot: async () => {
    const token = (await fsPromises.readFile(config.tokenFile, 'utf8')).trim();
    if (!token) throw new Error('Empty Company Office Jira token');
    const issues = [];
    let nextPageToken = null;
    let incomplete = false;
    for (let page = 0; page < MAX_JIRA_PAGES && issues.length < MAX_ISSUES; page += 1) {
      const url = new URL('/rest/api/3/search/jql', config.baseUrl);
      url.searchParams.set('jql', `project = ${config.projectKey} ORDER BY key ASC`);
      url.searchParams.set('fields', 'summary,status,issuetype,assignee,parent,updated');
      url.searchParams.set('maxResults', '100');
      if (nextPageToken) url.searchParams.set('nextPageToken', nextPageToken);
      const payload = await fetchJson(fetchImpl, url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Basic ${Buffer.from(`${config.email}:${token}`).toString('base64')}`,
        },
        signal: AbortSignal.timeout(8000),
      });
      if (!isRecord(payload) || !Array.isArray(payload.issues)) {
        throw new Error('Invalid Company Office Jira response');
      }
      issues.push(...payload.issues.slice(0, MAX_ISSUES - issues.length));
      nextPageToken = optionalString(payload.nextPageToken);
      if (!nextPageToken) {
        if (payload.isLast === false) incomplete = true;
        break;
      }
    }
    const normalized = issues.map((issue) => normalizeIssue(issue, config.baseUrl));
    return {
      state: incomplete || nextPageToken || normalized.some((issue) => issue === null) ? 'partial' : 'ready',
      issues: normalized.filter(Boolean),
    };
  },
});

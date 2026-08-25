const MAX_JIRA_PAGES = 5;
const MAX_ISSUES = 500;
const MAX_ACCEPTANCE_CRITERIA = 2000;
const MAX_ADF_DEPTH = 12;
const MAX_SESSION_ID = 120;
const MAX_REPO_PATH = 400;
const MAX_COMMENT_CHARS = 30000;

const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const optionalString = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;

const ADF_BLOCK_TYPES = new Set(['paragraph', 'heading', 'listItem', 'blockquote', 'codeBlock', 'panel', 'tableRow']);

// Acceptance criteria arrive either as a plain-text custom field or as an
// Atlassian Document Format tree. Both collapse to bounded plain text: the
// browser DTO must never carry a raw upstream payload.
const flattenAdf = (node, depth) => {
  if (depth > MAX_ADF_DEPTH || !isRecord(node)) return '';
  if (node.type === 'text') return typeof node.text === 'string' ? node.text : '';
  if (node.type === 'hardBreak' || node.type === 'rule') return '\n';
  if (!Array.isArray(node.content)) return '';
  const inner = node.content.map((child) => flattenAdf(child, depth + 1)).join('');
  return ADF_BLOCK_TYPES.has(node.type) ? `${inner}\n` : inner;
};

const normalizeAcceptanceCriteria = (value) => {
  const text = typeof value === 'string' ? value : isRecord(value) ? flattenAdf(value, 0) : '';
  const collapsed = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return collapsed ? collapsed.slice(0, MAX_ACCEPTANCE_CRITERIA) : null;
};

const fetchJson = async (fetchImpl, url, options) => {
  const response = await fetchImpl(url, options);
  if (!response.ok) throw new Error(`Company Office Jira search failed (${response.status})`);
  return response.json();
};

// A Jira custom field can hold a plain string or an ADF/option object; only a
// bounded plain string is useful as a session pointer or a repository path.
const normalizeFieldText = (value, limit) => {
  const text = typeof value === 'string' ? value : isRecord(value) ? flattenAdf(value, 0) : '';
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed ? collapsed.slice(0, limit) : null;
};

const normalizeIssue = (issue, baseUrl, fields) => {
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
    assigneeAccountId: optionalString(issue.fields.assignee?.accountId),
    reporter: optionalString(issue.fields.reporter?.displayName),
    parentKey: optionalString(issue.fields.parent?.key),
    updatedAt: optionalString(issue.fields.updated),
    url: `${baseUrl}/browse/${encodeURIComponent(key)}`,
    acceptanceCriteria: fields.acceptanceCriteriaField
      ? normalizeAcceptanceCriteria(issue.fields[fields.acceptanceCriteriaField])
      : null,
    // Recorded link, not a title heuristic: this is what makes the mapping canonical.
    sessionId: fields.sessionField
      ? normalizeFieldText(issue.fields[fields.sessionField], MAX_SESSION_ID)
      : null,
    repo: fields.repoField
      ? normalizeFieldText(issue.fields[fields.repoField], MAX_REPO_PATH)
      : null,
  };
};

const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;
const PROJECT_KEY = /^[A-Z][A-Z0-9_]*$/;

const requireIssueKey = (key) => {
  const trimmed = optionalString(key);
  if (!trimmed || !ISSUE_KEY.test(trimmed)) throw new Error(`Invalid Jira issue key: ${String(key)}`);
  return trimmed;
};

const asAdfDocument = (text) => ({
  type: 'doc',
  version: 1,
  content: text.split('\n').map((line) => ({
    type: 'paragraph',
    ...(line ? { content: [{ type: 'text', text: line }] } : {}),
  })),
});

export const createJiraWorkTracker = ({ config, fsPromises, fetchImpl = globalThis.fetch }) => {
  const authHeaders = async () => {
    const token = (await fsPromises.readFile(config.tokenFile, 'utf8')).trim();
    if (!token) throw new Error('Empty Company Office Jira token');
    return {
      Accept: 'application/json',
      Authorization: `Basic ${Buffer.from(`${config.email}:${token}`).toString('base64')}`,
    };
  };

  // Deliberately narrow: comment, transition and record-the-session. An agent gets
  // these three verbs and nothing else, so bash never needs the Jira token and no
  // role can rewrite scope, assignee or acceptance criteria.
  const write = async (path, body, label) => {
    const response = await fetchImpl(new URL(path, config.baseUrl), {
      method: 'POST',
      headers: { ...await authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`${label} failed (${response.status})`);
    return response;
  };

  return {
  id: 'jira',
  projectKey: config.projectKey,
  projectUrl: `${config.baseUrl}/browse/${encodeURIComponent(config.projectKey)}`,
  initiativeIssueTypes: config.initiativeIssueTypes,
  supportsSessionField: Boolean(config.sessionField),
  supportsRepoField: Boolean(config.repoField),

  /** The agent's report. Jira is the bus, so progress is a comment, not a whisper. */
  addComment: async (issueKey, text) => {
    const key = requireIssueKey(issueKey);
    const body = optionalString(text);
    if (!body) throw new Error(`Refusing to post an empty Jira comment on ${key}`);
    await write(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
      body: asAdfDocument(body.slice(0, MAX_COMMENT_CHARS)),
    }, `Jira comment on ${key}`);
    return { key, state: 'ready' };
  },

  /**
   * Resolves a transition by TARGET STATUS NAME, asking Jira which transitions
   * this issue actually offers right now.
   *
   * Transition ids are per-issue and per-workflow, so a hand-configured id is a
   * silent breakage waiting for the first workflow edit. Refusing when the target
   * is unavailable is also the correct answer: it means the workflow does not
   * allow that move from where the issue currently is.
   */
  transitionTo: async (issueKey, statusName) => {
    const key = requireIssueKey(issueKey);
    const target = optionalString(statusName);
    if (!target) throw new Error(`Refusing to transition ${key} without a target status`);

    const response = await fetchImpl(new URL(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, config.baseUrl), {
      method: 'GET',
      headers: await authHeaders(),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`Jira transitions lookup on ${key} failed (${response.status})`);
    const payload = await response.json();
    if (!isRecord(payload) || !Array.isArray(payload.transitions)) {
      throw new Error(`Invalid Jira transitions response for ${key}`);
    }

    const wanted = target.toLowerCase();
    const match = payload.transitions.find((t) => optionalString(t?.to?.name)?.toLowerCase() === wanted);
    if (!match || !optionalString(match.id)) {
      const offered = payload.transitions.map((t) => optionalString(t?.to?.name)).filter(Boolean);
      throw new Error(`Jira has no transition from ${key} to "${target}" (offers: ${offered.join(', ') || 'none'})`);
    }

    await write(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
      transition: { id: match.id },
    }, `Jira transition on ${key}`);
    return { key, to: target, transitionId: match.id, state: 'ready' };
  },

  transition: async (issueKey, transitionId) => {
    const key = requireIssueKey(issueKey);
    const id = optionalString(transitionId);
    if (!id) throw new Error(`Refusing to transition ${key} without a transition id`);
    await write(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
      transition: { id },
    }, `Jira transition on ${key}`);
    return { key, state: 'ready' };
  },

  /** Writes the ticket->session pointer that replaces the title heuristic. */
  recordSession: async (issueKey, sessionId) => {
    const key = requireIssueKey(issueKey);
    if (!config.sessionField) throw new Error('Jira sessionField is not configured');
    const id = optionalString(sessionId);
    if (!id) throw new Error(`Refusing to record an empty session on ${key}`);
    const response = await fetchImpl(new URL(`/rest/api/3/issue/${encodeURIComponent(key)}`, config.baseUrl), {
      method: 'PUT',
      headers: { ...await authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { [config.sessionField]: id.slice(0, MAX_SESSION_ID) } }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`Jira session record on ${key} failed (${response.status})`);
    return { key, sessionId: id, state: 'ready' };
  },

  loadSnapshot: async ({ projectKeys = null } = {}) => {
    const selectedProjectKeys = projectKeys === null ? [config.projectKey] : projectKeys;
    if (!Array.isArray(selectedProjectKeys) || selectedProjectKeys.some((key) => !PROJECT_KEY.test(key))) {
      throw new Error('Invalid Company Office Jira project selection');
    }
    if (selectedProjectKeys.length === 0) return { state: 'ready', issues: [] };
    const uniqueProjectKeys = [...new Set(selectedProjectKeys)];
    const projectJql = uniqueProjectKeys.length === 1
      ? `project = ${uniqueProjectKeys[0]}`
      : `project in (${uniqueProjectKeys.join(', ')})`;
    const headers = await authHeaders();
    const issues = [];
    let nextPageToken = null;
    let incomplete = false;
    for (let page = 0; page < MAX_JIRA_PAGES && issues.length < MAX_ISSUES; page += 1) {
      const url = new URL('/rest/api/3/search/jql', config.baseUrl);
      url.searchParams.set('jql', `${projectJql} ORDER BY key ASC`);
      url.searchParams.set('fields', [
        'summary', 'status', 'issuetype', 'assignee', 'reporter', 'parent', 'updated',
        ...[config.acceptanceCriteriaField, config.sessionField, config.repoField].filter(Boolean),
      ].join(','));
      url.searchParams.set('maxResults', '100');
      if (nextPageToken) url.searchParams.set('nextPageToken', nextPageToken);
      const payload = await fetchJson(fetchImpl, url, {
        method: 'GET',
        headers,
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
    const normalized = issues.map((issue) => normalizeIssue(issue, config.baseUrl, config));
    return {
      state: incomplete || nextPageToken || normalized.some((issue) => issue === null) ? 'partial' : 'ready',
      issues: normalized.filter(Boolean),
    };
  },
  };
};

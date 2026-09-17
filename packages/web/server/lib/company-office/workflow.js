const MAX_TYPES = 20;
const MAX_NAME_CHARS = 80;

const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');

const requiredName = (value, field) => {
  const text = trimmed(value);
  if (!text) throw new Error(`Invalid workflow config: ${field}`);
  if (text.length > MAX_NAME_CHARS) throw new Error(`Invalid workflow config: ${field} exceeds ${MAX_NAME_CHARS} characters`);
  return text;
};

const lower = (value) => trimmed(value).toLowerCase();

/**
 * Which role owns which Jira issue type, and where the work goes when that role
 * finishes.
 *
 * This is configuration held in the app and validated here, never a hand-edited
 * mapping: an unaudited type-to-role table is how a subtask ends up dispatched
 * to the wrong permission boundary.
 *
 * Jira already enforces the shape of the tree — a subtask can only hang from a
 * standard issue, which can only hang from an epic — so this config never has to
 * describe the hierarchy, only who works each level and who validates it.
 */
export const parseWorkflowConfig = (value, { roleIds = null } = {}) => {
  const list = isRecord(value) ? value.issueTypes : value;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('Invalid workflow config: issueTypes must be a non-empty array');
  }
  if (list.length > MAX_TYPES) {
    throw new Error(`Invalid workflow config: exceeds ${MAX_TYPES} issue types`);
  }

  const entries = list.map((entry, index) => {
    const field = `issueTypes[${index}]`;
    if (!isRecord(entry)) throw new Error(`Invalid workflow config: ${field}`);

    const type = requiredName(entry.type, `${field}.type`);
    const role = requiredName(entry.role, `${field}.role`);
    if (roleIds && !roleIds.has(role)) {
      throw new Error(`Invalid workflow config: ${field}.role "${role}" is not a configured role`);
    }

    // Nobody ships without a pull request, and a pull request needs the CTO plus
    // the role that owns this level. The list is configuration so a company can
    // change its gate without editing code, but it is validated here so an
    // unaudited entry cannot quietly remove an approver.
    const approvals = entry.approvals === undefined || entry.approvals === null
      ? []
      : (() => {
        if (!Array.isArray(entry.approvals)) throw new Error(`Invalid workflow config: ${field}.approvals`);
        const seen = entry.approvals.map((role, i) => {
          const id = requiredName(role, `${field}.approvals[${i}]`);
          if (roleIds && !roleIds.has(id)) {
            throw new Error(`Invalid workflow config: ${field}.approvals[${i}] "${id}" is not a configured role`);
          }
          return id;
        });
        if (new Set(seen).size !== seen.length) {
          throw new Error(`Invalid workflow config: duplicate approver in ${field}.approvals`);
        }
        return seen;
      })();

    let onDone = null;
    if (entry.onDone !== undefined && entry.onDone !== null) {
      if (!isRecord(entry.onDone)) throw new Error(`Invalid workflow config: ${field}.onDone`);
      const status = requiredName(entry.onDone.status, `${field}.onDone.status`);
      const validatedBy = entry.onDone.validatedBy === undefined || entry.onDone.validatedBy === null
        ? null
        : requiredName(entry.onDone.validatedBy, `${field}.onDone.validatedBy`);
      if (roleIds && validatedBy && !roleIds.has(validatedBy)) {
        throw new Error(`Invalid workflow config: ${field}.onDone.validatedBy "${validatedBy}" is not a configured role`);
      }
      onDone = { status, validatedBy };
    }

    return { type, role, onDone, approvals };
  });

  const types = entries.map((entry) => lower(entry.type));
  if (new Set(types).size !== types.length) {
    throw new Error('Invalid workflow config: duplicate issue type');
  }

  return {
    entries,
    byType: new Map(entries.map((entry) => [lower(entry.type), entry])),
    doneStatuses: new Set((isRecord(value) && Array.isArray(value.doneStatuses)
      ? value.doneStatuses
      : ['Done']).map(lower)),
  };
};

export const roleForIssue = (workflow, issue) => workflow.byType.get(lower(issue?.type))?.role ?? null;

/**
 * A parent advances only when it has children and every one of them is done.
 *
 * The "has children" guard is the important half: without it a story nobody has
 * broken down yet looks exactly like a story whose subtasks are all finished,
 * and would be pushed to validation having had no work done at all.
 */
export const findReadyToAdvance = (workflow, issues) => {
  const childrenOf = new Map();
  for (const issue of issues) {
    if (!issue?.parentKey) continue;
    if (!childrenOf.has(issue.parentKey)) childrenOf.set(issue.parentKey, []);
    childrenOf.get(issue.parentKey).push(issue);
  }

  const ready = [];
  const blocked = [];

  for (const issue of issues) {
    const entry = workflow.byType.get(lower(issue.type));
    if (!entry?.onDone) continue;

    const children = childrenOf.get(issue.key) ?? [];
    if (children.length === 0) continue;

    const pending = children.filter((child) => !workflow.doneStatuses.has(lower(child.status)));
    if (pending.length > 0) {
      blocked.push({ key: issue.key, pending: pending.map((child) => child.key) });
      continue;
    }

    // Already where it needs to be: advancing again would churn the ticket and
    // spam its history on every cycle.
    if (lower(issue.status) === lower(entry.onDone.status)) continue;
    if (workflow.doneStatuses.has(lower(issue.status))) continue;

    ready.push({
      key: issue.key,
      from: issue.status,
      to: entry.onDone.status,
      validatedBy: entry.onDone.validatedBy,
      children: children.map((child) => child.key),
    });
  }

  return { ready, blocked };
};

/**
 * Who must approve the pull request that closes this issue.
 *
 * `requiredApprover` is always included: no level ships on the owning role's own
 * say-so. An issue type with no configured approvals still needs that one, so a
 * missing entry cannot become an unreviewed merge.
 */
export const approversFor = (workflow, issue, { requiredApprover = 'cto' } = {}) => {
  const entry = workflow.byType.get(String(issue?.type ?? '').trim().toLowerCase());
  const configured = entry?.approvals ?? [];
  return [requiredApprover, ...configured.filter((role) => role !== requiredApprover)];
};

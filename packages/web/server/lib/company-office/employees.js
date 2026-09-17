import { readFileSync } from 'node:fs';

const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));

/**
 * Maps Jira assignee aliases to roster employees.
 *
 * Jira assignees are `me+<first name>` aliases of one mailbox; the roster is
 * the authority for which employee (and therefore which role and directory)
 * each alias is. Keyed by Jira accountId because that is what issues carry.
 *
 * Shared by the polling composition root and the webhook event dispatcher so a
 * single dispatch and a full cycle resolve the same alias the same way.
 */
export const buildEmployeesFromRegistry = (registryPath, issues) => {
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  const byAlias = new Map();
  for (const [id, entry] of Object.entries(registry)) {
    const first = entry.persona.split(' ')[0].toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '');
    byAlias.set(`me+${first}`, { id, role: entry.role, directory: entry.directory });
  }
  const employeesById = new Map();
  for (const issue of issues) {
    if (!isRecord(issue)) continue;
    const employee = byAlias.get((issue.assignee ?? '').toLowerCase());
    if (issue.assigneeAccountId && employee) employeesById.set(issue.assigneeAccountId, employee);
  }
  return employeesById;
};

/**
 * Resolves one issue's assignee to its employee, for a single-ticket dispatch.
 * Returns null when the assignee is not a known employee alias.
 */
export const employeeForIssue = (registryPath, issue) =>
  buildEmployeesFromRegistry(registryPath, [issue]).get(issue?.assigneeAccountId) ?? null;

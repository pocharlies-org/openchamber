const MAX_ROUTES = 100;
const MAX_NAME = 80;
const ACTIONS = new Set(['plan', 'design', 'implement', 'review', 'validate', 'deploy', 'approve', 'observe']);

const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const requiredName = (value, field) => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > MAX_NAME) throw new Error(`Invalid AIOPS config: ${field}`);
  return text;
};
const normalized = (value) => value.toLowerCase();

const parseRoute = (value, index, roleIds) => {
  if (!isRecord(value)) throw new Error(`Invalid AIOPS config: routes[${index}]`);
  const issueType = requiredName(value.issueType, `routes[${index}].issueType`);
  const status = requiredName(value.status, `routes[${index}].status`);
  const role = requiredName(value.role, `routes[${index}].role`).toLowerCase();
  const action = requiredName(value.action, `routes[${index}].action`).toLowerCase();
  if (roleIds && !roleIds.has(role)) throw new Error(`Invalid AIOPS config: unknown role "${role}"`);
  if (!ACTIONS.has(action)) throw new Error(`Invalid AIOPS config: unknown action "${action}"`);
  return { issueType, status, role, action };
};

export const parseAiopsRouting = (value, { roleIds = null } = {}) => {
  if (!isRecord(value)) throw new Error('Invalid AIOPS config');
  if (value.schemaVersion === undefined && Array.isArray(value.issueTypeRoles)) {
    return parseAiopsRouting({
      schemaVersion: 2,
      mode: 'custom',
      routes: value.issueTypeRoles.map((entry) => ({
        issueType: entry.type, status: '*', role: entry.role, action: 'implement',
      })),
    }, { roleIds });
  }
  if (value.schemaVersion !== 2) throw new Error(`Unsupported AIOPS schema version: ${String(value.schemaVersion)}`);
  if (value.mode !== 'preset' && value.mode !== 'custom') throw new Error('Invalid AIOPS config: mode');
  if (!Array.isArray(value.routes) || value.routes.length === 0 || value.routes.length > MAX_ROUTES) {
    throw new Error('Invalid AIOPS config: routes');
  }
  const routes = value.routes.map((route, index) => parseRoute(route, index, roleIds));
  const identities = routes.map((route) => `${normalized(route.issueType)}\0${normalized(route.status)}`);
  if (new Set(identities).size !== identities.length) throw new Error('Invalid AIOPS config: duplicate route');
  const byKey = new Map(routes.map((route) => [`${normalized(route.issueType)}\0${normalized(route.status)}`, route]));
  return {
    schemaVersion: 2,
    mode: value.mode,
    presetId: value.mode === 'preset' ? requiredName(value.presetId, 'presetId') : null,
    routes,
    resolve(issue) {
      const type = normalized(String(issue?.type ?? '').trim());
      const status = normalized(String(issue?.status ?? '').trim());
      return byKey.get(`${type}\0${status}`)
        ?? byKey.get(`*\0${status}`)
        ?? byKey.get(`${type}\0*`)
        ?? null;
    },
  };
};

export const AIOPS_ACTIONS = [...ACTIONS];

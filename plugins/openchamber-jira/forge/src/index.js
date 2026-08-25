import api, { route } from '@forge/api';
import { kvs as storage } from '@forge/kvs';
import Resolver from '@forge/resolver';

const REPLAY_TOLERANCE_SEC = 300;
const MAX_BODY_BYTES = 64 * 1024;
const STATE_TTL_MS = 24 * 60 * 60 * 1000;

const encoder = new TextEncoder();

const parseSignatureHeader = (header) => {
  if (typeof header !== 'string') return null;
  const parts = Object.fromEntries(
    header.split(',').map((chunk) => chunk.trim().split('=', 2)).filter((pair) => pair.length === 2),
  );
  const timestampSec = Number.parseInt(parts.t, 10);
  if (!Number.isInteger(timestampSec) || typeof parts.v1 !== 'string' || !/^[0-9a-f]{64}$/.test(parts.v1)) {
    return null;
  }
  return { timestampSec, signature: parts.v1 };
};

const hexToBytes = (hex) => Uint8Array.from(hex.match(/.{2}/g).map((byte) => Number.parseInt(byte, 16)));

/**
 * Verifies a heartbeat pushed by the private dispatcher.
 *
 * `crypto.subtle.verify` is used rather than a hand-written comparison so the
 * check stays constant-time. The timestamp is part of the signed material, so a
 * captured request cannot be replayed once it falls outside the tolerance.
 */
const verifySignature = async ({ rawBody, header, secret }) => {
  const parsed = parseSignatureHeader(header);
  if (!parsed) return { ok: false, reason: 'malformed_signature' };

  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - parsed.timestampSec) > REPLAY_TOLERANCE_SEC) {
    return { ok: false, reason: 'stale_timestamp' };
  }

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    hexToBytes(parsed.signature),
    encoder.encode(`${parsed.timestampSec}.${rawBody}`),
  );
  return valid ? { ok: true } : { ok: false, reason: 'bad_signature' };
};

const reply = (statusCode, payload) => ({
  statusCode,
  headers: { 'Content-Type': ['application/json'] },
  body: JSON.stringify(payload),
});

/**
 * Web trigger: the ONLY inbound door, and it is hosted by Atlassian. The private
 * host never accepts a connection; it only makes them.
 */
export const heartbeat = async (request) => {
  const secret = process.env.COMPANY_OFFICE_HEARTBEAT_SECRET;
  if (!secret) return reply(503, { error: 'heartbeat_secret_not_configured' });

  const rawBody = typeof request?.body === 'string' ? request.body : '';
  if (!rawBody || rawBody.length > MAX_BODY_BYTES) return reply(400, { error: 'bad_body' });

  const header = request?.headers?.['x-company-office-signature']?.[0]
    ?? request?.headers?.['X-Company-Office-Signature']?.[0];
  const verified = await verifySignature({ rawBody, header, secret });
  if (!verified.ok) return reply(401, { error: verified.reason });

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return reply(400, { error: 'bad_json' });
  }
  if (payload?.schemaVersion !== 1 || typeof payload.ticketKey !== 'string') {
    return reply(400, { error: 'unsupported_payload' });
  }

  await storage.set(`heartbeat:${payload.ticketKey}`, {
    ...payload,
    receivedAt: Date.now(),
  });
  return reply(202, { state: 'accepted' });
};

/** The panel reads stored state; it never calls the private host. */
const readHeartbeat = async (request) => {
  const ticketKey = request?.context?.extension?.issue?.key;
  if (typeof ticketKey !== 'string') return { state: 'unknown' };
  const stored = await storage.get(`heartbeat:${ticketKey}`);
  if (!stored) return { state: 'unknown' };
  // A heartbeat that stopped arriving is stale, not idle: never present silence
  // as a healthy result.
  const stale = Date.now() - stored.receivedAt > STATE_TTL_MS;
  return stale ? { ...stored, state: 'stale' } : stored;
};

const panelResolver = new Resolver();
panelResolver.define('panel', readHeartbeat);
export const panel = panelResolver.getDefinitions();

/** Records operator intent in Jira. It must never spawn an agent by itself. */
export const issueChanged = async (event) => {
  const ticketKey = event?.issue?.key;
  if (typeof ticketKey !== 'string') return;
  await storage.set(`intent:${ticketKey}`, {
    ticketKey,
    status: event?.issue?.fields?.status?.name ?? null,
    observedAt: Date.now(),
  });
};

const MAX_STORED_CONFIG_BYTES = 64 * 1024;
const MAX_ROLES = 50;
const PROJECT_KEY = /^[A-Z][A-Z0-9_]{0,19}$/;
const DEFAULT_ROLES = [
  { id: 'cto', title: 'CTO' },
  { id: 'pm', title: 'Project Manager' },
  { id: 'po', title: 'Product Owner' },
  { id: 'dev', title: 'Developers' },
  { id: 'devops', title: 'DevOps' },
  { id: 'sre', title: 'SRE' },
  { id: 'qa', title: 'QA' },
];
const AIOPS_ACTIONS = new Set(['plan', 'design', 'implement', 'review', 'validate', 'deploy', 'approve', 'observe']);
const AIOPS_PRESET_ROUTES = [
  { issueType: 'Epic', status: 'Backlog', role: 'po', action: 'plan' },
  { issueType: 'Epic', status: 'In Progress', role: 'cto', action: 'design' },
  { issueType: '*', status: 'In Progress', role: 'dev', action: 'implement' },
  { issueType: '*', status: 'Review', role: 'qa', action: 'review' },
  { issueType: '*', status: 'QA', role: 'qa', action: 'validate' },
  { issueType: '*', status: 'Sign-off', role: 'po', action: 'approve' },
];

/**
 * Role configuration for THIS installation.
 *
 * Storage only applies coarse bounds. The authoritative validation lives in the
 * companion (`roles.js`), because that is the side that hands a ruleset to
 * OpenCode and therefore the only side where a bad rule can do harm. Validating
 * twice with two implementations would drift; validating at the point of use
 * will not.
 */
const readRoles = async () => (await storage.get('roles:config')) ?? { roles: DEFAULT_ROLES, defaultModel: null };

const writeRoles = async (request) => {
  const payload = request?.payload;
  if (!Array.isArray(payload?.roles) || payload.roles.length === 0) {
    return { ok: false, error: 'roles_must_be_a_non_empty_array' };
  }
  if (payload.roles.length > MAX_ROLES) {
    return { ok: false, error: 'too_many_roles' };
  }
  const serialized = JSON.stringify(payload);
  if (serialized.length > MAX_STORED_CONFIG_BYTES) {
    return { ok: false, error: 'config_too_large' };
  }
  const current = await readRoles();
  await storage.set('roles:config', { roles: payload.roles, defaultModel: current.defaultModel ?? null, updatedAt: Date.now() });
  return { ok: true, count: payload.roles.length };
};

const readAiopsConfig = async () => (await storage.get('aiops:config')) ?? {
  schemaVersion: 2,
  configured: false,
  mode: 'preset',
  presetId: 'aiops-standard-v1',
  enabledProjectKeys: [],
  routes: AIOPS_PRESET_ROUTES,
};

const listProjectWorkflow = async (projectKey) => {
  const response = await api.asApp().requestJira(route`/rest/api/3/project/${projectKey}/statuses`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Jira workflow lookup failed for ${projectKey} (${response.status})`);
  const payload = await response.json();
  const issueTypes = [];
  const statuses = new Map();
  for (const issueType of Array.isArray(payload) ? payload : []) {
    issueTypes.push({ id: issueType.id, name: issueType.name, subtask: Boolean(issueType.subtask) });
    for (const status of Array.isArray(issueType.statuses) ? issueType.statuses : []) {
      statuses.set(status.id, { id: status.id, name: status.name, category: status.statusCategory?.key ?? null });
    }
  }
  return { projectKey, issueTypes, statuses: [...statuses.values()] };
};

const listProjects = async () => {
  const response = await api.asApp().requestJira(route`/rest/api/3/project/search?maxResults=100&orderBy=name`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Jira project lookup failed (${response.status})`);
  const payload = await response.json();
  return (Array.isArray(payload?.values) ? payload.values : []).map((project) => ({
    id: project.id,
    key: project.key,
    name: project.name,
  }));
};

const readConfiguration = async () => {
  const [roles, aiops, projects] = await Promise.all([readRoles(), readAiopsConfig(), listProjects()]);
  const selected = new Set(aiops.enabledProjectKeys ?? []);
  const workflows = await Promise.all(projects.filter((project) => selected.has(project.key)).map((project) => listProjectWorkflow(project.key)));
  return { roles: roles.roles ?? [], aiops, projects, workflows };
};

const readWorkflowInventory = async (request) => {
  const projectKeys = Array.isArray(request?.payload?.projectKeys)
    ? [...new Set(request.payload.projectKeys.map((key) => String(key).trim().toUpperCase()))]
    : null;
  if (!projectKeys || projectKeys.some((key) => !PROJECT_KEY.test(key))) {
    return { ok: false, error: 'invalid_project_keys' };
  }
  const projects = await listProjects();
  const knownProjects = new Set(projects.map((project) => project.key));
  if (projectKeys.some((key) => !knownProjects.has(key))) {
    return { ok: false, error: 'unknown_project' };
  }
  return { ok: true, workflows: await Promise.all(projectKeys.map(listProjectWorkflow)) };
};

const writeConfiguration = async (request) => {
  const payload = request?.payload ?? {};
  const enabledProjectKeys = Array.isArray(payload.enabledProjectKeys)
    ? [...new Set(payload.enabledProjectKeys.map((key) => String(key).trim().toUpperCase()))]
    : null;
  if (!enabledProjectKeys || enabledProjectKeys.some((key) => !PROJECT_KEY.test(key))) {
    return { ok: false, error: 'invalid_project_keys' };
  }
  const roles = (await readRoles()).roles ?? DEFAULT_ROLES;
  const roleIds = new Set(roles.map((role) => role.id));
  if (payload.schemaVersion !== 2 || !['preset', 'custom'].includes(payload.mode)) {
    return { ok: false, error: 'invalid_aiops_schema' };
  }
  if (!Array.isArray(payload.routes) || payload.routes.length === 0 || payload.routes.length > 100) {
    return { ok: false, error: 'routes_required' };
  }
  const routes = payload.routes.map((entry) => ({
    issueType: String(entry?.issueType ?? '').trim(),
    status: String(entry?.status ?? '').trim(),
    role: String(entry?.role ?? '').trim().toLowerCase(),
    action: String(entry?.action ?? '').trim().toLowerCase(),
  }));
  if (routes.some((entry) => !entry.issueType || !entry.status || !roleIds.has(entry.role) || !AIOPS_ACTIONS.has(entry.action))) {
    return { ok: false, error: 'invalid_route' };
  }
  const identities = routes.map((entry) => `${entry.issueType.toLowerCase()}\0${entry.status.toLowerCase()}`);
  if (new Set(identities).size !== identities.length) return { ok: false, error: 'duplicate_route' };
  const projects = await listProjects();
  const knownProjects = new Set(projects.map((project) => project.key));
  if (enabledProjectKeys.some((key) => !knownProjects.has(key))) return { ok: false, error: 'unknown_project' };
  const workflows = await Promise.all(enabledProjectKeys.map(listProjectWorkflow));
  const issues = new Set(workflows.flatMap((workflow) => workflow.issueTypes.map((entry) => entry.name.toLowerCase())));
  const statuses = new Set(workflows.flatMap((workflow) => workflow.statuses.map((entry) => entry.name.toLowerCase())));
  if (routes.some((entry) => (entry.issueType !== '*' && !issues.has(entry.issueType.toLowerCase()))
    || (entry.status !== '*' && !statuses.has(entry.status.toLowerCase())))) {
    return { ok: false, error: 'route_not_in_selected_workflow' };
  }
  await storage.set('aiops:config', {
    schemaVersion: 2,
    configured: true,
    mode: payload.mode,
    ...(payload.mode === 'preset' ? { presetId: 'aiops-standard-v1' } : {}),
    enabledProjectKeys,
    routes,
    updatedAt: Date.now(),
  });
  return { ok: true, projects: enabledProjectKeys.length, mappings: routes.length };
};

const rolesResolver = new Resolver();
rolesResolver.define('rolesGet', readRoles);
rolesResolver.define('rolesSet', writeRoles);
rolesResolver.define('configurationGet', readConfiguration);
rolesResolver.define('workflowInventoryGet', readWorkflowInventory);
rolesResolver.define('configurationSet', writeConfiguration);
export const rolesConfig = rolesResolver.getDefinitions();

const MAX_COMMENT_CHARS = 30000;
const RELAY_ROLE = /^[a-z][a-z0-9-]{0,63}$/;
const RELAY_TICKET = /^[A-Z][A-Z0-9_]*-\d+$/;

const adfComment = (text) => ({
  type: 'doc',
  version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

/**
 * Agents report in Jira THROUGH the app: the comment is authored by the app
 * (`asApp()`), so it consumes no Atlassian seat, and the role is attributed in
 * the body (`[developer] …`). Same signed channel as the heartbeat — the only
 * writer is the private companion, never an unauthenticated caller.
 */
export const commentRelay = async (request) => {
  const secret = process.env.COMPANY_OFFICE_HEARTBEAT_SECRET;
  if (!secret) return reply(503, { error: 'heartbeat_secret_not_configured' });

  const rawBody = typeof request?.body === 'string' ? request.body : '';
  if (!rawBody || rawBody.length > MAX_BODY_BYTES) return reply(400, { error: 'bad_body' });

  const header = request?.headers?.['x-company-office-signature']?.[0]
    ?? request?.headers?.['X-Company-Office-Signature']?.[0];
  const verified = await verifySignature({ rawBody, header, secret });
  if (!verified.ok) return reply(401, { error: verified.reason });

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return reply(400, { error: 'bad_json' });
  }
  const ticketKey = typeof payload?.ticketKey === 'string' ? payload.ticketKey : '';
  const role = typeof payload?.role === 'string' ? payload.role : '';
  const text = typeof payload?.body === 'string' ? payload.body.trim() : '';
  if (payload?.schemaVersion !== 1 || !RELAY_TICKET.test(ticketKey) || !RELAY_ROLE.test(role) || !text) {
    return reply(400, { error: 'unsupported_payload' });
  }

  const response = await api.asApp().requestJira(route`/rest/api/3/issue/${ticketKey}/comment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: adfComment(`[${role}] ${text.slice(0, MAX_COMMENT_CHARS)}`) }),
  });
  if (response.status >= 400) return reply(502, { error: `jira_${response.status}` });
  const created = await response.json();
  return reply(201, { commentId: created?.id ?? null });
};

/**
 * What the companion pulls on each dispatch cycle: the roles this installation
 * configured. Served through the same signed channel as the heartbeat.
 */
export const rolesForCompanion = async (request) => {
  const secret = process.env.COMPANY_OFFICE_HEARTBEAT_SECRET;
  if (!secret) return reply(503, { error: 'heartbeat_secret_not_configured' });
  const rawBody = typeof request?.body === 'string' ? request.body : '';
  const header = request?.headers?.['x-company-office-signature']?.[0]
    ?? request?.headers?.['X-Company-Office-Signature']?.[0];
  const verified = await verifySignature({ rawBody, header, secret });
  if (!verified.ok) return reply(401, { error: verified.reason });
  const [stored, aiops] = await Promise.all([readRoles(), readAiopsConfig()]);
  return reply(200, { ...stored, aiops });
};

const MAX_STATE_BYTES = 512 * 1024;
const STATE_STALE_MS = 10 * 60 * 1000;
const MODEL_ID = /^[A-Za-z0-9._:\/-]{1,120}$/;

/**
 * The company picture, pushed IN by the companion over the same signed channel.
 *
 * Forge cannot reach the private host, so the view cannot pull: the dispatcher
 * builds the bounded state (roles, agent files, live sessions, cost) and pushes
 * it here on every cycle. Stored whole, because the page renders a snapshot and
 * a half-merged one would show a company that never existed.
 */
export const companyStatePush = async (request) => {
  const secret = process.env.COMPANY_OFFICE_HEARTBEAT_SECRET;
  if (!secret) return reply(503, { error: 'heartbeat_secret_not_configured' });
  const rawBody = typeof request?.body === 'string' ? request.body : '';
  if (rawBody.length > MAX_STATE_BYTES) return reply(413, { error: 'state_too_large' });
  const header = request?.headers?.['x-company-office-signature']?.[0]
    ?? request?.headers?.['X-Company-Office-Signature']?.[0];
  const verified = await verifySignature({ rawBody, header, secret });
  if (!verified.ok) return reply(401, { error: verified.reason });

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return reply(400, { error: 'invalid_json' });
  }
  if (payload?.schemaVersion !== 1 || !Array.isArray(payload.roles)) {
    return reply(400, { error: 'unsupported_state' });
  }
  await storage.set('company:state', { ...payload, observedAt: Date.now() });
  return reply(202, { state: 'accepted', roles: payload.roles.length });
};

/**
 * What the admin page reads. A state that stopped arriving is reported as stale
 * with its age, never as an empty company: "nobody is working" and "the
 * dispatcher is down" must never render the same.
 */
const readCompanyState = async () => {
  const [stored, roleConfig] = await Promise.all([storage.get('company:state'), readRoles()]);
  if (!stored) return { state: 'never_reported' };
  const ageMs = Date.now() - (stored.observedAt ?? 0);
  return {
    state: ageMs > STATE_STALE_MS ? 'stale' : 'ready',
    ageMs,
    company: { ...stored, defaultModel: roleConfig.defaultModel ?? null },
  };
};

/**
 * The one thing this page may WRITE: which model a role runs on.
 *
 * It is writable precisely because `model` travels inline on session creation,
 * so the next dispatch picks it up with no file edit and no restart. Everything
 * else the page shows about a role — its MCP gating, its prompt — is file-owned
 * and stays read-only here, because `POST /session` does not accept it.
 */
const setRoleModel = async (request) => {
  const { roleId, providerID, modelID } = request?.payload ?? {};
  const id = typeof roleId === 'string' ? roleId.trim().toLowerCase() : '';
  if (!id) return { ok: false, error: 'role_required' };

  const stored = await storage.get('roles:config');
  const roles = Array.isArray(stored?.roles) ? stored.roles : [];
  const target = roles.find((role) => role.id === id);
  if (!target) return { ok: false, error: `role "${id}" is not configured` };

  const clearing = !providerID && !modelID;
  if (!clearing) {
    if (!MODEL_ID.test(String(providerID ?? '')) || !MODEL_ID.test(String(modelID ?? ''))) {
      return { ok: false, error: 'providerID and modelID must both be set and simple' };
    }
    target.model = { providerID: String(providerID), modelID: String(modelID) };
  } else {
    delete target.model;
  }
  await storage.set('roles:config', { ...stored, roles, updatedAt: Date.now() });
  return { ok: true, roleId: id, model: target.model ?? null };
};

const setDefaultModel = async (request) => {
  const { providerID, modelID } = request?.payload ?? {};
  if (!MODEL_ID.test(String(providerID ?? '')) || !MODEL_ID.test(String(modelID ?? ''))) {
    return { ok: false, error: 'providerID and modelID must both be set and simple' };
  }
  const stored = await readRoles();
  const defaultModel = { providerID: String(providerID), modelID: String(modelID) };
  await storage.set('roles:config', { ...stored, defaultModel, updatedAt: Date.now() });
  return { ok: true, defaultModel };
};

const companyResolver = new Resolver();
companyResolver.define('companyGet', readCompanyState);
companyResolver.define('rolesGet', readRoles);
companyResolver.define('setRoleModel', setRoleModel);
companyResolver.define('setDefaultModel', setDefaultModel);
export const company = companyResolver.getDefinitions();

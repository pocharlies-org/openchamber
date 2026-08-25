#!/usr/bin/env node
/**
 * Composition root for the Company Office dispatch loop.
 *
 * Reads the installation config, builds the Jira tracker, the OpenCode ticket
 * dispatcher and the Forge heartbeat publisher, and runs `tick()` on an
 * interval. Everything durable lives in Jira and OpenCode; this process can be
 * killed at any point without orphaning a worker or double-dispatching.
 *
 * A tick MUTATES: it creates OpenCode sessions and writes to Jira
 * (session pointer, comments, transitions). Run `--once` for a single cycle.
 */
import { readFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { parseCompanyOfficeConfig } from '../lib/company-office/config.js';
import { createJiraWorkTracker } from '../lib/company-office/work-trackers/jira.js';
import { createTicketDispatcher } from '../lib/company-office/dispatcher.js';
import { createEngine, ENGINE_KINDS } from '../lib/company-office/engines/index.js';
import { createDispatchLoop } from '../lib/company-office/dispatch-loop.js';
import { parseWorkflowConfig } from '../lib/company-office/workflow.js';
import {
  createCompanyStatePublisher,
  createForgeHeartbeatPublisher,
  createForgeRolesLoader,
} from '../lib/company-office/forge-outbound.js';
import { readAgentInventory } from '../lib/company-office/agent-inventory.js';
import { buildCompanyState } from '../lib/company-office/company-state.js';

const CONFIG_PATH = process.env.COMPANY_OFFICE_CONFIG
  ?? '/home/dibanez/startupcompany/company-office.json';
const WORKFLOW_PATH = process.env.COMPANY_OFFICE_WORKFLOW
  ?? '/home/dibanez/startupcompany/company-workflow.json';
const OPENCODE_BASE = process.env.COMPANY_OFFICE_OPENCODE_URL ?? 'http://127.0.0.1:19900';
const HEARTBEAT_URL = process.env.COMPANY_OFFICE_HEARTBEAT_URL ?? null;
const ROLES_URL = process.env.COMPANY_OFFICE_ROLES_URL ?? null;
const STATE_URL = process.env.COMPANY_OFFICE_STATE_URL ?? null;
const HEARTBEAT_SECRET_FILE = process.env.COMPANY_OFFICE_HEARTBEAT_SECRET_FILE ?? null;
const AGENTS_DIRECTORY = process.env.COMPANY_OFFICE_AGENTS_DIRECTORY
  ?? '/home/dibanez/.config/opencode/agents/company';
const INTERVAL_MS = Number(process.env.COMPANY_OFFICE_INTERVAL_MS ?? 60_000);

/**
 * House default while the company is being evaluated: the local resident, not a
 * metered API. A role that configures its own model in the plugin overrides
 * this per dispatch; this only covers the roles that do not.
 */
const DEFAULT_MODEL = process.env.COMPANY_OFFICE_MODEL ?? 'litellm-auto/deepseek-v4-flash-0731';
const model = (() => {
  const slash = DEFAULT_MODEL.indexOf('/');
  if (slash <= 0 || slash === DEFAULT_MODEL.length - 1) {
    throw new Error(`COMPANY_OFFICE_MODEL must be "<providerID>/<modelID>", got "${DEFAULT_MODEL}"`);
  }
  return { providerID: DEFAULT_MODEL.slice(0, slash), modelID: DEFAULT_MODEL.slice(slash + 1) };
})();

const config = parseCompanyOfficeConfig(JSON.parse(readFileSync(CONFIG_PATH, 'utf8')));
const tracker = createJiraWorkTracker({
  config: config.workTracker.jira,
  fsPromises,
  fetchImpl: fetch,
});

/**
 * Jira assignees are `me+<first name>` aliases of one mailbox; the roster is
 * the authority for which employee (and therefore which role and directory)
 * each alias is. Keyed by Jira accountId because that is what issues carry.
 */
const buildEmployeesById = (issues) => {
  const registry = JSON.parse(readFileSync(config.roster.registryPath, 'utf8'));
  const byAlias = new Map();
  for (const [id, entry] of Object.entries(registry)) {
    const first = entry.persona.split(' ')[0].toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '');
    byAlias.set(`me+${first}`, { id, role: entry.role, directory: entry.directory });
  }
  const employeesById = new Map();
  for (const issue of issues) {
    const employee = byAlias.get((issue.assignee ?? '').toLowerCase());
    if (issue.assigneeAccountId && employee) employeesById.set(issue.assigneeAccountId, employee);
  }
  return employeesById;
};

/**
 * Which runtime works the tickets. `opencode` keeps the local resident; `claude`
 * and `codex` run the real CLI on the operator's own subscription, leaving each
 * session openable afterwards with `claude --resume` / `codex exec resume`.
 */
const ENGINE_KIND = process.env.COMPANY_OFFICE_ENGINE ?? 'opencode';
if (!ENGINE_KINDS.includes(ENGINE_KIND)) {
  throw new Error(`COMPANY_OFFICE_ENGINE must be one of ${ENGINE_KINDS.join(', ')}, got "${ENGINE_KIND}"`);
}

const engine = createEngine({
  kind: ENGINE_KIND,
  fetchImpl: fetch,
  buildOpenCodeUrl: (path) => `${OPENCODE_BASE}${path}`,
  model,
  // The CLI engines take a model name, not OpenCode's `{providerID, modelID}`.
  ...(ENGINE_KIND === 'opencode' ? {} : { model: process.env.COMPANY_OFFICE_CLI_MODEL ?? null }),
});

const dispatcher = createTicketDispatcher({
  engine,
  recordSession: tracker.supportsSessionField
    ? (ticketKey, sessionId) => tracker.recordSession(ticketKey, sessionId)
    : null,
});

const workflow = (() => {
  try {
    return parseWorkflowConfig(JSON.parse(readFileSync(WORKFLOW_PATH, 'utf8')));
  } catch (error) {
    // No workflow means dispatch still works; only automatic hand-off is off.
    console.error(`workflow disabled: ${error?.message ?? error}`);
    return null;
  }
})();

const forge = (() => {
  if (!HEARTBEAT_SECRET_FILE) return {};
  const secret = readFileSync(HEARTBEAT_SECRET_FILE, 'utf8').trim();
  return {
    publishHeartbeat: HEARTBEAT_URL
      ? createForgeHeartbeatPublisher({ webTriggerUrl: HEARTBEAT_URL, secret }).publish
      : null,
    loadRoles: ROLES_URL ? createForgeRolesLoader({ webTriggerUrl: ROLES_URL, secret }) : null,
    publishState: STATE_URL
      ? createCompanyStatePublisher({ webTriggerUrl: STATE_URL, secret }).publish
      : null,
  };
})();

const fetchOpenCodeList = async (path) => {
  const response = await fetch(`${OPENCODE_BASE}${path}`);
  if (!response.ok) throw new Error(`OpenCode ${path} failed (${response.status})`);
  const payload = await response.json();
  if (!Array.isArray(payload)) throw new Error(`OpenCode ${path} returned an unusable list`);
  return payload;
};

const runTick = async () => {
  const publishCompanyState = forge.publishState
    ? async ({ roles, statuses, issues, now }) => {
      const [inventory, sessions, skills, providers] = await Promise.all([
        readAgentInventory({ directory: AGENTS_DIRECTORY }),
        dispatcher.listSessions(),
        fetchOpenCodeList('/skill'),
        fetch(`${OPENCODE_BASE}/provider`).then(async (response) => {
          if (!response.ok) throw new Error(`OpenCode /provider failed (${response.status})`);
          return response.json();
        }),
      ]);
      return forge.publishState(buildCompanyState({
        roles, inventory, sessions, issues, statuses, skills, providers, now: () => now,
      }));
    }
    : null;
  const loop = createDispatchLoop({
    tracker,
    dispatcher,
    loadRoles: forge.loadRoles,
    publishHeartbeat: forge.publishHeartbeat,
    publishCompanyState,
    employeesById: buildEmployeesById,
    workflow,
  });
  const report = await loop.tick();
  console.log(JSON.stringify({ at: new Date().toISOString(), ...report }));
  return report;
};

if (process.argv.includes('--once')) {
  await runTick();
} else {
  console.error(`dispatch loop every ${INTERVAL_MS}ms against ${OPENCODE_BASE}`);
  for (;;) {
    await runTick().catch((error) => console.error(`tick failed: ${error?.message ?? error}`));
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
}

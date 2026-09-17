#!/usr/bin/env node
/**
 * Composition root for the Jira webhook dispatch path.
 *
 * The polling loop (`company-office-dispatch.mjs`) reconciles the whole company
 * on a timer. This is the other half: it exposes the public Jira webhook
 * receiver and, when an event says "this epic was assigned to the CTO", reads the
 * issue back from Jira and starts (or reuses) its session immediately.
 *
 * It is a separate process from the server on purpose. The receiver is a public
 * endpoint; running it beside the browser-authenticated API would put an
 * unauthenticated surface next to an authenticated one. It shares the same config
 * and roster as the dispatch loop, and the loop runs with `create:false` so the
 * two never create the same session.
 *
 * Idempotency does not depend on the receiver's dedupe window surviving a
 * restart: the session title carries `[KEY]` and is the claim, so a replayed
 * event reuses the session rather than duplicating it.
 */
import { readFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import express from 'express';
import { parseCompanyOfficeConfig } from '../lib/company-office/config.js';
import { createJiraWorkTracker } from '../lib/company-office/work-trackers/jira.js';
import { createTicketDispatcher } from '../lib/company-office/dispatcher.js';
import { createEngine, ENGINE_KINDS } from '../lib/company-office/engines/index.js';
import { createEventDispatcher } from '../lib/company-office/dispatch-event.js';
import { createForgeRolesLoader } from '../lib/company-office/forge-outbound.js';
import { registerJiraWebhookRoutes } from '../lib/company-office/webhook/receiver.js';
import { buildEmployeesFromRegistry } from '../lib/company-office/employees.js';

const CONFIG_PATH = process.env.COMPANY_OFFICE_CONFIG
  ?? '/home/dibanez/startupcompany/company-office.json';
const OPENCODE_BASE = process.env.COMPANY_OFFICE_OPENCODE_URL ?? 'http://127.0.0.1:19900';
const ROLES_URL = process.env.COMPANY_OFFICE_ROLES_URL ?? null;
const HEARTBEAT_SECRET_FILE = process.env.COMPANY_OFFICE_HEARTBEAT_SECRET_FILE ?? null;

const WEBHOOK_SECRET_FILE = process.env.COMPANY_OFFICE_WEBHOOK_SECRET_FILE;
const INSTALLATION_ID = process.env.COMPANY_OFFICE_WEBHOOK_INSTALLATION_ID ?? 'default';
const WEBHOOK_PORT = Number(process.env.COMPANY_OFFICE_WEBHOOK_PORT ?? 19910);
const WEBHOOK_HOST = process.env.COMPANY_OFFICE_WEBHOOK_HOST ?? '127.0.0.1';

const DEFAULT_MODEL = process.env.COMPANY_OFFICE_MODEL ?? 'litellm-auto/deepseek-v4-flash-0731';
const model = (() => {
  const slash = DEFAULT_MODEL.indexOf('/');
  if (slash <= 0 || slash === DEFAULT_MODEL.length - 1) {
    throw new Error(`COMPANY_OFFICE_MODEL must be "<providerID>/<modelID>", got "${DEFAULT_MODEL}"`);
  }
  return { providerID: DEFAULT_MODEL.slice(0, slash), modelID: DEFAULT_MODEL.slice(slash + 1) };
})();

if (!WEBHOOK_SECRET_FILE) {
  throw new Error('COMPANY_OFFICE_WEBHOOK_SECRET_FILE is required for the webhook receiver');
}

const config = parseCompanyOfficeConfig(JSON.parse(readFileSync(CONFIG_PATH, 'utf8')));
const tracker = createJiraWorkTracker({
  config: config.workTracker.jira,
  fsPromises,
  fetchImpl: fetch,
});

const ENGINE_KIND = process.env.COMPANY_OFFICE_ENGINE ?? 'opencode';
if (!ENGINE_KINDS.includes(ENGINE_KIND)) {
  throw new Error(`COMPANY_OFFICE_ENGINE must be one of ${ENGINE_KINDS.join(', ')}, got "${ENGINE_KIND}"`);
}
const engine = createEngine({
  kind: ENGINE_KIND,
  fetchImpl: fetch,
  buildOpenCodeUrl: (path) => `${OPENCODE_BASE}${path}`,
  model,
  ...(ENGINE_KIND === 'opencode' ? {} : { model: process.env.COMPANY_OFFICE_CLI_MODEL ?? null }),
});

const dispatcher = createTicketDispatcher({
  engine,
  recordSession: tracker.supportsSessionField
    ? (ticketKey, sessionId) => tracker.recordSession(ticketKey, sessionId)
    : null,
});

const loadRoles = (() => {
  if (!ROLES_URL || !HEARTBEAT_SECRET_FILE) return null;
  const secret = readFileSync(HEARTBEAT_SECRET_FILE, 'utf8').trim();
  // Same Forge roles loader the dispatch loop uses, so both resolve the same
  // role configuration and the same AIOPS routing.
  return createForgeRolesLoader({ webTriggerUrl: ROLES_URL, secret });
})();

const eventDispatcher = createEventDispatcher({
  tracker,
  dispatcher,
  loadRoles,
  employeesById: (issues) => buildEmployeesFromRegistry(config.roster.registryPath, issues),
});

const app = express();
registerJiraWebhookRoutes(app, {
  readSecretFile: () => readFileSync(WEBHOOK_SECRET_FILE, 'utf8'),
  installationId: INSTALLATION_ID,
  allowedProjectKeys: [config.workTracker.jira.projectKey],
  dispatch: (ticketKey) => eventDispatcher.handleEvent(ticketKey),
  report: (result) => console.log(JSON.stringify({ at: new Date().toISOString(), ...result })),
});

app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

const server = app.listen(WEBHOOK_PORT, WEBHOOK_HOST, () => {
  console.error(`jira webhook receiver on ${WEBHOOK_HOST}:${WEBHOOK_PORT} for installation ${INSTALLATION_ID}`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

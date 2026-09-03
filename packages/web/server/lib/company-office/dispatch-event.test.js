import { describe, expect, test, vi } from 'vitest';
import { createEventDispatcher } from './dispatch-event.js';

const employeesById = new Map([
  ['cto-acct', { id: 'cto-one', role: 'cto', directory: '/srv/repo-a' }],
]);

const epic = (overrides = {}) => ({
  key: 'SC-1',
  summary: 'Ship the thing',
  status: 'To Do',
  type: 'Epic',
  assigneeAccountId: 'cto-acct',
  sessionId: null,
  repo: '/srv/repo-a',
  acceptanceCriteria: null,
  ...overrides,
});

const rolesLoaded = {
  roles: [{ id: 'cto', title: 'CTO' }],
  aiops: {
    schemaVersion: 2,
    mode: 'custom',
    routes: [{ issueType: 'Epic', status: '*', role: 'cto', action: 'plan' }],
  },
};

const stubDispatcher = (overrides = {}) => ({
  findSessionsByTicket: async () => ({ byTicket: new Map(), duplicates: [], state: 'ready' }),
  spawnAll: vi.fn(async (plans, existing) => ({
    started: plans.map((p) => ({
      ticketKey: p.ticketKey,
      sessionId: existing?.get(p.ticketKey)?.sessionId ?? `ses_${p.ticketKey}`,
      agent: p.agent,
      reused: Boolean(existing?.has(p.ticketKey)),
      recorded: true,
    })),
    failed: [], unrecorded: [], reused: [], state: 'ready',
  })),
  ...overrides,
});

const build = ({ issue, dispatcher, roles = rolesLoaded }) => createEventDispatcher({
  tracker: { loadIssue: async (key) => (issue?.key === key ? issue : null) },
  dispatcher: stubDispatcher(dispatcher ?? {}),
  loadRoles: async () => roles,
  employeesById,
  now: () => 1000,
});

describe('event dispatcher', () => {
  test('spawns a session for an epic assigned to the CTO', async () => {
    const report = await build({ issue: epic() }).handleEvent('SC-1');
    expect(report.action).toBe('spawned');
    expect(report.sessionId).toBe('ses_SC-1');
  });

  test('reuses the session a ticket already owns instead of duplicating', async () => {
    const existing = new Map([['SC-1', { ticketKey: 'SC-1', sessionId: 'ses_existing', agent: 'company/cto', phase: 'plan' }]]);
    const report = await build({
      issue: epic(),
      dispatcher: { findSessionsByTicket: async () => ({ byTicket: existing, duplicates: [], state: 'ready' }) },
    }).handleEvent('SC-1');
    expect(report.action).toBe('reused');
    expect(report.sessionId).toBe('ses_existing');
  });

  test('acts on the authoritative read, not the payload: unknown key is a no-op', async () => {
    const report = await build({ issue: epic() }).handleEvent('SC-999');
    expect(report.action).toBe('noop');
    expect(report.reason).toBe('issue_not_found');
  });

  test('no-ops when the issue does not route to a role', async () => {
    const report = await build({ issue: epic({ type: 'Task' }) }).handleEvent('SC-1');
    expect(report.action).toBe('noop');
    expect(report.reason).toBe('no_aiops_route');
  });

  test('no-ops when the assignee is not a known employee', async () => {
    const report = await build({ issue: epic({ assigneeAccountId: 'nobody' }) }).handleEvent('SC-1');
    expect(report.action).toBe('noop');
    expect(report.reason).toBe('unassigned');
  });

  test('creates nothing when the session scan fails and no session is known', async () => {
    const report = await build({
      issue: epic(),
      dispatcher: { findSessionsByTicket: async () => { throw new Error('scan down'); } },
    }).handleEvent('SC-1');
    expect(report.action).toBe('noop');
    expect(report.reason).toBe('scan_failed_cannot_create');
  });

  test('refuses to dispatch when the role config is unreadable', async () => {
    const report = await createEventDispatcher({
      tracker: { loadIssue: async () => epic() },
      dispatcher: stubDispatcher(),
      loadRoles: async () => { throw new Error('forge down'); },
      employeesById,
    }).handleEvent('SC-1');
    expect(report.action).toBe('error');
    expect(report.error).toContain('forge down');
  });

  test('reports ambiguous sessions without creating', async () => {
    const report = await build({
      issue: epic(),
      dispatcher: { findSessionsByTicket: async () => ({ byTicket: new Map(), duplicates: ['SC-1'], state: 'partial' }) },
    }).handleEvent('SC-1');
    expect(report.action).toBe('noop');
    expect(report.reason).toBe('ambiguous_session');
  });
});

import { describe, expect, test } from 'vitest';
import { createDispatchLoop } from './dispatch-loop.js';
import { parseWorkflowConfig } from './workflow.js';

const employeesById = new Map([
  ['dev-one', { id: 'dev-one', role: 'developer', directory: '/srv/repo-a' }],
]);

const issue = (key, overrides = {}) => ({
  key,
  summary: `Work ${key}`,
  status: 'In Progress',
  assigneeId: 'dev-one',
  sessionId: null,
  repo: '/srv/repo-a',
  acceptanceCriteria: null,
  ...overrides,
});

const stubDispatcher = (overrides = {}) => ({
  readStatuses: async () => ({}),
  findSessionsByTicket: async () => ({ byTicket: new Map(), duplicates: [], state: 'ready' }),
  spawnAll: async (plans, existing) => ({
    started: plans.map((p) => ({
      ticketKey: p.ticketKey,
      sessionId: existing?.get(p.ticketKey)?.sessionId ?? `ses_${p.ticketKey}`,
      agent: p.agent,
      startedAt: 1,
      reused: Boolean(existing?.has(p.ticketKey)),
    })),
    failed: [], unrecorded: [], reused: [], state: 'ready',
  }),
  supervise: async () => ({ busy: [], finished: [], aborted: [], state: 'ready' }),
  retire: async (workers) => ({ retired: workers, state: 'ready' }),
  ...overrides,
});

const loopWith = ({ issues, trackerState = 'ready', dispatcher, ...overrides }) => createDispatchLoop({
  tracker: { loadSnapshot: async () => ({ state: trackerState, issues }) },
  dispatcher: stubDispatcher(dispatcher ?? {}),
  employeesById,
  now: () => 1000,
  ...overrides,
});

describe('one dispatch cycle', () => {
  test('dispatches an eligible ticket and reports what it started', async () => {
    const report = await loopWith({ issues: [issue('SC-1')] }).tick();
    expect(report.started.map((w) => w.ticketKey)).toEqual(['SC-1']);
    expect(report.errors).toEqual([]);
    expect(report.sources.dispatch).toBe('ready');
  });

  test('passes the saved AIOPS space selection to Jira and routes the issue type', async () => {
    const selections = [];
    const started = [];
    const loop = createDispatchLoop({
      tracker: {
        loadSnapshot: async (selection) => {
          selections.push(selection);
          return { state: 'ready', issues: [issue('SC-1', { type: 'Epic' })] };
        },
      },
      dispatcher: stubDispatcher({ spawnAll: async (plans) => {
        started.push(...plans);
        return { started: [], failed: [], unrecorded: [], reused: [], state: 'ready' };
      } }),
      employeesById,
      loadRoles: async () => ({
        roles: [{
          id: 'cto', title: 'CTO', permission: [{ permission: '*', pattern: '*', action: 'ask' }],
        }],
        aiops: {
          schemaVersion: 2,
          mode: 'custom',
          configured: true,
          enabledProjectKeys: ['SC', 'OPS'],
          routes: [{ issueType: 'Epic', status: 'In Progress', role: 'cto', action: 'design' }],
        },
      }),
    });
    await loop.tick();
    expect(selections).toEqual([{ projectKeys: ['SC', 'OPS'] }]);
    expect(started[0].agent).toBe('company/cto');
  });

  test('uses the default model when the routed role has no override', async () => {
    const started = [];
    const loop = loopWith({
      issues: [issue('SC-1')],
      dispatcher: { spawnAll: async (plans) => {
        started.push(...plans);
        return { started: [], failed: [], unrecorded: [], reused: [], state: 'ready' };
      } },
      loadRoles: async () => ({
        defaultModel: { providerID: 'litellm-auto', modelID: 'cloudblue/gpt-5.6-sol' },
        roles: [{
          id: 'developer', title: 'Developer', permission: [{ permission: '*', pattern: '*', action: 'ask' }],
        }],
      }),
    });
    await loop.tick();
    expect(started[0].model).toEqual({ providerID: 'litellm-auto', modelID: 'cloudblue/gpt-5.6-sol' });
  });

  test('a role model overrides the installation-wide default', async () => {
    const started = [];
    const loop = loopWith({
      issues: [issue('SC-1')],
      dispatcher: { spawnAll: async (plans) => {
        started.push(...plans);
        return { started: [], failed: [], unrecorded: [], reused: [], state: 'ready' };
      } },
      loadRoles: async () => ({
        defaultModel: { providerID: 'litellm-auto', modelID: 'cloudblue/gpt-5.6-sol' },
        roles: [{
          id: 'developer', title: 'Developer',
          model: { providerID: 'litellm-auto', modelID: 'cloudblue/gpt-5.6-luna' },
          permission: [{ permission: '*', pattern: '*', action: 'ask' }],
        }],
      }),
    });
    await loop.tick();
    expect(started[0].model).toEqual({ providerID: 'litellm-auto', modelID: 'cloudblue/gpt-5.6-luna' });
  });

  test('an explicitly empty AIOPS space selection dispatches nothing', async () => {
    const selections = [];
    const report = await createDispatchLoop({
      tracker: { loadSnapshot: async (selection) => {
        selections.push(selection);
        return { state: 'ready', issues: [] };
      } },
      dispatcher: stubDispatcher(),
      employeesById,
      loadRoles: async () => ({
        roles: [{
          id: 'developer', title: 'Developer', permission: [{ permission: '*', pattern: '*', action: 'ask' }],
        }],
        aiops: {
          schemaVersion: 2,
          mode: 'custom',
          configured: true,
          enabledProjectKeys: [],
          routes: [{ issueType: '*', status: 'In Progress', role: 'developer', action: 'implement' }],
        },
      }),
    }).tick();
    expect(selections).toEqual([{ projectKeys: [] }]);
    expect(report.started).toEqual([]);
  });

  test('a ticket already claiming a busy session is not dispatched twice', async () => {
    const report = await loopWith({
      issues: [issue('SC-1', { sessionId: 'ses_live' })],
      dispatcher: { readStatuses: async () => ({ ses_live: { type: 'busy' } }) },
    }).tick();
    expect(report.started).toEqual([]);
    expect(report.skipped).toEqual([{ key: 'SC-1', reason: 'already_running' }]);
  });

  test('a claimed session that finished frees its ticket again', async () => {
    const report = await loopWith({
      issues: [issue('SC-1', { sessionId: 'ses_done' })],
      dispatcher: { readStatuses: async () => ({ ses_done: { type: 'idle' } }) },
    }).tick();
    expect(report.started.map((w) => w.ticketKey)).toEqual(['SC-1']);
  });

  test('unreadable status counts every claimed ticket as running, never as free', async () => {
    const report = await loopWith({
      issues: [issue('SC-1', { sessionId: 'ses_x' })],
      dispatcher: { readStatuses: async () => { throw new Error('status down'); } },
    }).tick();
    expect(report.sources.reconcile).toBe('partial');
    expect(report.started).toEqual([]);
    expect(report.skipped).toEqual([{ key: 'SC-1', reason: 'already_running' }]);
  });
});

describe('a bad source degrades, it does not dispatch blindly', () => {
  test('a tracker failure stops the cycle instead of dispatching an empty plan', async () => {
    let spawned = false;
    const loop = createDispatchLoop({
      tracker: { loadSnapshot: async () => { throw new Error('jira 503'); } },
      dispatcher: stubDispatcher({ spawnAll: async () => { spawned = true; return { started: [], failed: [], state: 'ready' }; } }),
      employeesById,
    });
    const report = await loop.tick();
    expect(report.sources.tracker).toBe('error');
    expect(report.errors[0]).toMatchObject({ stage: 'tracker' });
    expect(spawned).toBe(false);
  });

  test('an unreadable role config refuses to dispatch without a permission boundary', async () => {
    let spawned = false;
    const report = await loopWith({
      issues: [issue('SC-1')],
      loadRoles: async () => ({ roles: [{ id: 'developer' }] }),
      dispatcher: { spawnAll: async () => { spawned = true; return { started: [], failed: [], state: 'ready' }; } },
    }).tick();
    expect(report.sources.roles).toBe('error');
    expect(report.errors[0].stage).toBe('roles');
    expect(spawned).toBe(false);
  });

  test('a partial Jira snapshot is carried into the report rather than hidden', async () => {
    const report = await loopWith({ issues: [issue('SC-1')], trackerState: 'partial' }).tick();
    expect(report.sources.tracker).toBe('partial');
    expect(report.started).toHaveLength(1);
  });

  test('a ticket with no repository is skipped with a reason, not guessed', async () => {
    const employees = new Map([['dev-one', { id: 'dev-one', role: 'developer', directory: null }]]);
    const loop = createDispatchLoop({
      tracker: { loadSnapshot: async () => ({ state: 'ready', issues: [issue('SC-1', { repo: null })] }) },
      dispatcher: stubDispatcher(),
      employeesById: employees,
    });
    const report = await loop.tick();
    expect(report.skipped).toEqual([{ key: 'SC-1', reason: 'no_repo' }]);
  });
});

describe('cleanup and visibility', () => {
  test('retires the session of a ticket that reached a closed status', async () => {
    const report = await loopWith({
      issues: [issue('SC-9', { status: 'Done', sessionId: 'ses_old' })],
      dispatcher: { readStatuses: async () => ({ ses_old: { type: 'idle' } }) },
    }).tick();
    expect(report.retired).toEqual([{ ticketKey: 'SC-9', sessionId: 'ses_old' }]);
  });

  test('a failing heartbeat degrades visibility but never the dispatch', async () => {
    const report = await loopWith({
      issues: [issue('SC-1')],
      publishHeartbeat: async () => { throw new Error('forge unreachable'); },
    }).tick();
    expect(report.started).toHaveLength(1);
    expect(report.sources.heartbeat).toBe('partial');
  });

  test('publishes a bounded heartbeat that carries no working context', async () => {
    const sent = [];
    await loopWith({
      issues: [issue('SC-1')],
      publishHeartbeat: async (beat) => { sent.push(beat); return { state: 'ready' }; },
    }).tick();
    expect(sent[0]).toMatchObject({ schemaVersion: 1, ticketKey: 'SC-1', sessionId: 'ses_SC-1', state: 'busy' });
    expect(Object.keys(sent[0])).not.toContain('directory');
    expect(JSON.stringify(sent[0])).not.toContain('/srv/repo-a');
  });

  test('a failed company-state push degrades visibility without hiding dispatch', async () => {
    const report = await loopWith({
      issues: [issue('SC-1')],
      publishCompanyState: async () => ({ state: 'error', reason: 'status_503' }),
    }).tick();
    expect(report.started).toHaveLength(1);
    expect(report.sources.companyState).toBe('partial');
  });

  test('a tick never throws, whatever the dispatcher does', async () => {
    const report = await loopWith({
      issues: [issue('SC-1')],
      dispatcher: {
        spawnAll: async () => { throw new Error('opencode down'); },
        supervise: async () => { throw new Error('status down'); },
        retire: async () => { throw new Error('archive down'); },
      },
    }).tick();
    expect(report.sources.dispatch).toBe('error');
    expect(report.errors.map((e) => e.stage)).toContain('dispatch');
  });
});

describe('rescue: one ticket keeps one session, always', () => {
  const found = (map, extra = {}) => ({
    findSessionsByTicket: async () => ({ byTicket: new Map(map), duplicates: [], state: 'ready', ...extra }),
  });

  test('reuses the session the ticket already owns instead of creating a second one', async () => {
    const report = await loopWith({
      issues: [issue('SC-1')],
      dispatcher: found([['SC-1', { ticketKey: 'SC-1', sessionId: 'ses_rescued' }]]),
    }).tick();
    expect(report.started).toHaveLength(1);
    expect(report.started[0]).toMatchObject({ sessionId: 'ses_rescued', reused: true });
  });

  test('rescues a session whose Jira pointer was lost mid-crash', async () => {
    // Jira knows nothing; only the session title proves the work exists.
    const report = await loopWith({
      issues: [issue('SC-1', { sessionId: null })],
      dispatcher: found([['SC-1', { ticketKey: 'SC-1', sessionId: 'ses_orphan' }]]),
    }).tick();
    expect(report.started[0]).toMatchObject({ sessionId: 'ses_orphan', reused: true });
    expect(report.started.filter((w) => !w.reused)).toEqual([]);
  });

  test('refuses to create anything when it cannot prove a ticket is free', async () => {
    let created = [];
    const report = await loopWith({
      issues: [issue('SC-1')],
      dispatcher: {
        findSessionsByTicket: async () => { throw new Error('scan down'); },
        spawnAll: async (plans) => { created = plans.map((p) => p.ticketKey); return { started: [], failed: [], state: 'ready' }; },
      },
    }).tick();
    expect(report.sources.reconcile).toBe('error');
    expect(created).toEqual([]);
    expect(report.started).toEqual([]);
  });

  test('still feeds a rescued session even when the scan is degraded', async () => {
    const report = await loopWith({
      issues: [issue('SC-1'), issue('SC-2')],
      dispatcher: {
        findSessionsByTicket: async () => { throw new Error('scan down'); },
        readStatuses: async () => ({}),
      },
    }).tick();
    // nothing provably free, so nothing new; no duplicate can appear
    expect(report.started).toEqual([]);
  });

  test('never guesses when a ticket somehow owns two live sessions', async () => {
    const report = await loopWith({
      issues: [issue('SC-1')],
      dispatcher: {
        findSessionsByTicket: async () => ({ byTicket: new Map(), duplicates: ['SC-1'], state: 'partial' }),
      },
    }).tick();
    expect(report.ambiguous).toEqual(['SC-1']);
    expect(report.skipped).toContainEqual({ key: 'SC-1', reason: 'ambiguous_session' });
    expect(report.started).toEqual([]);
  });

  test('a busy rescued session is left alone, not prompted again', async () => {
    const report = await loopWith({
      issues: [issue('SC-1')],
      dispatcher: {
        findSessionsByTicket: async () => ({ byTicket: new Map([['SC-1', { ticketKey: 'SC-1', sessionId: 'ses_busy' }]]), ambiguous: [], state: 'ready' }),
        readStatuses: async () => ({ ses_busy: { type: 'busy' } }),
      },
    }).tick();
    expect(report.started).toEqual([]);
    expect(report.skipped).toContainEqual({ key: 'SC-1', reason: 'already_running' });
  });
});

describe('handing work on when a part is finished', () => {
  const workflow = parseWorkflowConfig({
    issueTypes: [
      { type: 'Subtask', role: 'developer', onDone: { status: 'Review', validatedBy: 'qa' } },
      { type: 'Story', role: 'pm', onDone: { status: 'QA', validatedBy: 'qa' } },
      { type: 'Epic', role: 'cto', onDone: { status: 'Sign-off', validatedBy: 'pm' } },
    ],
  });

  const withTracker = (issues, tracker = {}) => createDispatchLoop({
    tracker: {
      loadSnapshot: async () => ({ state: 'ready', issues }),
      transitionTo: async () => ({ state: 'ready' }),
      addComment: async () => ({ state: 'ready' }),
      ...tracker,
    },
    dispatcher: stubDispatcher(),
    employeesById,
    workflow,
    now: () => 1000,
  });

  const node = (key, type, status, parentKey = null) => ({
    key, type, status, parentKey, summary: key, assigneeId: null, sessionId: null, repo: '/srv/repo-a',
  });

  test('moves a story to QA once every subtask is done, and says so in Jira', async () => {
    const moves = []; const comments = [];
    const report = await withTracker([
      node('SC-10', 'Story', 'In Progress'),
      node('SC-11', 'Subtask', 'Done', 'SC-10'),
    ], {
      transitionTo: async (key, to) => { moves.push([key, to]); return { state: 'ready' }; },
      addComment: async (key, text) => { comments.push([key, text]); return { state: 'ready' }; },
    }).tick();

    expect(moves).toEqual([['SC-10', 'QA']]);
    expect(report.advanced.map((m) => m.key)).toEqual(['SC-10']);
    expect(comments[0][1]).toContain('SC-11');
    expect(comments[0][1]).toContain('qa');
  });

  test('an epic goes to Sign-off for the PM once its stories are done', async () => {
    const moves = [];
    await withTracker([
      node('SC-1', 'Epic', 'In Progress'),
      node('SC-10', 'Story', 'Done', 'SC-1'),
    ], { transitionTo: async (key, to) => { moves.push([key, to]); return { state: 'ready' }; } }).tick();
    expect(moves).toEqual([['SC-1', 'Sign-off']]);
  });

  test('reports which children still block a parent instead of moving it', async () => {
    const moves = [];
    const report = await withTracker([
      node('SC-10', 'Story', 'In Progress'),
      node('SC-11', 'Subtask', 'Done', 'SC-10'),
      node('SC-12', 'Subtask', 'In Progress', 'SC-10'),
    ], { transitionTo: async (key, to) => { moves.push([key, to]); return { state: 'ready' }; } }).tick();
    expect(moves).toEqual([]);
    expect(report.blocked).toEqual([{ key: 'SC-10', pending: ['SC-12'] }]);
  });

  test('a refused transition is reported, never forced by another route', async () => {
    const report = await withTracker([
      node('SC-10', 'Story', 'In Progress'),
      node('SC-11', 'Subtask', 'Done', 'SC-10'),
    ], {
      transitionTo: async () => { throw new Error('Jira has no transition from SC-10 to "QA"'); },
    }).tick();
    expect(report.advanced).toEqual([]);
    expect(report.errors.find((e) => e.stage === 'advance')).toMatchObject({ key: 'SC-10' });
  });

  test('does nothing at all when no workflow is configured', async () => {
    const moves = [];
    const report = await createDispatchLoop({
      tracker: {
        loadSnapshot: async () => ({ state: 'ready', issues: [node('SC-10', 'Story', 'In Progress'), node('SC-11', 'Subtask', 'Done', 'SC-10')] }),
        transitionTo: async (key, to) => { moves.push([key, to]); return { state: 'ready' }; },
      },
      dispatcher: stubDispatcher(),
      employeesById,
    }).tick();
    expect(moves).toEqual([]);
    expect(report.advanced).toEqual([]);
  });
});

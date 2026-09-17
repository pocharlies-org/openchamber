import { describe, expect, test } from 'vitest';
import { agentForRole, planDispatch, createTicketDispatcher } from './dispatcher.js';
import { parseAiopsRouting } from './aiops-routing.js';

const employeesById = new Map([
  ['dev-one', { id: 'dev-one', role: 'developer', directory: '/srv/repo-a' }],
  ['ops-one', { id: 'ops-one', role: 'devops', directory: '/srv/repo-b' }],
  ['ghost', { id: 'ghost', role: '   ', directory: '/srv/repo-c' }],
]);

const issue = (key, overrides = {}) => ({
  key,
  summary: `Work ${key}`,
  status: 'In Progress',
  assigneeId: 'dev-one',
  acceptanceCriteria: null,
  ...overrides,
});

const plan = (issues, overrides = {}) => planDispatch({
  issues,
  employeesById,
  runningByTicket: new Set(),
  dispatchableStatuses: ['In Progress', 'To Do'],
  ...overrides,
});

describe('ticket dispatch planning', () => {
  test('maps a role to its agent and titles the session so the projection can read it', () => {
    expect(agentForRole('DevOps')).toBe('company/devops');
    expect(agentForRole('  ')).toBeNull();
    const { plans } = plan([issue('SC-21')]);
    expect(plans[0]).toMatchObject({ ticketKey: 'SC-21', agent: 'company/developer', directory: '/srv/repo-a' });
    expect(plans[0].title).toBe('[SC-21] Work SC-21');
  });

  test('runs one role on many tickets at once instead of one session per employee', () => {
    const { plans } = plan([issue('SC-1'), issue('SC-2'), issue('SC-3')]);
    expect(plans).toHaveLength(3);
    expect(new Set(plans.map((p) => p.agent))).toEqual(new Set(['company/developer']));
  });

  test('never exceeds the pool and counts already-running work against it', () => {
    const { plans, capacity } = plan([issue('SC-1'), issue('SC-2'), issue('SC-3')], {
      runningByTicket: new Set(['SC-9']),
      maxConcurrent: 2,
    });
    expect(capacity).toBe(1);
    expect(plans.map((p) => p.ticketKey)).toEqual(['SC-1']);
  });

  test('skips tickets that must not be dispatched, with a reason each', () => {
    const { plans, skipped } = plan([
      issue('SC-1', { status: 'Done' }),
      issue('SC-2', { assigneeId: null }),
      issue('SC-3', { assigneeId: 'ghost' }),
      issue('SC-4', { assigneeId: 'nobody' }),
      issue('SC-5'),
    ], { runningByTicket: new Set(['SC-5']) });
    expect(plans).toHaveLength(0);
    expect(skipped).toEqual([
      { key: 'SC-1', reason: 'status_not_dispatchable' },
      { key: 'SC-2', reason: 'unassigned' },
      { key: 'SC-3', reason: 'no_agent_for_role' },
      { key: 'SC-4', reason: 'unassigned' },
      { key: 'SC-5', reason: 'already_running' },
    ]);
  });

  test('carries Jira acceptance criteria into the prompt without rewriting them', () => {
    const { plans } = plan([issue('SC-7', { acceptanceCriteria: 'Given X\nThen Y' })]);
    expect(plans[0].prompt).toContain('Given X\nThen Y');
    expect(plans[0].prompt).toContain('Jira es la autoridad');
  });

  test('uses the configured issue-type role instead of the assignee roster role', () => {
    const rolesById = new Map([
      ['cto', { id: 'cto', title: 'CTO', permission: [{ permission: '*', pattern: '*', action: 'ask' }] }],
    ]);
    const { plans } = plan([issue('SC-8', { type: 'Epic' })], {
      rolesById,
      aiopsRouting: parseAiopsRouting({
        schemaVersion: 2,
        mode: 'custom',
        routes: [{ issueType: 'Epic', status: '*', role: 'cto', action: 'design' }],
      }),
    });
    expect(plans[0].agent).toBe('company/cto');
    expect(plans[0].prompt).toContain('Rol asignado: CTO');
    expect(plans[0].prompt).toContain('Fase AIOPS: design');
    expect(plans[0].title).toContain('[SC-8][design]');
  });
});

const dispatcherWith = (fetchImpl, overrides = {}) => createTicketDispatcher({
  fetchImpl,
  buildOpenCodeUrl: () => 'http://opencode.test/session',
  model: { providerID: 'p', modelID: 'm' },
  now: () => 1000,
  ...overrides,
});

describe('ticket dispatcher transport', () => {
  test('binds the agent at creation and repeats it in the dispatch body', async () => {
    const calls = [];
    const dispatcher = dispatcherWith(async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ id: 'ses_1' }), { status: 200 });
    });
    const worker = await dispatcher.spawn({
      ticketKey: 'SC-21', agent: 'company/developer', directory: '/srv/repo-a', title: '[SC-21] x', prompt: 'do it',
    });
    expect(worker).toMatchObject({ ticketKey: 'SC-21', sessionId: 'ses_1', agent: 'company/developer' });
    expect(calls[0].url).toBe('http://opencode.test/session');
    expect(calls[0].body).toMatchObject({ agent: 'company/developer', location: { directory: '/srv/repo-a' } });
    expect(calls[1].url).toBe('http://opencode.test/session/ses_1/prompt_async');
    expect(calls[1].body.agent).toBe('company/developer');
  });

  test('one failing spawn does not cancel the rest and degrades to partial', async () => {
    let creates = 0;
    const dispatcher = dispatcherWith(async (url) => {
      if (String(url).endsWith('/session')) {
        creates += 1;
        // the second ticket's create is rejected by OpenCode
        return creates === 2
          ? new Response('{}', { status: 500 })
          : new Response(JSON.stringify({ id: `ses_${creates}` }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });

    const result = await dispatcher.spawnAll([
      { ticketKey: 'SC-1', agent: 'company/developer', directory: '/d', title: 't', prompt: 'p' },
      { ticketKey: 'SC-2', agent: 'company/devops', directory: '/d', title: 't', prompt: 'p' },
      { ticketKey: 'SC-3', agent: 'company/sre', directory: '/d', title: 't', prompt: 'p' },
    ]);

    expect(result.state).toBe('partial');
    expect(result.started.map((w) => w.ticketKey)).toEqual(['SC-1', 'SC-3']);
    expect(result.failed).toEqual([{ ticketKey: 'SC-2', error: 'Dispatch create for SC-2 failed (500)' }]);
  });

  test('reuses only the same AIOPS phase and replaces a session when ownership changes', async () => {
    const calls = [];
    const dispatcher = dispatcherWith(async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method ?? 'GET' });
      if (String(url).endsWith('/session')) return new Response(JSON.stringify({ id: 'ses_new' }), { status: 200 });
      return new Response('{}', { status: 200 });
    });
    const same = await dispatcher.spawnAll([
      { ticketKey: 'SC-1', agent: 'company/qa', phase: 'review', directory: '/d', title: 't', prompt: 'p' },
    ], new Map([['SC-1', { sessionId: 'ses_old', agent: 'company/qa', phase: 'review' }]]));
    expect(same.reused).toHaveLength(1);
    expect(calls.some((call) => call.url.endsWith('/session'))).toBe(false);

    calls.length = 0;
    const changed = await dispatcher.spawnAll([
      { ticketKey: 'SC-1', agent: 'company/devops', phase: 'deploy', directory: '/d', title: 't', prompt: 'p' },
    ], new Map([['SC-1', { sessionId: 'ses_old', agent: 'company/qa', phase: 'review' }]]));
    expect(changed.started[0].sessionId).toBe('ses_new');
    expect(calls.slice(0, 2)).toEqual([
      { url: 'http://opencode.test/session/ses_old', method: 'PATCH' },
      { url: 'http://opencode.test/session', method: 'POST' },
    ]);
  });

  test('rejects a create that returns no session id instead of inventing one', async () => {
    const dispatcher = dispatcherWith(async () => new Response(JSON.stringify({ data: {} }), { status: 200 }));
    await expect(dispatcher.spawn({ ticketKey: 'SC-1', agent: 'a', directory: '/d', title: 't', prompt: 'p' }))
      .rejects.toThrow(/no session id/);
  });

  test('aborts only the worker past its deadline and leaves the healthy ones alone', async () => {
    const aborted = [];
    const dispatcher = dispatcherWith(async (url, options) => {
      const href = String(url);
      if (href.endsWith('/session/status')) {
        return new Response(JSON.stringify({ ses_slow: { type: 'busy' }, ses_fast: { type: 'busy' } }), { status: 200 });
      }
      if (href.endsWith('/abort')) { aborted.push(href); return new Response('{}', { status: 200 }); }
      return new Response('{}', { status: 200, ...options });
    }, { now: () => 100000, turnDeadlineMs: 5000 });

    const result = await dispatcher.supervise([
      { ticketKey: 'SC-1', sessionId: 'ses_slow', startedAt: 0 },
      { ticketKey: 'SC-2', sessionId: 'ses_fast', startedAt: 99000 },
      { ticketKey: 'SC-3', sessionId: 'ses_gone', startedAt: 0 },
    ]);

    expect(result.aborted.map((w) => w.ticketKey)).toEqual(['SC-1']);
    expect(result.busy.map((w) => w.ticketKey)).toEqual(['SC-2']);
    expect(result.finished.map((w) => w.ticketKey)).toEqual(['SC-3']);
    expect(aborted).toEqual(['http://opencode.test/session/ses_slow/abort']);
  });

  test('refuses to guess when the status map is unusable', async () => {
    const dispatcher = dispatcherWith(async () => new Response(JSON.stringify([]), { status: 200 }));
    await expect(dispatcher.supervise([])).rejects.toThrow(/unusable status map/);
  });

  test('retires workers by archiving, and reports partial when one refuses', async () => {
    const dispatcher = dispatcherWith(async (url) => (
      String(url).includes('ses_stuck') ? new Response('{}', { status: 500 }) : new Response('{}', { status: 200 })
    ));
    const result = await dispatcher.retire([
      { ticketKey: 'SC-1', sessionId: 'ses_ok' },
      { ticketKey: 'SC-2', sessionId: 'ses_stuck' },
    ]);
    expect(result.state).toBe('partial');
    expect(result.retired.map((w) => w.ticketKey)).toEqual(['SC-1']);
  });
});

describe('the ticket says where it is worked', () => {
  test('prefers the ticket repo over the roster directory', () => {
    const { plans } = plan([issue('SC-1', { repo: '/srv/service-x' })]);
    expect(plans[0].directory).toBe('/srv/service-x');
  });

  test('falls back to the roster directory when repoField is not configured', () => {
    const { plans } = plan([issue('SC-1', { repo: null })]);
    expect(plans[0].directory).toBe('/srv/repo-a');
  });

  test('refuses to guess a directory when neither the ticket nor the roster has one', () => {
    const employees = new Map([['dev-one', { id: 'dev-one', role: 'developer', directory: null }]]);
    const { plans, skipped } = plan([issue('SC-1', { repo: null })], { employeesById: employees });
    expect(plans).toHaveLength(0);
    expect(skipped).toEqual([{ key: 'SC-1', reason: 'no_repo' }]);
  });
});

describe('the session pointer goes back to Jira', () => {
  const okFetch = async (url) => (
    String(url).endsWith('/session')
      ? new Response(JSON.stringify({ id: 'ses_written' }), { status: 200 })
      : new Response('{}', { status: 200 })
  );

  test('records the session id against the ticket after dispatching', async () => {
    const recorded = [];
    const dispatcher = dispatcherWith(okFetch, {
      recordSession: async (key, sessionId) => { recorded.push([key, sessionId]); },
    });
    const worker = await dispatcher.spawn({
      ticketKey: 'SC-21', agent: 'company/developer', directory: '/d', title: 't', prompt: 'p',
    });
    expect(recorded).toEqual([['SC-21', 'ses_written']]);
    expect(worker.recorded).toBe(true);
  });

  test('keeps the worker alive when recording fails but reports the lost pointer', async () => {
    const dispatcher = dispatcherWith(okFetch, {
      recordSession: async () => { throw new Error('Jira session record on SC-21 failed (403)'); },
    });
    const result = await dispatcher.spawnAll([
      { ticketKey: 'SC-21', agent: 'company/developer', directory: '/d', title: 't', prompt: 'p' },
    ]);
    expect(result.started).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
    expect(result.unrecorded.map((w) => w.ticketKey)).toEqual(['SC-21']);
    expect(result.state).toBe('partial');
  });

  test('leaves recorded null when no recorder is wired', async () => {
    const dispatcher = dispatcherWith(okFetch);
    const worker = await dispatcher.spawn({
      ticketKey: 'SC-21', agent: 'company/developer', directory: '/d', title: 't', prompt: 'p',
    });
    expect(worker.recorded).toBeNull();
  });
});

describe('roles configured as data travel with the session', () => {
  const rolesById = new Map([['developer', {
    id: 'developer',
    title: 'Developer',
    model: { providerID: 'litellm-auto', modelID: 'cloudblue/gpt-5.6-luna' },
    promptHint: 'entrega con tests',
    permission: [
      { permission: '*', pattern: '*', action: 'ask' },
      { permission: 'bash', pattern: 'kubectl *', action: 'deny' },
    ],
  }]]);

  test('carries the role identity, and no longer its boundary', () => {
    const { plans } = plan([issue('SC-21')], { rolesById });
    // Permissions moved to the role folder: a plan that still carried them would
    // be a second source of truth for the same boundary.
    expect(plans[0].permission).toBeUndefined();
    expect(plans[0].prompt).toContain('entrega con tests');
    expect(plans[0].prompt).toContain('Rol asignado: Developer');
  });

  test('skips a ticket whose role the installation has not configured', () => {
    const { plans, skipped } = plan([issue('SC-1', { assigneeId: 'ops-one' })], { rolesById });
    expect(plans).toHaveLength(0);
    expect(skipped).toEqual([{ key: 'SC-1', reason: 'role_not_configured' }]);
  });

  test('no longer sends a ruleset inline, because the role folder owns it', async () => {
    const calls = [];
    const dispatcher = dispatcherWith(async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ id: 'ses_1' }), { status: 200 });
    });
    const { plans } = plan([issue('SC-21')], { rolesById });
    await dispatcher.spawn(plans[0]);

    // Nothing inline: the boundary is the role folder now, applied by the engine
    // (`--settings` on Claude, `-c` on Codex, the agent file on OpenCode).
    expect(calls[0].body.permission).toBeUndefined();
    // prompt_async wants {providerID, modelID}; /session wants {id, providerID}.
    // The dispatch path sends the model on the prompt, so this is the prompt shape.
    // It comes from the dispatcher config now: choosing the model was never the
    // work tracker's job, and a role no longer carries one.
    expect(calls[1].body.model).toEqual({ providerID: 'p', modelID: 'm' });
  });

  test('omits permission entirely when no role data is configured', async () => {
    const calls = [];
    const dispatcher = dispatcherWith(async (url, options) => {
      calls.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ id: 'ses_1' }), { status: 200 });
    });
    const { plans } = plan([issue('SC-21')]);
    await dispatcher.spawn(plans[0]);
    expect(calls[0]).not.toHaveProperty('permission');
    expect(calls[0].agent).toBe('company/developer');
  });
});

describe('agentForRole', () => {
  test('maps the roster shorthand dev to the developer agent on disk', () => {
    expect(agentForRole('dev')).toBe('company/developer');
    expect(agentForRole('qa')).toBe('company/qa');
    expect(agentForRole('CTO')).toBe('company/cto');
    expect(agentForRole('')).toBe(null);
  });
});

describe('planDispatch consumes real tracker issues', () => {
  test('dispatches an issue that only carries assigneeAccountId, as the Jira tracker emits', () => {
    const { plans, skipped } = planDispatch({
      issues: [{ key: 'SC-1', status: 'In Progress', summary: 'Real shape', assigneeAccountId: 'acc-1', repo: '/srv/repo' }],
      employeesById: new Map([['acc-1', { id: 'dev-hugo', role: 'dev', directory: '/srv/office' }]]),
      runningByTicket: new Map(),
      dispatchableStatuses: ['In Progress'],
    });
    expect(skipped).toEqual([]);
    expect(plans).toHaveLength(1);
    expect(plans[0].agent).toBe('company/developer');
    expect(plans[0].directory).toBe('/srv/repo');
  });
});

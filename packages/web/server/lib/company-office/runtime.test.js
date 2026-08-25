import { describe, expect, test } from 'vitest';
import { createCompanyOfficeService } from './runtime.js';

const config = JSON.stringify({
  schemaVersion: 1,
  company: { id: 'example-company', displayName: 'Example Company' },
  roster: { manifestPath: '/config/company.yaml', registryPath: '/state/registry.json' },
  intake: { employeeId: 'cto', sessionTitle: 'CEO office' },
  workTracker: {
    provider: 'jira',
    jira: {
      baseUrl: 'https://jira.example.test',
      projectKey: 'SC',
      email: 'automation@example.test',
      tokenFile: '/secrets/jira-token',
      initiativeIssueTypes: ['Story'],
    },
  },
});

const manifest = `
company:
  ceo:
    name: Example Lead
employees:
  - id: cto
    persona: Technical Lead
    role: cto
    model: claude/fable
  - id: dev
    persona: Developer One
    role: dev
    specialty: frontend
    model: openai/sol
`;

const registry = JSON.stringify({
  cto: { directory: '/company/cto/office', model: 'claude/fable' },
  dev: { directory: '/company/dev/office', model: 'openai/sol' },
});

const createFs = (overrides = {}) => ({
  readFile: async (path) => ({
    '/config/office.json': config,
    '/config/company.yaml': manifest,
    '/state/registry.json': registry,
    '/secrets/jira-token': 'secret-token',
    ...overrides,
  })[path],
});

describe('Company Office service', () => {
  test('joins roster, live sessions, activity, Jira initiatives, and the CTO intake session', async () => {
    const fetchCalls = [];
    const fetchImpl = async (input, options) => {
      const url = String(input);
      fetchCalls.push({ url, authorization: options?.headers?.Authorization });
      if (url.includes('/session/status?') && url.includes(encodeURIComponent('/company/cto/office'))) {
        return new Response(JSON.stringify({ 'ses-max': { type: 'busy' } }), { status: 200 });
      }
      if (url.includes('/session/status?')) return new Response('{}', { status: 200 });
      if (url.includes('/experimental/session?') && url.includes(encodeURIComponent('/company/cto/office'))) {
        return new Response(JSON.stringify([
          { id: 'ses-max', title: 'CEO office', directory: '/company/cto/office', time: { updated: 3 } },
          { id: 'ses-sc21', title: '[SC-21] Architecture', directory: '/company/cto/office', time: { updated: 2 } },
          { id: 'ses-old', title: '[SC-20] Old', directory: '/company/cto/office', time: { archived: 4 } },
        ]), { status: 200 });
      }
      if (url.includes('/experimental/session?')) {
        return new Response(JSON.stringify([
          { id: 'ses-sc22', title: '[SC-22] Build', directory: '/company/dev/office', time: { updated: 1 } },
        ]), { status: 200 });
      }
      if (url.startsWith('https://jira.example.test/')) {
        return new Response(JSON.stringify({ issues: [
          { key: 'SC-16', fields: { summary: 'Governance', status: { name: 'Backlog' }, issuetype: { name: 'Story' }, updated: '2026-08-17' } },
          { key: 'SC-21', fields: { summary: 'Architecture', status: { name: 'In Progress' }, issuetype: { name: 'Subtask' }, parent: { key: 'SC-16' }, assignee: { displayName: 'Technical Lead' }, updated: '2026-08-17' } },
          { key: 'SC-22', fields: { summary: 'Build', status: { name: 'Backlog' }, issuetype: { name: 'Subtask' }, parent: { key: 'SC-16' }, assignee: { displayName: 'Developer One' }, updated: '2026-08-17' } },
        ] }), { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };
    const service = createCompanyOfficeService({
      fsPromises: createFs(),
      fetchImpl,
      buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer opencode' }),
      configPath: '/config/office.json',
    });

    const snapshot = await service.getSnapshot();

    expect(snapshot.company).toMatchObject({ displayName: 'Example Company', ceo: 'Example Lead' });
    expect(snapshot.intakeSession).toMatchObject({ id: 'ses-max', directory: '/company/cto/office' });
    expect(snapshot.employees[0]).toMatchObject({ id: 'cto', activity: 'busy', sessionsAvailable: true });
    expect(snapshot.employees[0].sessions.map((session) => session.id)).toEqual(['ses-max', 'ses-sc21']);
    expect(snapshot.initiatives[0].tickets[0]).toMatchObject({
      key: 'SC-21',
      mapping: 'reconstructed',
      session: { id: 'ses-sc21' },
    });
    expect(snapshot.initiatives[0]).toMatchObject({ key: 'SC-16', mapping: 'none', session: null });
    expect(snapshot.mappingMode).toBe('reconstructed');
    expect(fetchCalls.find((call) => call.url.startsWith('https://jira.example.test/'))?.authorization).toMatch(/^Basic /);
    expect(JSON.stringify(snapshot)).not.toContain('secret-token');
  });

  test('gives an epic its own session and marks duplicate epic sessions ambiguous', async () => {
    const buildService = (ctoSessions) => createCompanyOfficeService({
      fsPromises: createFs(),
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes('/session/status?')) return new Response('{}', { status: 200 });
        if (url.includes('/experimental/session?') && url.includes(encodeURIComponent('/company/cto/office'))) {
          return new Response(JSON.stringify(ctoSessions), { status: 200 });
        }
        if (url.includes('/experimental/session?')) return new Response('[]', { status: 200 });
        return new Response(JSON.stringify({ issues: [
          { key: 'SC-16', fields: { summary: 'Governance', status: { name: 'Backlog' }, issuetype: { name: 'Story' } } },
        ] }), { status: 200 });
      },
      buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      configPath: '/config/office.json',
    });

    const owned = await buildService([
      { id: 'ses-sc16', title: '[SC-16] Governance', directory: '/company/cto/office', time: { updated: 3 } },
    ]).getSnapshot();
    expect(owned.initiatives[0]).toMatchObject({
      key: 'SC-16',
      mapping: 'reconstructed',
      session: { id: 'ses-sc16', directory: '/company/cto/office' },
    });

    const ambiguous = await buildService([
      { id: 'ses-sc16-a', title: '[SC-16] Governance', directory: '/company/cto/office', time: { updated: 3 } },
      { id: 'ses-sc16-b', title: '[SC-16] Governance retry', directory: '/company/cto/office', time: { updated: 2 } },
    ]).getSnapshot();
    expect(ambiguous.initiatives[0]).toMatchObject({ key: 'SC-16', mapping: 'ambiguous', session: null });
  });

  test('reports Jira failure without turning live employee sessions into empty failure', async () => {
    const service = createCompanyOfficeService({
      fsPromises: createFs(),
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes('/session/status?')) return new Response('{}', { status: 200 });
        if (url.includes('/experimental/session?')) return new Response('[]', { status: 200 });
        return new Response('{}', { status: 503 });
      },
      buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      configPath: '/config/office.json',
    });

    const snapshot = await service.getSnapshot();
    expect(snapshot.sources.jira).toBe('error');
    expect(snapshot.sources.sessions).toBe('ready');
    expect(snapshot.initiatives).toEqual([]);
    expect(snapshot.employees).toHaveLength(2);
  });

  test('keeps authoritative busy activity when the employee session list fails', async () => {
    const service = createCompanyOfficeService({
      fsPromises: createFs(),
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes('/session/status?') && url.includes(encodeURIComponent('/company/cto/office'))) {
          return new Response(JSON.stringify({ 'ses-max': { type: 'busy' } }), { status: 200 });
        }
        if (url.includes('/session/status?')) return new Response('{}', { status: 200 });
        if (url.includes('/experimental/session?') && url.includes(encodeURIComponent('/company/cto/office'))) {
          return new Response('{}', { status: 503 });
        }
        if (url.includes('/experimental/session?')) return new Response('[]', { status: 200 });
        return new Response(JSON.stringify({ issues: [] }), { status: 200 });
      },
      buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      configPath: '/config/office.json',
    });

    const snapshot = await service.getSnapshot();
    expect(snapshot.sources.sessions).toBe('partial');
    expect(snapshot.sources.activity).toBe('ready');
    expect(snapshot.employees[0]).toMatchObject({ sessionsAvailable: false, activity: 'busy' });
  });

  test('marks capped Jira pagination as partial instead of complete', async () => {
    let jiraPages = 0;
    const service = createCompanyOfficeService({
      fsPromises: createFs(),
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes('/session/status?')) return new Response('{}', { status: 200 });
        if (url.includes('/experimental/session?')) return new Response('[]', { status: 200 });
        jiraPages += 1;
        return new Response(JSON.stringify({ issues: [], nextPageToken: `page-${jiraPages + 1}` }), { status: 200 });
      },
      buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      configPath: '/config/office.json',
    });

    const snapshot = await service.getSnapshot();
    expect(jiraPages).toBe(5);
    expect(snapshot.sources.jira).toBe('partial');
  });

  test('reconstructs mappings for every configured Jira project-key shape', async () => {
    const customConfig = JSON.stringify({
      ...JSON.parse(config),
      workTracker: {
        ...JSON.parse(config).workTracker,
        jira: { ...JSON.parse(config).workTracker.jira, projectKey: 'TEAM_X' },
      },
    });
    const service = createCompanyOfficeService({
      fsPromises: createFs({ '/config/office.json': customConfig }),
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes('/session/status?')) return new Response('{}', { status: 200 });
        if (url.includes('/experimental/session?') && url.includes(encodeURIComponent('/company/cto/office'))) {
          return new Response(JSON.stringify([
            { id: 'ses-team', title: '[TEAM_X-12] Build', directory: '/company/cto/office', time: { updated: 1 } },
          ]), { status: 200 });
        }
        if (url.includes('/experimental/session?')) return new Response('[]', { status: 200 });
        return new Response(JSON.stringify({ issues: [
          { key: 'TEAM_X-1', fields: { summary: 'Initiative', status: { name: 'In Progress' }, issuetype: { name: 'Story' } } },
          { key: 'TEAM_X-12', fields: { summary: 'Build', status: { name: 'In Progress' }, issuetype: { name: 'Subtask' }, parent: { key: 'TEAM_X-1' } } },
        ] }), { status: 200 });
      },
      buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      configPath: '/config/office.json',
    });

    const snapshot = await service.getSnapshot();
    expect(snapshot.initiatives[0].tickets[0]).toMatchObject({
      key: 'TEAM_X-12',
      mapping: 'reconstructed',
      session: { id: 'ses-team' },
    });
  });

  test('marks tied session pagination boundaries as partial', async () => {
    let ctoSessionPages = 0;
    const service = createCompanyOfficeService({
      fsPromises: createFs(),
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes('/session/status?')) return new Response('{}', { status: 200 });
        if (url.includes('/experimental/session?') && url.includes(encodeURIComponent('/company/cto/office'))) {
          ctoSessionPages += 1;
          if (ctoSessionPages > 1) return new Response('[]', { status: 200 });
          return new Response(JSON.stringify(Array.from({ length: 200 }, (_, index) => ({
            id: `ses-${index}`,
            title: `Session ${index}`,
            directory: '/company/cto/office',
            time: { updated: 10 },
          }))), { status: 200 });
        }
        if (url.includes('/experimental/session?')) return new Response('[]', { status: 200 });
        return new Response(JSON.stringify({ issues: [] }), { status: 200 });
      },
      buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      configPath: '/config/office.json',
    });

    const snapshot = await service.getSnapshot();
    expect(ctoSessionPages).toBe(2);
    expect(snapshot.sources.sessions).toBe('partial');
    expect(snapshot.employees[0].sessions).toHaveLength(200);
  });

  test('keeps valid sessions and marks the source partial when one session directory is malformed', async () => {
    const service = createCompanyOfficeService({
      fsPromises: createFs(),
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes('/session/status?')) return new Response('{}', { status: 200 });
        if (url.includes('/experimental/session?') && url.includes(encodeURIComponent('/company/cto/office'))) {
          return new Response(JSON.stringify([
            { id: 'ses-valid', title: 'CEO office', directory: '/company/cto/office', time: { updated: 2 } },
            { id: 'ses-malformed', title: 'Malformed', directory: '  ', time: { updated: 1 } },
          ]), { status: 200 });
        }
        if (url.includes('/experimental/session?')) return new Response('[]', { status: 200 });
        return new Response(JSON.stringify({ issues: [] }), { status: 200 });
      },
      buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      configPath: '/config/office.json',
    });

    const snapshot = await service.getSnapshot();
    expect(snapshot.sources.sessions).toBe('partial');
    expect(snapshot.employees[0].sessions.map((session) => session.id)).toEqual(['ses-valid']);
  });

  test('marks missing session identities partial while ignoring valid filtered rows', async () => {
    const service = createCompanyOfficeService({
      fsPromises: createFs(),
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes('/session/status?')) return new Response('{}', { status: 200 });
        if (url.includes('/experimental/session?') && url.includes(encodeURIComponent('/company/cto/office'))) {
          return new Response(JSON.stringify([
            { id: 'ses-valid', title: 'Valid', directory: '/company/cto/office', time: { updated: 3 } },
            { title: 'Missing ID', directory: '/company/cto/office', time: { updated: 2 } },
            { id: '  ses-padded  ', title: 'Padded ID', directory: '/company/cto/office', time: { updated: 2 } },
            { id: 'ses-child', parentID: 'parent', directory: '/company/cto/office', time: { updated: 1 } },
          ]), { status: 200 });
        }
        if (url.includes('/experimental/session?')) return new Response('[]', { status: 200 });
        return new Response(JSON.stringify({ issues: [] }), { status: 200 });
      },
      buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      configPath: '/config/office.json',
    });

    const snapshot = await service.getSnapshot();
    expect(snapshot.sources.sessions).toBe('partial');
    expect(snapshot.employees[0].sessions.map((session) => session.id)).toEqual(['ses-valid']);
  });

  test('marks malformed activity rows partial without converting them to authoritative idle', async () => {
    const service = createCompanyOfficeService({
      fsPromises: createFs(),
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes('/session/status?') && url.includes(encodeURIComponent('/company/cto/office'))) {
          return new Response(JSON.stringify({
            'ses-busy': { type: 'busy' },
            'ses-invalid': { type: 'retry', attempt: 1 },
            '   ': { type: 'busy' },
          }), { status: 200 });
        }
        if (url.includes('/session/status?')) return new Response('{}', { status: 200 });
        if (url.includes('/experimental/session?') && url.includes(encodeURIComponent('/company/cto/office'))) {
          return new Response(JSON.stringify([
            { id: 'ses-busy', title: 'Busy', directory: '/company/cto/office', time: { updated: 2 } },
            { id: 'ses-invalid', title: 'Unknown', directory: '/company/cto/office', time: { updated: 1 } },
          ]), { status: 200 });
        }
        if (url.includes('/experimental/session?')) return new Response('[]', { status: 200 });
        return new Response(JSON.stringify({ issues: [] }), { status: 200 });
      },
      buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      configPath: '/config/office.json',
    });

    const snapshot = await service.getSnapshot();
    expect(snapshot.sources.activity).toBe('partial');
    expect(snapshot.employees[0]).toMatchObject({ activity: 'busy', activityAvailable: false });
    expect(snapshot.employees[0].sessions.map(({ id, activity }) => ({ id, activity }))).toEqual([
      { id: 'ses-busy', activity: 'busy' },
      { id: 'ses-invalid', activity: 'unknown' },
    ]);
  });

  test('rejects duplicate employee IDs before issuing upstream requests', async () => {
    const duplicateManifest = `${manifest}\n  - id: cto\n    persona: Duplicate Lead\n    role: cto\n`;
    let fetchCount = 0;
    const service = createCompanyOfficeService({
      fsPromises: createFs({ '/config/company.yaml': duplicateManifest }),
      fetchImpl: async () => {
        fetchCount += 1;
        return new Response('{}', { status: 200 });
      },
      buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      configPath: '/config/office.json',
    });

    await expect(service.getSnapshot()).rejects.toThrow(/Duplicate Company Office employee/);
    expect(fetchCount).toBe(0);
  });

  test('rejects an empty roster instead of reporting synthetic upstream errors', async () => {
    const emptyManifest = `company:\n  ceo:\n    name: Example Lead\nemployees: []\n`;
    const service = createCompanyOfficeService({
      fsPromises: createFs({ '/config/company.yaml': emptyManifest }),
      fetchImpl: async () => new Response('{}', { status: 200 }),
      buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      configPath: '/config/office.json',
    });

    await expect(service.getSnapshot()).rejects.toThrow(/at least one employee/);
  });
});

describe('three levels, because that is what Jira enforces', () => {
  const fs = (issues) => ({
    readFile: async (path) => {
      if (path === '/config/office.json') return config;
      if (path === '/config/company.yaml') return manifest;
      if (path === '/state/registry.json') return registry;
      if (path === '/secrets/jira-token') return 'private-token';
      return '';
    },
  });

  const build = async (jiraIssues) => {
    const service = createCompanyOfficeService({
      fsPromises: fs(),
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.startsWith('https://jira.example.test/')) {
          return new Response(JSON.stringify({ issues: jiraIssues }), { status: 200 });
        }
        if (url.includes('/session/status')) return new Response('{}', { status: 200 });
        return new Response('[]', { status: 200 });
      },
      buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      configPath: '/config/office.json',
    });
    return service.getSnapshot();
  };

  const jira = (key, type, status, parent) => ({
    key,
    fields: {
      summary: key,
      status: { name: status },
      issuetype: { name: type },
      ...(parent ? { parent: { key: parent } } : {}),
    },
  });

  test('nests subtasks under their story instead of dropping them', async () => {
    const snapshot = await build([
      jira('SC-1', 'Story', 'In Progress'),
      jira('SC-10', 'Story', 'In Progress', 'SC-1'),
      jira('SC-11', 'Subtask', 'Done', 'SC-10'),
      jira('SC-12', 'Subtask', 'In Progress', 'SC-10'),
    ]);
    const initiative = snapshot.initiatives.find((i) => i.key === 'SC-1');
    expect(initiative.tickets.map((t) => t.key)).toEqual(['SC-10']);
    expect(initiative.tickets[0].subtasks.map((s) => s.key)).toEqual(['SC-11', 'SC-12']);
  });

  test('counts subtasks too, so progress is not overstated', async () => {
    const snapshot = await build([
      jira('SC-1', 'Story', 'In Progress'),
      jira('SC-10', 'Story', 'In Progress', 'SC-1'),
      jira('SC-11', 'Subtask', 'Done', 'SC-10'),
      jira('SC-12', 'Subtask', 'Done', 'SC-10'),
    ]);
    const initiative = snapshot.initiatives.find((i) => i.key === 'SC-1');
    expect(initiative.counts).toEqual({ 'in-progress': 1, done: 2 });
  });

  test('a story with no subtasks reports an empty list, never undefined', async () => {
    const snapshot = await build([
      jira('SC-1', 'Story', 'In Progress'),
      jira('SC-10', 'Story', 'Backlog', 'SC-1'),
    ]);
    expect(snapshot.initiatives[0].tickets[0].subtasks).toEqual([]);
  });
});

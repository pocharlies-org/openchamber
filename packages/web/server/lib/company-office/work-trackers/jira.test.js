import { describe, expect, test } from 'vitest';
import { createJiraWorkTracker } from './jira.js';

const config = {
  baseUrl: 'https://jira.example.test',
  projectKey: 'ENG',
  email: 'automation@example.test',
  tokenFile: '/secrets/token',
  initiativeIssueTypes: ['Initiative'],
};

describe('Jira work tracker', () => {
  test('returns normalized work items without disclosing its token', async () => {
    let authorization = '';
    const tracker = createJiraWorkTracker({
      config,
      fsPromises: { readFile: async () => 'private-token' },
      fetchImpl: async (_url, options) => {
        authorization = options.headers.Authorization;
        return new Response(JSON.stringify({ issues: [{
          key: 'ENG-1',
          fields: {
            summary: 'Initiative',
            status: { name: 'Backlog' },
            issuetype: { name: 'Initiative' },
          },
        }] }), { status: 200 });
      },
    });
    const snapshot = await tracker.loadSnapshot();
    expect(authorization).toMatch(/^Basic /);
    expect(snapshot).toEqual({
      state: 'ready',
      issues: [{
        key: 'ENG-1',
        summary: 'Initiative',
        status: 'Backlog',
        type: 'Initiative',
        assignee: null,
        assigneeAccountId: null,
        reporter: null,
        parentKey: null,
        updatedAt: null,
        url: 'https://jira.example.test/browse/ENG-1',
        acceptanceCriteria: null,
        sessionId: null,
        repo: null,
      }],
    });
    expect(JSON.stringify(snapshot)).not.toContain('private-token');
  });

  test('loadIssue reads one issue authoritatively and returns null on 404', async () => {
    let requestedUrl = '';
    let sentFields = '';
    const tracker = createJiraWorkTracker({
      config,
      fsPromises: { readFile: async () => 'private-token' },
      fetchImpl: async (url, options) => {
        requestedUrl = String(url);
        sentFields = options.searchParams?.get('fields') ?? '';
        if (String(url).includes('/issue/ENG-404')) return new Response('{}', { status: 404 });
        return new Response(JSON.stringify({
          key: 'ENG-7',
          fields: {
            summary: 'Ship it',
            status: { name: 'To Do' },
            issuetype: { name: 'Epic' },
            assignee: { displayName: 'me+max', accountId: 'acct-max' },
          },
        }), { status: 200 });
      },
    });
    const issue = await tracker.loadIssue('ENG-7');
    expect(requestedUrl).toContain('/rest/api/3/issue/ENG-7');
    expect(sentFields).toContain('issuetype');
    expect(sentFields).toContain('assignee');
    expect(issue).toMatchObject({ key: 'ENG-7', type: 'Epic', status: 'To Do', assignee: 'me+max', assigneeAccountId: 'acct-max' });
    expect(await tracker.loadIssue('ENG-404')).toBeNull();
  });

  test('flattens acceptance criteria from ADF and plain-text custom fields', async () => {
    let requestedFields = '';
    const tracker = createJiraWorkTracker({
      config: { ...config, acceptanceCriteriaField: 'customfield_10001' },
      fsPromises: { readFile: async () => 'private-token' },
      fetchImpl: async (url) => {
        requestedFields = new URL(url).searchParams.get('fields');
        return new Response(JSON.stringify({ issues: [
          {
            key: 'ENG-1',
            fields: {
              summary: 'Epic',
              issuetype: { name: 'Initiative' },
              customfield_10001: {
                type: 'doc',
                content: [
                  { type: 'paragraph', content: [{ type: 'text', text: 'Given a snapshot' }] },
                  { type: 'bulletList', content: [
                    { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Jira stays authoritative' }] }] },
                  ] },
                ],
              },
            },
          },
          {
            key: 'ENG-2',
            fields: { summary: 'Child', issuetype: { name: 'Subtask' }, customfield_10001: '  plain text  ' },
          },
        ] }), { status: 200 });
      },
    });
    const snapshot = await tracker.loadSnapshot();
    expect(requestedFields).toContain('customfield_10001');
    expect(snapshot.issues[0].acceptanceCriteria).toBe('Given a snapshot\nJira stays authoritative');
    expect(snapshot.issues[1].acceptanceCriteria).toBe('plain text');
  });

  test('bounds acceptance criteria and never emits an empty string', async () => {
    const tracker = createJiraWorkTracker({
      config: { ...config, acceptanceCriteriaField: 'description' },
      fsPromises: { readFile: async () => 'private-token' },
      fetchImpl: async () => new Response(JSON.stringify({ issues: [
        { key: 'ENG-1', fields: { summary: 'Long', issuetype: { name: 'Initiative' }, description: 'x'.repeat(5000) } },
        { key: 'ENG-2', fields: { summary: 'Blank', issuetype: { name: 'Initiative' }, description: { type: 'doc', content: [] } } },
      ] }), { status: 200 }),
    });
    const snapshot = await tracker.loadSnapshot();
    expect(snapshot.issues[0].acceptanceCriteria).toHaveLength(2000);
    expect(snapshot.issues[1].acceptanceCriteria).toBeNull();
  });

  test('preserves incomplete pagination as partial', async () => {
    let pages = 0;
    const tracker = createJiraWorkTracker({
      config,
      fsPromises: { readFile: async () => 'private-token' },
      fetchImpl: async () => {
        pages += 1;
        return new Response(JSON.stringify({ issues: [], nextPageToken: `page-${pages}` }), { status: 200 });
      },
    });
    expect(await tracker.loadSnapshot()).toEqual({ state: 'partial', issues: [] });
    expect(pages).toBe(5);
  });

  test('marks malformed Jira issues as partial instead of authoritative complete data', async () => {
    const tracker = createJiraWorkTracker({
      config,
      fsPromises: { readFile: async () => 'private-token' },
      fetchImpl: async () => new Response(JSON.stringify({ issues: [
        { key: 'ENG-1', fields: { summary: 'Valid', issuetype: { name: 'Initiative' } } },
        { key: 'ENG-2', fields: { status: { name: 'Backlog' } } },
      ] }), { status: 200 }),
    });
    const snapshot = await tracker.loadSnapshot();
    expect(snapshot.state).toBe('partial');
    expect(snapshot.issues.map((issue) => issue.key)).toEqual(['ENG-1']);
  });

  test('marks a non-final Jira page without a continuation token as partial', async () => {
    const tracker = createJiraWorkTracker({
      config,
      fsPromises: { readFile: async () => 'private-token' },
      fetchImpl: async () => new Response(JSON.stringify({ isLast: false, issues: [] }), { status: 200 }),
    });
    expect(await tracker.loadSnapshot()).toEqual({ state: 'partial', issues: [] });
  });

  test('queries every enabled AIOPS project and treats an empty selection as no work', async () => {
    const requested = [];
    const tracker = createJiraWorkTracker({
      config,
      fsPromises: { readFile: async () => 'private-token' },
      fetchImpl: async (url) => {
        requested.push(new URL(url).searchParams.get('jql'));
        return new Response(JSON.stringify({ issues: [] }), { status: 200 });
      },
    });
    expect(await tracker.loadSnapshot({ projectKeys: [] })).toEqual({ state: 'ready', issues: [] });
    expect(requested).toEqual([]);
    await tracker.loadSnapshot({ projectKeys: ['SC', 'OPS', 'SC'] });
    expect(requested).toEqual(['project in (SC, OPS) ORDER BY key ASC']);
  });

  test('rejects malformed AIOPS project keys before querying Jira', async () => {
    const tracker = createJiraWorkTracker({
      config,
      fsPromises: { readFile: async () => 'private-token' },
      fetchImpl: async () => { throw new Error('must not query'); },
    });
    await expect(tracker.loadSnapshot({ projectKeys: ['SC) OR status != Done'] }))
      .rejects.toThrow(/project selection/);
  });
});

describe('Jira as the bus', () => {
  const fieldConfig = { ...config, sessionField: 'customfield_10042', repoField: 'customfield_10043' };
  const fsPromises = { readFile: async () => 'private-token' };

  test('reads the recorded session pointer and repo, and asks Jira for those fields', async () => {
    let requestedFields = '';
    const tracker = createJiraWorkTracker({
      config: fieldConfig,
      fsPromises,
      fetchImpl: async (url) => {
        requestedFields = new URL(url).searchParams.get('fields');
        return new Response(JSON.stringify({ issues: [{
          key: 'ENG-9',
          fields: {
            summary: 'Wire the bus',
            assignee: { displayName: 'Dev One', accountId: 'acct-1' },
            reporter: { displayName: 'CTO' },
            customfield_10042: 'ses_abc123',
            customfield_10043: '/srv/repo-a',
          },
        }] }), { status: 200 });
      },
    });

    const { issues } = await tracker.loadSnapshot();
    expect(requestedFields).toContain('customfield_10042');
    expect(requestedFields).toContain('customfield_10043');
    expect(requestedFields).toContain('reporter');
    expect(issues[0]).toMatchObject({
      sessionId: 'ses_abc123',
      repo: '/srv/repo-a',
      assigneeAccountId: 'acct-1',
      reporter: 'CTO',
    });
  });

  test('leaves the pointer null when the fields are not configured', async () => {
    const tracker = createJiraWorkTracker({
      config,
      fsPromises,
      fetchImpl: async () => new Response(JSON.stringify({ issues: [{
        key: 'ENG-9',
        fields: { summary: 'x', customfield_10042: 'ses_abc123' },
      }] }), { status: 200 }),
    });
    const { issues } = await tracker.loadSnapshot();
    expect(issues[0].sessionId).toBeNull();
    expect(issues[0].repo).toBeNull();
  });

  test('posts a comment as an ADF document and refuses empty or malformed targets', async () => {
    const posted = [];
    const tracker = createJiraWorkTracker({
      config: fieldConfig,
      fsPromises,
      fetchImpl: async (url, options) => {
        posted.push({ url: String(url), body: JSON.parse(options.body), method: options.method });
        return new Response('{}', { status: 201 });
      },
    });

    await tracker.addComment('ENG-9', 'linea uno\nlinea dos');
    expect(posted[0].method).toBe('POST');
    expect(posted[0].url).toBe('https://jira.example.test/rest/api/3/issue/ENG-9/comment');
    expect(posted[0].body.body.type).toBe('doc');
    expect(JSON.stringify(posted[0].body)).toContain('linea dos');

    await expect(tracker.addComment('ENG-9', '   ')).rejects.toThrow(/empty Jira comment/);
    await expect(tracker.addComment('not a key', 'hola')).rejects.toThrow(/Invalid Jira issue key/);
    await expect(tracker.addComment('ENG-9/../ADMIN-1', 'hola')).rejects.toThrow(/Invalid Jira issue key/);
  });

  test('transitions only with an explicit transition id', async () => {
    const posted = [];
    const tracker = createJiraWorkTracker({
      config: fieldConfig,
      fsPromises,
      fetchImpl: async (url, options) => {
        posted.push({ url: String(url), body: JSON.parse(options.body) });
        return new Response('{}', { status: 204 });
      },
    });
    await tracker.transition('ENG-9', '31');
    expect(posted[0].url).toBe('https://jira.example.test/rest/api/3/issue/ENG-9/transitions');
    expect(posted[0].body).toEqual({ transition: { id: '31' } });
    await expect(tracker.transition('ENG-9', null)).rejects.toThrow(/without a transition id/);
  });

  test('records the session pointer, and refuses when no field is configured', async () => {
    const sent = [];
    const tracker = createJiraWorkTracker({
      config: fieldConfig,
      fsPromises,
      fetchImpl: async (url, options) => {
        sent.push({ url: String(url), method: options.method, body: JSON.parse(options.body) });
        return new Response('{}', { status: 204 });
      },
    });
    const result = await tracker.recordSession('ENG-9', 'ses_abc123');
    expect(result).toEqual({ key: 'ENG-9', sessionId: 'ses_abc123', state: 'ready' });
    expect(sent[0].method).toBe('PUT');
    expect(sent[0].body).toEqual({ fields: { customfield_10042: 'ses_abc123' } });

    const without = createJiraWorkTracker({ config, fsPromises, fetchImpl: async () => new Response('{}', { status: 204 }) });
    await expect(without.recordSession('ENG-9', 'ses_abc123')).rejects.toThrow(/sessionField is not configured/);
    expect(without.supportsSessionField).toBe(false);
  });

  test('surfaces a write rejection instead of reporting success', async () => {
    const tracker = createJiraWorkTracker({
      config: fieldConfig,
      fsPromises,
      fetchImpl: async () => new Response('{}', { status: 403 }),
    });
    await expect(tracker.addComment('ENG-9', 'hola')).rejects.toThrow(/failed \(403\)/);
    await expect(tracker.recordSession('ENG-9', 'ses_x')).rejects.toThrow(/failed \(403\)/);
  });

  test('never puts the token in a thrown write error', async () => {
    const tracker = createJiraWorkTracker({
      config: fieldConfig,
      fsPromises,
      fetchImpl: async () => new Response('{}', { status: 500 }),
    });
    await expect(tracker.addComment('ENG-9', 'hola')).rejects.toThrow(
      expect.not.stringContaining('private-token'),
    );
  });
});

describe('transitions resolve by status name, never by a hand-written id', () => {
  const fsPromises = { readFile: async () => 'private-token' };
  const withTransitions = (transitions, onPost = () => new Response('{}', { status: 204 })) => {
    const posted = [];
    const tracker = createJiraWorkTracker({
      config,
      fsPromises,
      fetchImpl: async (url, options) => {
        if ((options?.method ?? 'GET') === 'GET') {
          return new Response(JSON.stringify({ transitions }), { status: 200 });
        }
        posted.push({ url: String(url), body: JSON.parse(options.body) });
        return onPost();
      },
    });
    return { tracker, posted };
  };

  test('asks Jira which transitions the issue offers and uses that id', async () => {
    const { tracker, posted } = withTransitions([
      { id: '11', to: { name: 'In Progress' } },
      { id: '31', to: { name: 'QA' } },
    ]);
    const result = await tracker.transitionTo('ENG-9', 'QA');
    expect(result).toEqual({ key: 'ENG-9', to: 'QA', transitionId: '31', state: 'ready' });
    expect(posted[0].body).toEqual({ transition: { id: '31' } });
  });

  test('matches the target status case-insensitively', async () => {
    const { tracker } = withTransitions([{ id: '41', to: { name: 'Sign-off' } }]);
    expect((await tracker.transitionTo('ENG-9', 'sign-off')).transitionId).toBe('41');
  });

  test('refuses, listing what Jira does offer, when the move is not allowed', async () => {
    const { tracker, posted } = withTransitions([{ id: '11', to: { name: 'In Progress' } }]);
    await expect(tracker.transitionTo('ENG-9', 'QA'))
      .rejects.toThrow(/no transition from ENG-9 to "QA"/);
    expect(posted).toEqual([]);
  });

  test('refuses an empty target and a malformed issue key', async () => {
    const { tracker } = withTransitions([{ id: '11', to: { name: 'QA' } }]);
    await expect(tracker.transitionTo('ENG-9', '  ')).rejects.toThrow(/without a target status/);
    await expect(tracker.transitionTo('../ADMIN-1', 'QA')).rejects.toThrow(/Invalid Jira issue key/);
  });

  test('surfaces an unusable transitions payload instead of guessing', async () => {
    const tracker = createJiraWorkTracker({
      config, fsPromises,
      fetchImpl: async () => new Response(JSON.stringify({}), { status: 200 }),
    });
    await expect(tracker.transitionTo('ENG-9', 'QA')).rejects.toThrow(/Invalid Jira transitions response/);
  });
});

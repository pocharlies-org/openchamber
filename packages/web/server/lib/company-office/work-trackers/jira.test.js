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
        parentKey: null,
        updatedAt: null,
        url: 'https://jira.example.test/browse/ENG-1',
      }],
    });
    expect(JSON.stringify(snapshot)).not.toContain('private-token');
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
});

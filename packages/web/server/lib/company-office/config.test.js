import { describe, expect, test } from 'vitest';
import { parseCompanyOfficeConfig } from './config.js';

const jira = {
  baseUrl: 'https://jira.example.test/path-is-discarded',
  projectKey: 'TEAM_X',
  email: 'automation@example.test',
  tokenFile: '/secrets/jira-token',
};

describe('Company Office config', () => {
  test('normalizes the installation-neutral schema', () => {
    expect(parseCompanyOfficeConfig({
      schemaVersion: 1,
      company: { id: 'acme', displayName: 'Acme' },
      roster: { manifestPath: '/company/manifest.yaml', registryPath: '/company/registry.json' },
      intake: { employeeId: 'technical-lead', sessionTitle: 'Executive intake' },
      workTracker: { provider: 'jira', jira: { ...jira, initiativeIssueTypes: ['Initiative', 'Story'] } },
    })).toEqual({
      company: { id: 'acme', displayName: 'Acme' },
      roster: { manifestPath: '/company/manifest.yaml', registryPath: '/company/registry.json' },
      intake: { employeeId: 'technical-lead', sessionTitle: 'Executive intake' },
      workTracker: {
        provider: 'jira',
        jira: {
          ...jira,
          baseUrl: 'https://jira.example.test',
          initiativeIssueTypes: ['Initiative', 'Story'],
          acceptanceCriteriaField: null,
          sessionField: null,
          repoField: null,
        },
      },
    });
  });

  test('accepts an instance-specific acceptance criteria field and rejects malformed ids', () => {
    const base = {
      schemaVersion: 1,
      company: { id: 'acme', displayName: 'Acme' },
      roster: { manifestPath: '/company/manifest.yaml', registryPath: '/company/registry.json' },
      intake: { employeeId: 'cto', sessionTitle: 'CTO office' },
    };
    expect(parseCompanyOfficeConfig({
      ...base,
      workTracker: { provider: 'jira', jira: { ...jira, acceptanceCriteriaField: 'customfield_10001' } },
    }).workTracker.jira.acceptanceCriteriaField).toBe('customfield_10001');
    expect(() => parseCompanyOfficeConfig({
      ...base,
      workTracker: { provider: 'jira', jira: { ...jira, acceptanceCriteriaField: 'custom field; drop' } },
    })).toThrow(/acceptanceCriteriaField/);
  });

  test('keeps legacy schema version 1 configurations installable', () => {
    const parsed = parseCompanyOfficeConfig({
      schemaVersion: 1,
      companyId: 'legacy',
      displayName: 'Legacy Company',
      manifestPath: '/legacy/manifest.yaml',
      registryPath: '/legacy/registry.json',
      ctoEmployeeId: 'cto',
      intakeSessionTitle: 'CTO office',
      jira,
    });
    expect(parsed.company).toEqual({ id: 'legacy', displayName: 'Legacy Company' });
    expect(parsed.workTracker.jira.initiativeIssueTypes).toEqual(['Story']);
  });

  test('rejects unsupported providers and insecure Jira origins', () => {
    const base = {
      schemaVersion: 1,
      company: { id: 'acme', displayName: 'Acme' },
      roster: { manifestPath: '/company/manifest.yaml', registryPath: '/company/registry.json' },
      intake: { employeeId: 'cto', sessionTitle: 'CTO office' },
    };
    expect(() => parseCompanyOfficeConfig({ ...base, workTracker: { provider: 'github' } })).toThrow(/Unsupported/);
    expect(() => parseCompanyOfficeConfig({
      ...base,
      workTracker: { provider: 'jira', jira: { ...jira, baseUrl: 'http://jira.example.test' } },
    })).toThrow(/HTTPS/);
  });

  test('accepts instance-specific session and repo field ids, and rejects malformed ones', () => {
    const base = {
      schemaVersion: 1,
      company: { id: 'acme', displayName: 'Acme' },
      roster: { manifestPath: '/company/manifest.yaml', registryPath: '/company/registry.json' },
      intake: { employeeId: 'cto', sessionTitle: 'CTO office' },
    };
    const parsed = parseCompanyOfficeConfig({
      ...base,
      workTracker: {
        provider: 'jira',
        jira: { ...jira, sessionField: 'customfield_10042', repoField: 'customfield_10043' },
      },
    });
    expect(parsed.workTracker.jira.sessionField).toBe('customfield_10042');
    expect(parsed.workTracker.jira.repoField).toBe('customfield_10043');

    for (const bad of ['', '  ', 'Custom Field', 'customfield-10042', '10042']) {
      expect(() => parseCompanyOfficeConfig({
        ...base,
        workTracker: { provider: 'jira', jira: { ...jira, sessionField: bad } },
      })).toThrow(/sessionField/);
    }
  });
});

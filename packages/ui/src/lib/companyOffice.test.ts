import { describe, expect, mock, test } from 'bun:test';

mock.module('@/lib/runtime-fetch', () => ({ runtimeFetch: () => Promise.reject(new Error('not used')) }));

const { parseCompanyOfficeSnapshot } = await import('./companyOffice');

const snapshot = {
  schemaVersion: 1,
  generatedAt: '2026-08-17T12:00:00.000Z',
  company: { id: 'example-company', displayName: 'Example Company', ceo: 'Example Lead', jiraProjectUrl: 'https://jira.example.test/browse/EX' },
  sources: { roster: 'ready', sessions: 'ready', activity: 'partial', jira: 'ready' },
  mappingMode: 'reconstructed',
  intakeSession: { id: 'ses-max', title: 'CEO office', directory: '/company/cto' },
  employees: [{
    id: 'cto', name: 'Technical Lead', role: 'cto', title: 'CTO', specialty: null, model: 'claude/fable', directory: '/company/cto',
    sessionsAvailable: true, activityAvailable: true, activity: 'busy', sessions: [
      { id: 'ses-max', title: 'CEO office', directory: '/company/cto', updatedAt: 1, activity: 'busy', ticketKey: null },
    ],
  }],
  initiatives: [{
    key: 'EX-16', summary: 'Governance', status: 'Backlog', type: 'Story', assignee: null, parentKey: null,
    updatedAt: '2026-08-17', url: 'https://jira.example.test/browse/EX-16', counts: { backlog: 1 }, tickets: [{
      key: 'EX-21', summary: 'Architecture', status: 'Backlog', type: 'Subtask', assignee: 'Technical Lead', parentKey: 'EX-16',
      updatedAt: '2026-08-17', url: 'https://jira.example.test/browse/EX-21', mapping: 'reconstructed',
      session: { id: 'ses-ex21', title: '[EX-21] Architecture', directory: '/company/cto' },
    }],
  }],
};

describe('Company Office snapshot parser', () => {
  test('constructs a trusted snapshot from the server contract', () => {
    expect(parseCompanyOfficeSnapshot(snapshot)).toEqual(snapshot);
  });

  test('rejects malformed activity and arbitrary issue fields', () => {
    const malformed = structuredClone(snapshot);
    malformed.employees[0]!.activity = 'running';
    expect(() => parseCompanyOfficeSnapshot(malformed)).toThrow('Invalid Company Office employee');
  });

  test('rejects Jira links outside the configured Jira origin', () => {
    const malformed = structuredClone(snapshot);
    malformed.initiatives[0]!.tickets[0]!.url = 'https://attacker.example/SC-21';
    expect(() => parseCompanyOfficeSnapshot(malformed)).toThrow('Invalid Company Office issue URL');
  });

  test('rejects an invalid snapshot generation timestamp', () => {
    const malformed = structuredClone(snapshot);
    malformed.generatedAt = 'not-a-date';
    expect(() => parseCompanyOfficeSnapshot(malformed)).toThrow('Invalid Company Office generatedAt');
  });
});

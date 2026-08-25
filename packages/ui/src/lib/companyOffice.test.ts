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
    updatedAt: '2026-08-17', url: 'https://jira.example.test/browse/EX-16',
    acceptanceCriteria: 'Given a snapshot\nJira stays authoritative', mapping: 'reconstructed',
    session: { id: 'ses-ex16', title: '[EX-16] Governance', directory: '/company/cto' },
    counts: { backlog: 1 }, tickets: [{
      key: 'EX-21', summary: 'Architecture', status: 'Backlog', type: 'Subtask', assignee: 'Technical Lead', parentKey: 'EX-16',
      updatedAt: '2026-08-17', url: 'https://jira.example.test/browse/EX-21', acceptanceCriteria: null, mapping: 'reconstructed',
      session: { id: 'ses-ex21', title: '[EX-21] Architecture', directory: '/company/cto' },
      subtasks: [],
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

  test('rejects an epic session reference the server did not qualify', () => {
    const malformed = structuredClone(snapshot);
    malformed.initiatives[0]!.session = { id: 'ses-ex16', title: '[EX-16] Governance' } as never;
    expect(() => parseCompanyOfficeSnapshot(malformed)).toThrow('Invalid Company Office session reference');
  });

  test('rejects an invalid snapshot generation timestamp', () => {
    const malformed = structuredClone(snapshot);
    malformed.generatedAt = 'not-a-date';
    expect(() => parseCompanyOfficeSnapshot(malformed)).toThrow('Invalid Company Office generatedAt');
  });
});

describe('three-level hierarchy', () => {
  type LooseSnapshot = { initiatives: { tickets: Record<string, unknown>[] }[] };
  const looseClone = () => structuredClone(snapshot) as unknown as LooseSnapshot;

  const withSubtasks = (subtasks: unknown) => {
    const clone = looseClone();
    clone.initiatives[0]!.tickets[0]!.subtasks = subtasks;
    return clone;
  };

  test('parses subtasks nested under their ticket', () => {
    const ticket = structuredClone(snapshot).initiatives[0]!.tickets[0]!;
    const parsed = parseCompanyOfficeSnapshot(withSubtasks([
      { ...ticket, key: 'SC-99', url: ticket.url.replace(/[^/]+$/, 'SC-99') },
    ]));
    expect(parsed.initiatives[0]!.tickets[0]!.subtasks.map((s) => s.key)).toEqual(['SC-99']);
  });

  test('tolerates an older server that sends no subtasks at all', () => {
    const clone = looseClone();
    delete clone.initiatives[0]!.tickets[0]!.subtasks;
    expect(parseCompanyOfficeSnapshot(clone).initiatives[0]!.tickets[0]!.subtasks).toEqual([]);
  });

  test('rejects a malformed subtask instead of dropping the work silently', () => {
    expect(() => parseCompanyOfficeSnapshot(withSubtasks('nope'))).toThrow('Invalid Company Office ticket');
    expect(() => parseCompanyOfficeSnapshot(withSubtasks([{ key: 'SC-99' }]))).toThrow('Invalid Company Office issue');
  });
});

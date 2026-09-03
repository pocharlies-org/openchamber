import { describe, expect, test } from 'vitest';
import { parseAiopsRouting } from './aiops-routing.js';

const config = (routes) => ({ schemaVersion: 2, mode: 'custom', routes });
const route = (issueType, status, role, action = 'implement') => ({ issueType, status, role, action });

describe('AIOPS routing', () => {
  test('resolves exact, status and issue-type rules in that order', () => {
    const routing = parseAiopsRouting(config([
      route('*', 'Review', 'qa', 'review'),
      route('Story', '*', 'pm', 'plan'),
      route('Story', 'Review', 'po', 'approve'),
    ]));
    expect(routing.resolve({ type: 'Story', status: 'Review' })).toMatchObject({ role: 'po' });
    expect(routing.resolve({ type: 'Bug', status: 'Review' })).toMatchObject({ role: 'qa' });
    expect(routing.resolve({ type: 'Story', status: 'Backlog' })).toMatchObject({ role: 'pm' });
    expect(routing.resolve({ type: 'Bug', status: 'Backlog' })).toBeNull();
  });

  test('normalizes the legacy issue-type map explicitly', () => {
    const routing = parseAiopsRouting({ issueTypeRoles: [{ type: 'Epic', role: 'cto' }] });
    expect(routing.resolve({ type: 'epic', status: 'In Progress' })).toMatchObject({ role: 'cto', action: 'implement' });
  });

  test('rejects unknown versions, roles, actions and normalized duplicates', () => {
    expect(() => parseAiopsRouting({ schemaVersion: 3, mode: 'custom', routes: [] })).toThrow(/Unsupported/);
    expect(() => parseAiopsRouting(config([route('*', 'QA', 'ghost')]), { roleIds: new Set(['qa']) })).toThrow(/unknown role/);
    expect(() => parseAiopsRouting(config([route('*', 'QA', 'qa', 'hack')]))).toThrow(/unknown action/);
    expect(() => parseAiopsRouting(config([route('*', 'QA', 'qa'), route('*', ' qa ', 'qa')]))).toThrow(/duplicate/);
  });
});

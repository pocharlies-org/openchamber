import { describe, expect, test } from 'bun:test';

import type { Session } from '@/lib/opencode/model';
import { agentStatusOf, formatElapsed, mergeChildren } from './claudeAgentMap';

const child = (id: string, status: string | undefined, created = 1) => ({
  id, parentID: 'p', title: id, time: { created, updated: created }, metadata: status ? { subagent: { agentType: 'Explore', status } } : {},
}) as unknown as Session;

describe('agent map', () => {
  test('a busy child is running whatever it recorded; otherwise its recorded status', () => {
    expect(agentStatusOf(child('a', 'completed'), true)).toBe('running');
    expect(agentStatusOf(child('a', 'running'), false)).toBe('running');
    expect(agentStatusOf(child('a', 'failed'), false)).toBe('failed');
    expect(agentStatusOf(child('a', 'killed'), false)).toBe('stopped');
    expect(agentStatusOf(child('a', undefined), false)).toBe('completed');
  });

  test('elapsed time reads as the map shows it', () => {
    expect(formatElapsed(42_000)).toBe('42s');
    expect(formatElapsed(185_000)).toBe('3m 5s');
    expect(formatElapsed(3_720_000)).toBe('1h 2m');
  });

  test('live children win over the ones read from the server, oldest first', () => {
    const merged = mergeChildren([child('b', 'running', 5)], [child('b', 'completed', 5), child('a', 'completed', 1)]);
    expect(merged.map((session) => [session.id, (session.metadata as { subagent: { status: string } }).subagent.status]))
      .toEqual([['a', 'completed'], ['b', 'running']]);
  });
});

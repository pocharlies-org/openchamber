import { describe, expect, test } from 'bun:test';
import { SESSION_ENGINE_INFO } from '@/lib/sessionEngine';
import { parseEnginesAnswer } from './useEngineStore';

describe('parseEnginesAnswer', () => {
  test('reads every engine the server declares over the fallback', () => {
    const table = parseEnginesAnswer({
      engines: [
        { id: 'opencode', label: 'OpenCode', available: true, capabilities: { shell: true } },
        { id: 'claude', label: 'Claude Code', available: false, capabilities: { fork: false } },
      ],
    });
    expect(table.claude.available).toBe(false);
    expect(table.claude.capabilities.fork).toBe(false);
    expect(table.claude.capabilities.compact).toBe(true);
    expect(table.opencode.capabilities.shell).toBe(true);
  });

  test('an unknown engine is ignored; a missing one keeps its fallback', () => {
    const table = parseEnginesAnswer({ engines: [{ id: 'codex', capabilities: {} }, { id: 'claude', capabilities: { shell: true } }] });
    expect(Object.keys(table).sort()).toEqual(['claude', 'opencode']);
    expect(table.opencode).toBe(SESSION_ENGINE_INFO.opencode);
    expect(table.claude.capabilities.shell).toBe(true);
  });

  test('an answer of the wrong shape is the fallback table', () => {
    expect(parseEnginesAnswer(null)).toEqual(SESSION_ENGINE_INFO);
    expect(parseEnginesAnswer({ engines: 'claude' })).toEqual(SESSION_ENGINE_INFO);
  });
});

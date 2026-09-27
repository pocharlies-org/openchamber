import { describe, expect, test } from 'bun:test';
import { OpencodeApiError } from '@/lib/opencode/client';
import { describeEngineRefusal } from './engineErrors';
import { EngineUnsupportedError, SESSION_ENGINE_INFO } from './sessionEngine';

const t = ((key: string, params?: Record<string, string | number>) => (
  `${key}${params ? ' ' + Object.entries(params).map(([k, v]) => `${k}=${v}`).join(' ') : ''}`
)) as unknown as Parameters<typeof describeEngineRefusal>[1];

describe('describeEngineRefusal', () => {
  test('a client-side refusal names the engine, localized', () => {
    const error = new EngineUnsupportedError(SESSION_ENGINE_INFO.claude, 'shell');
    expect(describeEngineRefusal(error, t)).toBe('sessions.sidebar.session.action.unsupported engine=Claude Code');
  });

  test('a server refusal names the engine that refused', () => {
    const error = new OpencodeApiError('session.revert.stage', 'Claude Code sessions do not support revert', {
      status: 400,
      tag: 'UnsupportedOperationError',
      unsupported: { engine: 'claude', operation: 'revert' },
    });
    expect(describeEngineRefusal(error, t)).toBe('sessions.sidebar.session.action.unsupported engine=Claude Code');
  });

  test('anything else is not a refusal', () => {
    expect(describeEngineRefusal(new Error('offline'), t)).toBeNull();
    expect(describeEngineRefusal(new OpencodeApiError('session.prompt', 'boom', { status: 500 }), t)).toBeNull();
  });
});

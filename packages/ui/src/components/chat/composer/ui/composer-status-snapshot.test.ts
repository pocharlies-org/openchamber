import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, CompactionMessage, Message, Metadata, UserMessage } from '@/lib/opencode/model';
import { buildComposerStatusSnapshot } from './composer-status-snapshot';

const assistantMessage = (options: {
  sessionId: string;
  created: number;
  completed?: number;
  providerID?: string;
  metadata?: Metadata;
}): Message => {
  const base = {
    id: `msg_assistant_${options.created}`,
    sessionID: options.sessionId,
    role: 'assistant' as const,
    modelID: 'model-1',
    providerID: options.providerID ?? 'provider-1',
    agent: 'agent',
    path: { cwd: '/repo', root: '/repo' },
    cost: 0,
    time: { created: options.created },
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    metadata: options.metadata ?? {},
  };
  return (options.completed === undefined
    ? { ...base, finish: 'stop' as const }
    : { ...base, time: { created: options.created, completed: options.completed } }) satisfies AssistantMessage;
};

const compactionMessage = (sessionId: string, created: number, status: 'completed' | 'failed'): Message => ({
  id: `msg_compaction_${created}`,
  sessionID: sessionId,
  role: 'compaction',
  status,
  reason: 'auto',
  summary: '',
  time: { created },
}) satisfies CompactionMessage;

const userMessage = (sessionId: string, created: number): Message => ({
  id: `msg_user_${created}`,
  sessionID: sessionId,
  role: 'user',
  time: { created },
}) satisfies UserMessage;

describe('buildComposerStatusSnapshot', () => {
  test('reports engine, provider and completion instant of the latest completed assistant turn', () => {
    const snapshot = buildComposerStatusSnapshot({
      sessionId: 'ses-1',
      engine: 'claude',
      session: null,
      messages: [
        userMessage('ses-1', 100),
        assistantMessage({ sessionId: 'ses-1', created: 200, completed: 900, providerID: 'anthropic' }),
      ],
    });
    expect(snapshot).toEqual({
      sessionId: 'ses-1',
      engine: 'claude',
      providerId: 'anthropic',
      lastAssistantAt: 900,
      cacheTtlMs: null,
      compacted: false,
    });
  });

  test('falls back to the creation instant when the turn never recorded a completion', () => {
    const snapshot = buildComposerStatusSnapshot({
      sessionId: 'ses-1',
      engine: 'opencode',
      session: null,
      messages: [assistantMessage({ sessionId: 'ses-1', created: 500 })],
    });
    expect(snapshot.providerId).toBe('provider-1');
    expect(snapshot.lastAssistantAt).toBe(500);
  });

  test('keeps a full snapshot with null fields when the session has no completed assistant turn', () => {
    expect(buildComposerStatusSnapshot({
      sessionId: 'ses-1',
      engine: 'claude',
      session: null,
      messages: [userMessage('ses-1', 100)],
    })).toEqual({ sessionId: 'ses-1', engine: 'claude', providerId: null, lastAssistantAt: null, cacheTtlMs: null, compacted: false });
    expect(buildComposerStatusSnapshot({
      sessionId: 'ses-1',
      engine: 'claude',
      session: null,
      messages: [],
    })).toEqual({ sessionId: 'ses-1', engine: 'claude', providerId: null, lastAssistantAt: null, cacheTtlMs: null, compacted: false });
  });

  test('reports the new session when the message bucket changes', () => {
    const first = buildComposerStatusSnapshot({
      sessionId: 'ses-1',
      engine: 'claude',
      session: null,
      messages: [assistantMessage({ sessionId: 'ses-1', created: 200, completed: 900, providerID: 'anthropic' })],
    });
    const second = buildComposerStatusSnapshot({
      sessionId: 'ses-2',
      engine: 'claude',
      session: null,
      messages: [assistantMessage({ sessionId: 'ses-2', created: 1000, completed: 1500, providerID: 'openai' })],
    });
    expect(first.lastAssistantAt).toBe(900);
    expect(second).toEqual({ sessionId: 'ses-2', engine: 'claude', providerId: 'openai', lastAssistantAt: 1500, cacheTtlMs: null, compacted: false });
  });

  test('nulls the per-turn fields without a session', () => {
    expect(buildComposerStatusSnapshot({
      sessionId: null,
      engine: 'claude',
      session: null,
      messages: [assistantMessage({ sessionId: 'ses-1', created: 200, completed: 900 })],
    })).toEqual({ sessionId: '', engine: 'claude', providerId: null, lastAssistantAt: null, cacheTtlMs: null, compacted: false });
  });

  test('carries the cache lifetime the engine read from the answer usage', () => {
    const snapshot = buildComposerStatusSnapshot({
      sessionId: 'ses-1',
      engine: 'claude',
      session: null,
      messages: [assistantMessage({
        sessionId: 'ses-1',
        created: 200,
        completed: 900,
        providerID: 'claude',
        metadata: { claude: { cacheTtlMs: 3600000 } },
      })],
    });
    expect(snapshot.cacheTtlMs).toBe(3600000);
    expect(snapshot.compacted).toBe(false);
  });

  test('marks the snapshot compacted when a compaction follows the last answer', () => {
    const snapshot = buildComposerStatusSnapshot({
      sessionId: 'ses-1',
      engine: 'claude',
      session: null,
      messages: [
        assistantMessage({ sessionId: 'ses-1', created: 200, completed: 900 }),
        compactionMessage('ses-1', 1000, 'completed'),
      ],
    });
    expect(snapshot.compacted).toBe(true);
  });
});

import { describe, expect, test } from 'bun:test';

import type { Session } from '@/lib/opencode/model';
import { getClaudeEngineState, getClaudeSubagentState } from './claudeSessionMetadata';

const session = (metadata: Record<string, unknown>) => ({ id: 's', metadata } as unknown as Session);

describe('claude engine state on a session', () => {
  test('reads the mode, cache lifetime and context window the engine published', () => {
    expect(getClaudeEngineState(session({ claude: { directory: '/r', mode: 'plan', cacheTtlMs: 300000, contextWindow: 200000 } })))
      .toEqual({ mode: 'plan', cacheTtlMs: 300000, contextWindow: 200000 });
  });

  test('drops what is not a usable value', () => {
    expect(getClaudeEngineState(session({ claude: { mode: '', cacheTtlMs: -1, contextWindow: 'big' } })))
      .toEqual({ mode: null, cacheTtlMs: null, contextWindow: null });
    expect(getClaudeEngineState(null)).toEqual({ mode: null, cacheTtlMs: null, contextWindow: null });
  });

  test('reads a subagent child session', () => {
    expect(getClaudeSubagentState(session({ subagent: { agentType: 'Explore', status: 'running', startedAt: 5 } })))
      .toEqual({ agentType: 'Explore', status: 'running', startedAt: 5, endedAt: null });
    expect(getClaudeSubagentState(session({}))).toBeNull();
  });
});

import { describe, expect, test } from 'bun:test';
import type { StreamMetricSnapshot } from '@/sync/stream-metrics';
import { formatComposerMetricIndicator } from './composer-metrics-format';

const snapshot: StreamMetricSnapshot = {
  runtimeKey: 'runtime',
  directory: '/repo',
  sessionId: 'ses_1',
  turnId: 'msg_user_1',
  assistantMessageId: 'msg_assistant_1',
  status: 'completed',
  exact: true,
  ttftMs: 620,
  durationMs: 2_000,
  speedTokensPerSecond: 42,
  tokens: { input: 18_400, output: 736, reasoning: 10, cacheRead: 20, cacheWrite: 0 },
  characters: 2_900,
  bytes: 3_100,
  modelId: 'model',
  providerId: 'provider',
};

describe('ComposerMetricsSurface formatting', () => {
  test('uses the full desktop indicator when space is available', () => {
    expect(formatComposerMetricIndicator(snapshot, false)).toBe('⚡ 42 tok/s · TTFT 620 ms · ↑ 18.4k · ↓ 736');
  });

  test('uses the compact mobile indicator for narrow composer surfaces', () => {
    expect(formatComposerMetricIndicator(snapshot, true)).toBe('⚡ 42 · 620 ms');
  });
});

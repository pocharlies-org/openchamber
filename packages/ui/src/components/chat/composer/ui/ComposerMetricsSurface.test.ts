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

const withoutTiming: Partial<StreamMetricSnapshot> = {
  ttftMs: null,
  durationMs: null,
  speedTokensPerSecond: null,
};

describe('ComposerMetricsSurface formatting', () => {
  test('uses the full desktop indicator when space is available', () => {
    expect(formatComposerMetricIndicator(snapshot, false)).toBe('⚡ 42 tok/s · TTFT 620 ms · ↑ 18.4k · ↓ 736');
  });

  test('uses the compact mobile indicator for narrow composer surfaces', () => {
    expect(formatComposerMetricIndicator(snapshot, true)).toBe('⚡ 42 · 620 ms');
  });

  test('shows only the token counters for an observed turn without timing', () => {
    const observed = { ...snapshot, ...withoutTiming };
    expect(formatComposerMetricIndicator(observed, false)).toBe('↑ 18.4k · ↓ 736');
    expect(formatComposerMetricIndicator(observed, true)).toBe('↑ 18.4k · ↓ 736');
  });

  test('renders nothing for an observed turn without timing or counters', () => {
    const empty = {
      ...snapshot,
      ...withoutTiming,
      exact: false,
      tokens: { input: null, output: 0, reasoning: null, cacheRead: null, cacheWrite: null },
    };
    expect(formatComposerMetricIndicator(empty, false)).toBe('');
    expect(formatComposerMetricIndicator(empty, true)).toBe('');
  });

  test('does not paint unreported usage as a real zero', () => {
    const zeroUsage = {
      ...snapshot,
      ...withoutTiming,
      tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    };
    expect(formatComposerMetricIndicator(zeroUsage, false)).toBe('');
  });

  test('combines measured speed with counters when observation has no accepted-at', () => {
    const streaming = {
      ...snapshot,
      ttftMs: null,
      durationMs: null,
      tokens: { input: null, output: 1_200, reasoning: null, cacheRead: null, cacheWrite: null },
    };
    expect(formatComposerMetricIndicator(streaming, false)).toBe('⚡ 42 tok/s · ↓ 1.2k');
  });
});

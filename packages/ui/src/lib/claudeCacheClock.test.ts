import { describe, expect, test } from 'bun:test';

import type { Message } from '@/lib/opencode/model';
import { claudeCacheTtlMs, compactedSince, providerCacheTtlMs } from './claudeCacheClock';

const assistant = (extra: Record<string, unknown> = {}) => ({
  id: 'a', sessionID: 's', role: 'assistant', providerID: 'claude', modelID: 'opus', time: { created: 1, completed: 2 }, ...extra,
}) as unknown as Message;

describe('Claude cache clock', () => {
  test('uses the lifetime the answer was cached with, then the session\'s', () => {
    expect(claudeCacheTtlMs(assistant({ metadata: { claude: { cacheTtlMs: 300000 } } }), 3600000)).toBe(300000);
    expect(claudeCacheTtlMs(assistant(), 3600000)).toBe(3600000);
    expect(claudeCacheTtlMs(assistant(), null)).toBeNull();
    // Not a Claude Code answer: the provider rule applies instead.
    expect(claudeCacheTtlMs(assistant({ providerID: 'anthropic' }), 3600000)).toBeNull();
  });

  test('a provider rule covers every Claude surface, engine included', () => {
    expect(providerCacheTtlMs('claude')).toBe(60 * 60_000);
    expect(providerCacheTtlMs('claude-code')).toBe(60 * 60_000);
    expect(providerCacheTtlMs('claude-code-2')).toBe(60 * 60_000);
    expect(providerCacheTtlMs('anthropic')).toBe(5 * 60_000);
    expect(providerCacheTtlMs('litellm-local')).toBeNull();
    expect(providerCacheTtlMs(null)).toBeNull();
  });

  test('a compaction after the last answer reads as expired until the next answer', () => {
    const last = assistant();
    const compaction = { id: 'c', role: 'compaction', status: 'completed', time: { created: 3 } } as unknown as Message;
    const failed = { id: 'f', role: 'compaction', status: 'failed', time: { created: 3 } } as unknown as Message;
    expect(compactedSince([last, compaction], last)).toBe(true);
    expect(compactedSince([compaction, last], last)).toBe(false);
    expect(compactedSince([last, failed], last)).toBe(false);
  });
});

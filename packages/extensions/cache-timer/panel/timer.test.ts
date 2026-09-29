import { describe, expect, it } from 'bun:test';

import { computeCacheTimer, formatCacheDuration, promptCacheTtlMs, EXPIRED_LABEL } from './timer.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('promptCacheTtlMs', () => {
  it('provider without a TTL gives null', () => {
    expect(promptCacheTtlMs(null)).toBeNull();
    expect(promptCacheTtlMs('opencode')).toBeNull();
    expect(promptCacheTtlMs('')).toBeNull();
  });

  it('claude-code and its account providers count down an hour, anthropic five minutes', () => {
    expect(promptCacheTtlMs('claude-code')).toBe(HOUR);
    expect(promptCacheTtlMs('claude-code-cuenta')).toBe(HOUR);
    expect(promptCacheTtlMs('anthropic')).toBe(5 * MINUTE);
  });
});

describe('formatCacheDuration', () => {
  it('formats minutes and hours', () => {
    expect(formatCacheDuration(30_000)).toBe('<1m');
    expect(formatCacheDuration(45 * MINUTE)).toBe('45m');
    expect(formatCacheDuration(HOUR + 30 * MINUTE)).toBe('1h 30m');
    expect(formatCacheDuration(2 * HOUR)).toBe('2h');
  });
});

describe('computeCacheTimer', () => {
  it('proveedor sin TTL ⇒ null', () => {
    expect(computeCacheTimer({ providerId: null, lastAssistantAt: 1, now: 2, cacheTtlMs: null, compacted: false })).toBeNull();
    expect(computeCacheTimer({ providerId: 'opencode', lastAssistantAt: 1, now: 2, cacheTtlMs: null, compacted: false })).toBeNull();
    expect(computeCacheTimer({ providerId: 'claude-code', lastAssistantAt: null, now: 2, cacheTtlMs: null, compacted: false })).toBeNull();
  });

  it('claude-code counts down the exact hour left', () => {
    const started = 1_000_000;
    const timer = computeCacheTimer({ providerId: 'claude-code', lastAssistantAt: started, now: started + 10 * MINUTE, cacheTtlMs: null, compacted: false });
    expect(timer).toEqual({
      ttl: HOUR,
      elapsed: 10 * MINUTE,
      left: 50 * MINUTE,
      expired: false,
      label: '50m',
      tone: 'muted',
    });
  });

  it('claude-code-cuenta also counts down an hour', () => {
    const started = 1_000_000;
    const timer = computeCacheTimer({ providerId: 'claude-code-cuenta', lastAssistantAt: started, now: started + HOUR - 45 * MINUTE, cacheTtlMs: null, compacted: false });
    expect(timer?.ttl).toBe(HOUR);
    expect(timer?.left).toBe(45 * MINUTE);
    expect(timer?.label).toBe('45m');
  });

  it('anthropic counts down five minutes', () => {
    const started = 1_000_000;
    const timer = computeCacheTimer({ providerId: 'anthropic', lastAssistantAt: started, now: started + MINUTE, cacheTtlMs: null, compacted: false });
    expect(timer?.ttl).toBe(5 * MINUTE);
    expect(timer?.left).toBe(4 * MINUTE);
    expect(timer?.label).toBe('4m');
    expect(timer?.tone).toBe('warning');
  });

  it('expired once the ttl is past', () => {
    const started = 1_000_000;
    const timer = computeCacheTimer({ providerId: 'claude-code', lastAssistantAt: started, now: started + HOUR + 10 * MINUTE, cacheTtlMs: null, compacted: false });
    expect(timer?.expired).toBe(true);
    expect(timer?.label).toBe(EXPIRED_LABEL);
    expect(timer?.tone).toBe('error');
  });

  it('warning tone when five minutes or less are left', () => {
    const started = 1_000_000;
    const timer = computeCacheTimer({ providerId: 'claude-code', lastAssistantAt: started, now: started + HOUR - 5 * MINUTE, cacheTtlMs: null, compacted: false });
    expect(timer?.expired).toBe(false);
    expect(timer?.tone).toBe('warning');
  });

  it('el TTL del motor tiene preferencia sobre el mapa del proveedor', () => {
    const started = 1_000_000;
    const timer = computeCacheTimer({ providerId: 'anthropic', lastAssistantAt: started, now: started + MINUTE, cacheTtlMs: HOUR, compacted: false });
    expect(timer?.ttl).toBe(HOUR);
    expect(timer?.left).toBe(59 * MINUTE);
  });

  it('compactada reciente muestra caducada aunque quede tiempo', () => {
    const started = 1_000_000;
    const timer = computeCacheTimer({ providerId: 'claude-code', lastAssistantAt: started, now: started + 10 * MINUTE, cacheTtlMs: null, compacted: true });
    expect(timer?.expired).toBe(true);
    expect(timer?.tone).toBe('error');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../opencode/auth.js', () => ({
  readAuthFile: () => ({ anthropic: { access: 'test-token' } }),
}));

import { fetchQuota } from './claude.js';

/**
 * The four Anthropic windows, as the auth.json path reports them.
 *
 * This is the path that had no test at all: `claude-account-selection.test.js`
 * and `claude-accounts.test.js` cover the plugin roster, and every one of them
 * asserted percentages only — so the provider could, and did, emit
 * `windowSeconds: null` for all four windows without a single failing test.
 * Null was not an absent value here, it was a wrong one: the payload names each
 * duration, and the headline ranker sorts on it.
 */
afterEach(() => {
  vi.unstubAllGlobals();
});

const mockUsage = (payload) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => payload,
  }));
};

const FIVE_HOURS = 5 * 3600;
const SEVEN_DAYS = 7 * 86400;

describe('Claude auth.json quota windows', () => {
  it('reports the real duration of every window the payload returns', async () => {
    mockUsage({
      five_hour: { utilization: 0.44, resets_at: 1788303600 },
      seven_day: { utilization: 0.7, resets_at: 1788228000 },
      seven_day_sonnet: { utilization: 0.25, resets_at: 1788228000 },
      seven_day_opus: { utilization: 0.61, resets_at: 1788228000 },
    });

    const result = await fetchQuota();

    expect(result.usage.windows['5h'].windowSeconds).toBe(FIVE_HOURS);
    expect(result.usage.windows['7d'].windowSeconds).toBe(SEVEN_DAYS);
    expect(result.usage.windows['7d-sonnet'].windowSeconds).toBe(SEVEN_DAYS);
    expect(result.usage.windows['7d-opus'].windowSeconds).toBe(SEVEN_DAYS);
  });

  it('keeps the 5-hour window the shortest of them', async () => {
    // The whole point of the duration: the headline ranks the shortest window
    // first, so a 5-hour at 44% beats a 7-day at 70%. Equal durations, or nulls,
    // and that ordering is gone.
    mockUsage({
      five_hour: { utilization: 0.44, resets_at: 1788303600 },
      seven_day: { utilization: 0.7, resets_at: 1788228000 },
    });

    const { windows } = (await fetchQuota()).usage;

    expect(windows['5h'].windowSeconds).toBeLessThan(windows['7d'].windowSeconds);
  });

  it('reports only the windows the payload carries', async () => {
    // A plan without the model-specific buckets must not grow them: the mapping
    // is keyed on the label, and an absent bucket stays absent.
    mockUsage({ five_hour: { utilization: 0.1, resets_at: 1788303600 } });

    const { windows } = (await fetchQuota()).usage;

    expect(Object.keys(windows)).toEqual(['5h']);
    expect(windows['5h'].windowSeconds).toBe(FIVE_HOURS);
  });
});

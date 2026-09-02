import { describe, expect, test } from 'bun:test';

import {
  buildUsageProviderGroups,
  resolveActiveUsageQuotaProviderId,
  type UsageGroupsInput,
} from './usageGroups';
import type { ProviderResult, QuotaProviderId } from '@/types';

/**
 * Which provider the Usage readouts speak for, and what it renders.
 *
 * The hook is not testable: `renderToStaticMarkup` reads `useSyncExternalStore`'s
 * server snapshot — the store as it was at creation — so a `setState` from a test
 * is invisible to it, and this repo's store tests already work through
 * `getState()` for the same reason. `buildUsageProviderGroups` is the same code
 * with the subscription taken out; the grouping and the selection are what is
 * being pinned down here.
 */

const WINDOW = {
  usedPercent: 40,
  remainingPercent: 60,
  windowSeconds: 18000,
  resetAfterSeconds: null,
  resetAt: null,
  resetAtFormatted: null,
  resetAfterFormatted: null,
};

const result = (providerId: string, over: Partial<ProviderResult> = {}): ProviderResult => ({
  providerId: providerId as QuotaProviderId,
  providerName: providerId,
  ok: true,
  configured: true,
  usage: { windows: { '5h': WINDOW } },
  fetchedAt: Date.now(),
  ...over,
});

const ALL: QuotaProviderId[] = ['claude', 'codex', 'openrouter'];

const input = (over: Partial<UsageGroupsInput>): UsageGroupsInput => ({
  results: [result('claude'), result('codex'), result('openrouter')],
  dropdownProviderIds: ALL,
  selectedModels: {},
  activeQuotaProviderId: null,
  noRateLimitsLabel: 'No rate limits reported.',
  ...over,
});

const ids = (over: Partial<UsageGroupsInput>) =>
  buildUsageProviderGroups(input(over)).map((group) => group.providerId);

describe('resolveActiveUsageQuotaProviderId', () => {
  test('yields the provider of the model that is running', () => {
    expect(resolveActiveUsageQuotaProviderId({ providerID: 'claude-code-tercera', modelID: 'opus' }))
      .toBe('claude');
    expect(resolveActiveUsageQuotaProviderId({ providerID: 'codex', modelID: 'gpt-5.3' }))
      .toBe('codex');
  });

  test('yields nothing for a model no quota provider answers for', () => {
    // The section must disappear, not fall back to whatever Claude is configured.
    expect(resolveActiveUsageQuotaProviderId({ providerID: 'litellm-auto', modelID: 'deepseek-v4-flash' }))
      .toBeNull();
  });

  test('yields nothing when no model is picked at all', () => {
    expect(resolveActiveUsageQuotaProviderId(null)).toBeNull();
    expect(resolveActiveUsageQuotaProviderId(undefined)).toBeNull();
    expect(resolveActiveUsageQuotaProviderId({})).toBeNull();
    expect(resolveActiveUsageQuotaProviderId({ providerID: '', modelID: 'opus' })).toBeNull();
  });
});

describe('buildUsageProviderGroups', () => {
  test('lists only the provider the session spends', () => {
    // Three subscriptions configured, one session. The other two are noise.
    expect(ids({ activeQuotaProviderId: 'claude' })).toEqual(['claude']);
    expect(ids({ activeQuotaProviderId: 'codex' })).toEqual(['codex']);
  });

  test('lists nothing when the model has no quota provider', () => {
    expect(ids({ activeQuotaProviderId: null })).toEqual([]);
  });

  test('keeps the dropdown and configured gates', () => {
    // The filter narrows which provider; it does not override the user's
    // dropdown or invent a provider whose credentials are absent.
    expect(ids({
      activeQuotaProviderId: 'claude',
      dropdownProviderIds: ['codex'],
    })).toEqual([]);
    expect(ids({
      activeQuotaProviderId: 'claude',
      results: [result('claude', { configured: false })],
    })).toEqual([]);
  });

  test('reports a configured provider that returned no windows', () => {
    const groups = buildUsageProviderGroups(input({
      activeQuotaProviderId: 'claude',
      results: [result('claude', { usage: { windows: {} } })],
    }));
    expect(groups).toHaveLength(1);
    expect(groups[0].rows).toEqual([]);
    expect(groups[0].status).toBe('No rate limits reported.');
  });

  test('carries the windows through as rows', () => {
    const groups = buildUsageProviderGroups(input({ activeQuotaProviderId: 'claude' }));
    expect(groups[0].rows.map((row) => row.key)).toEqual(['window-5h']);
  });

  test('names the account, and the other names on its budget, on a model row', () => {
    // Claude reports its accounts through `models`. A row that shows only the
    // percentage is the bug: two accounts on one pool read as two pools.
    const groups = buildUsageProviderGroups(input({
      activeQuotaProviderId: 'claude',
      results: [result('claude', {
        usage: {
          windows: {},
          models: {
            'Work personal · d@cloudblue.com': {
              windows: { '5h': WINDOW },
              sharedWith: ['Works Shared'],
            },
          },
        },
      })],
    }));
    expect(groups[0].rows).toHaveLength(1);
    const [row] = groups[0].rows;
    expect(row.subtitle).toContain('Work personal');
    expect(row.subtitle).toContain('Works Shared');
    // The bare name, for the surfaces that have a few characters for it and
    // cannot carry the note.
    expect(row.account).toBe('Work personal');
  });

  test('leaves an unshared account named alone', () => {
    const groups = buildUsageProviderGroups(input({
      activeQuotaProviderId: 'claude',
      results: [result('claude', {
        usage: { windows: {}, models: { Personal: { windows: { '5h': WINDOW } } } },
      })],
    }));
    expect(groups[0].rows[0].subtitle).toBe('Personal');
  });
});

import { describe, expect, test } from 'bun:test';

import { resolveActiveUsageQuotaProviderId } from './usageGroups';

/**
 * The filter that decides which provider the Usage readouts speak for.
 *
 * The narrowing itself is one `.filter()` on the provider list, so these test
 * the decision it is built on rather than React's memoisation of it: which
 * provider id a model yields, and that "no provider" is a real answer and not an
 * empty-list accident. Rendering the hook needs the quota store, the i18n store
 * and a directory store, none of which is what is being decided here.
 */
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

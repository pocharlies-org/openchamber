import { describe, expect, test } from 'bun:test';

import {
  resolveMobileUsageLimitsPresentation,
  type MobileUsageLimitsInput,
} from './mobileUsageLimits';

/**
 * What the mobile metadata popover does when there is nothing to show.
 *
 * The decision is extracted from MobileUsageLimits because that component sits
 * behind a module that cannot load outside a Vite build (`import.meta.glob` for
 * the provider logos), so the branch is otherwise untestable — and it is exactly
 * the branch that decides whether a filtered-out Usage section reads as
 * "nothing to report" or as "still loading", forever.
 */
const input = (over: Partial<MobileUsageLimitsInput>): MobileUsageLimitsInput => ({
  groupCount: 0,
  isLoading: false,
  activeQuotaProviderId: 'claude',
  hasRequestedProvider: false,
  requestedProviderSettled: false,
  ...over,
});

describe('resolveMobileUsageLimitsPresentation', () => {
  test('renders the cards when a provider reported', () => {
    expect(resolveMobileUsageLimitsPresentation(input({ groupCount: 1 }))).toBe('cards');
  });

  test('shows loading while the quota fetch is in flight', () => {
    expect(resolveMobileUsageLimitsPresentation(input({ isLoading: true }))).toBe('loading');
    // In flight for some other provider still counts as an answer pending: the
    // popover cannot tell which provider a global fetch is working on.
    expect(resolveMobileUsageLimitsPresentation(input({
      isLoading: true,
      hasRequestedProvider: true,
      requestedProviderSettled: true,
    }))).toBe('loading');
  });

  test('shows loading on an empty result the first fetch has not reached', () => {
    // The pre-existing race: the popover opens before the ~2s quota fetch lands.
    expect(resolveMobileUsageLimitsPresentation(input({ hasRequestedProvider: true }))).toBe('loading');
  });

  test('renders nothing once the provider has answered with nothing', () => {
    // The fetch has been issued and has come back: the spinner's condition is
    // over, and an empty list is now an answer rather than a gap.
    expect(resolveMobileUsageLimitsPresentation(input({
      hasRequestedProvider: true,
      requestedProviderSettled: true,
    }))).toBe('cards');
    // Nothing was ever requested and nothing is in flight: not a spinner either.
    expect(resolveMobileUsageLimitsPresentation(input({}))).toBe('cards');
  });

  test('renders nothing when the active model has no quota provider at all', () => {
    // The filter's answer for a local model: no provider is ever requested, so
    // waiting for one would spin forever.
    expect(resolveMobileUsageLimitsPresentation(input({ activeQuotaProviderId: null }))).toBe('none');
    expect(resolveMobileUsageLimitsPresentation(input({
      activeQuotaProviderId: null,
      isLoading: true,
      hasRequestedProvider: true,
    }))).toBe('none');
  });
});

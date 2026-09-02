/**
 * Whether the mobile metadata popover has anything to say about quota.
 *
 * Extracted from `MobileUsageLimits`, which cannot be mounted in a test: its
 * module pulls in the provider-logo map through `import.meta.glob`, so it only
 * resolves inside a Vite build. The logos are decoration; this is the branch
 * that decides what the user sees when the list is empty, and it is worth being
 * able to say so without a browser.
 */
export type MobileUsageLimitsInput = {
  /** Providers the filter left standing, each with its windows. */
  groupCount: number;
  /** A quota fetch is in flight (the store's global flag). */
  isLoading: boolean;
  /** The provider this session spends, or null when its model has no quota. */
  activeQuotaProviderId: string | null;
  /** That provider has been fetched at least once, so its absence is an answer. */
  hasRequestedProvider: boolean;
  /** That fetch has come back, so the answer — empty or not — is final. */
  requestedProviderSettled: boolean;
};

export type MobileUsageLimitsPresentation = 'cards' | 'loading' | 'none';

/**
 * An empty list means three different things, and the popover used to see only
 * two of them.
 *
 * It is still fetching, or it has not been fetched yet — in both cases the
 * answer is not in, so the loading row is right, and that is the race the row
 * was written for: the popover often opens before the ~2s quota fetch lands.
 *
 * The third case arrived with the active-provider filter: a session running on
 * a model that has no quota provider (a local gateway) yields no provider to
 * wait for, ever. Treating that as "not fetched yet" leaves the popover showing
 * a spinner that nothing will ever stop — the fetch for that provider is never
 * issued, so `isLoading` never turns true and the "has it been requested" test
 * stays false for the life of the session. A readout that cannot answer says
 * nothing; it does not hold the door open.
 */
export const resolveMobileUsageLimitsPresentation = (
  input: MobileUsageLimitsInput,
): MobileUsageLimitsPresentation => {
  if (input.groupCount > 0) return 'cards';
  if (input.activeQuotaProviderId === null) return 'none';
  if (input.isLoading) return 'loading';
  if (input.hasRequestedProvider && !input.requestedProviderSettled) return 'loading';
  return 'cards';
};

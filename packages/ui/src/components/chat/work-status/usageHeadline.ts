import { resolveQuotaProviderId as resolveQuotaProviderIdFromModel } from '@/lib/quota';
import type { UsageProviderGroup, UsageLimitRow } from '@/components/usage/usageGroups';

/**
 * Picking the one quota worth showing while the Usage section is collapsed.
 *
 * The interesting limit is the one that runs out first, which is the shortest
 * window a provider reports — a 5-hour bucket says more about whether the next
 * turn will land than a monthly one. Rows without a window duration (credit
 * balances, tool counters) are kept only as a last resort, since they never
 * answer "can I keep working right now".
 */

const normalize = (value: string | null | undefined): string => (value ?? '').trim().toLowerCase();

/**
 * Which quota provider a model bills against. Lives in `@/lib/quota` beside the
 * provider list it validates against; re-exported because the Usage section's
 * collapsed headline and the expanded list must resolve the same way — a
 * headline for one provider above a list of another is the bug this whole file
 * exists to avoid, so the two are not allowed two resolvers.
 */
export const resolveQuotaProviderId = resolveQuotaProviderIdFromModel;

/**
 * Shortest reported window for the provider the composer is pointed at.
 *
 * Returns null when nothing matches — the section then falls back to its
 * display-mode label rather than showing a quota belonging to some other
 * provider, which would read as the active one.
 */
export const pickUsageHeadline = (
  groups: readonly UsageProviderGroup[],
  modelProviderId: string | null | undefined,
): { group: UsageProviderGroup; row: UsageLimitRow } | null => {
  const quotaProviderId = resolveQuotaProviderId(modelProviderId);
  if (!quotaProviderId) return null;

  const group = groups.find((candidate) => normalize(candidate.providerId) === quotaProviderId);
  if (!group || group.rows.length === 0) return null;

  // Provider-level rows only: a model-scoped row describes one model, not the
  // provider the composer is pointed at.
  const providerRows = group.rows.filter((row) => !row.subtitle);
  const rows = providerRows.length > 0 ? providerRows : group.rows;

  let best: UsageLimitRow | null = null;
  let bestSeconds = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const seconds = row.window.windowSeconds;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) continue;
    if (seconds < bestSeconds) {
      best = row;
      bestSeconds = seconds;
    }
  }

  return { group, row: best ?? rows[0] };
};

/** What the collapsed Usage header can show, and what it has to say it with. */
export type UsageHeadlineSummary =
  /** A provider-level row: the number belongs to the provider the header names. */
  | { kind: 'provider'; label: string; metric: string }
  /** One account's row, named. Claude bills per login, so this is the only
   *  honest way a number from it can sit under the provider's heading. */
  | { kind: 'account'; label: string; metric: string; account: string }
  /** Nothing attributable: the display-mode word, which claims no number. */
  | { kind: 'mode'; label: string };

/**
 * The collapsed Usage header, as text — no React, so the decision is testable.
 *
 * The row `pickUsageHeadline` returns is the right row to summarise, but the
 * summary is the most-visible line in the panel and it renders `label` plus the
 * metric under the provider's own heading. Claude's provider-level windows are
 * the tightest reading *across every connected account* (see
 * `buildMultiAccountResult` in the web quota provider): a maximum, and only ever
 * a maximum, belonging to whichever account happens to be tightest in that
 * window. So with two subscriptions the header used to print "5h 44%" under
 * "Claude" while 44% was one account's 5-hour and 70% another's 7-day — one
 * anonymous provider whose numbers belong to nobody in particular.
 *
 * So an account row is only ever shown with its account name beside it, and a
 * provider-level row stays as it was. When the chosen row is an account row but
 * the caller has no room for the name, `hasRoomForAccountLabel: false` yields
 * the mode word instead: an absent number beats a misattributed one.
 *
 * A row that carries a `subtitle` but no `account` is a per-model row of a
 * provider that bills per model (Google). Its number is the provider's, so it
 * reads as it always did.
 */
export const resolveUsageHeadlineSummary = (
  headline: { group: UsageProviderGroup; row: UsageLimitRow } | null,
  options: {
    /** Metric already run through `formatQuotaValueLabel`. */
    metric: string | null;
    /** Word for "used"/"remaining", used when nothing can be shown. */
    modeLabel: string;
    /** Whether the surface can render the account name. Defaults to true. */
    hasRoomForAccountLabel?: boolean;
  },
): UsageHeadlineSummary => {
  const metric = options.metric;
  if (!headline || !metric || metric === '-') return { kind: 'mode', label: options.modeLabel };

  const { row } = headline;
  if (!row.account) return { kind: 'provider', label: row.label, metric };
  if (options.hasRoomForAccountLabel === false) return { kind: 'mode', label: options.modeLabel };

  return { kind: 'account', label: row.label, metric, account: row.account };
};

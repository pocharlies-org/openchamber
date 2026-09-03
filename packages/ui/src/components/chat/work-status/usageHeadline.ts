import { resolveQuotaProviderId as resolveQuotaProviderIdFromModel } from '@/lib/quota';
import type { UsageProviderGroup, UsageLimitRow } from '@/components/usage/usageGroups';

/**
 * Picking the one quota worth showing while the Usage section is collapsed.
 *
 * Every row is ranked by the same two keys, so the choice never depends on the
 * order the rows happen to arrive in:
 *
 * 1. Window length. The limit that runs out first is the shortest window a
 *    provider reports — a 5-hour bucket says more about whether the next turn
 *    will land than a monthly one. A row with no window duration (credit
 *    balances, tool counters) ranks in a bucket after every real window, which
 *    is what "kept only as a last resort" means as a comparison rather than as
 *    a comment.
 * 2. Within one bucket, the highest `usedPercent` — the tightest reading.
 *
 * Key 2 is the one that had to be written down. Claude reports no window
 * durations at all (`claude-accounts.js:51`, `claude.js:121,128,135,142`), so
 * all of Claude lives in the no-duration bucket and, with only key 1, array
 * order decided which subscription headed the panel — a coin flip between an
 * account at 5% and one at 86%. The tightest is the one that answers "can I
 * keep working right now", and a high number cannot read as the whole
 * provider's: `resolveUsageHeadlineSummary` names the account it belongs to.
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
 * The row to head the panel with: shortest window, then tightest reading.
 *
 * Two keys, applied to every row alike (see the file header for why the second
 * one exists). A row with no window duration is ranked in an infinite bucket
 * rather than skipped, so it still loses to any real window but is never
 * chosen by array order — with Claude, where no row has a duration, that
 * bucket is the only one there is.
 *
 * Returns null when nothing matches — the section then falls back to its
 * display-mode label rather than showing a quota belonging to some other
 * provider, which would read as the active one. When `rows` is non-empty a row
 * is always returned: `rows[0]` is the last resort for a provider whose rows
 * all scored nothing, not the normal decider.
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

  // Key 1: window length, with no duration ranked last rather than skipped.
  // It cannot be a `continue`: Claude emits `windowSeconds: null` on every row
  // (`claude-accounts.js:51`, `claude.js:121,128,135,142`), so skipping them
  // left the loop with nothing and handed the decision to roster order.
  const bucketOf = (row: UsageLimitRow): number => {
    const seconds = row.window.windowSeconds;
    return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
      ? seconds
      : Number.POSITIVE_INFINITY;
  };

  // Key 2: within one bucket, the tightest reading wins. It has to be said in
  // code because since `6ff6ff28b` the server leaves `usage.windows` empty
  // whenever more than one Claude subscription reports — so `providerRows` is
  // empty, `rows` falls back to `group.rows`, and every row is an account row
  // in the same bucket. A strict bucket comparison there leaves the choice to
  // roster order, which is a coin flip between an account at 5% and one at 86%.
  //
  // A high number cannot be misread as the whole provider's: the row it comes
  // from carries an `account`, and `resolveUsageHeadlineSummary` prints that
  // name with it — an unattributed account figure is the bug the server change
  // removed the source of, not something this tie-break reintroduces.
  //
  // A window with no reading loses every tie: `usedPercent` is `number | null`,
  // and an unsampled window is not a free one.
  const usedPercentOf = (row: UsageLimitRow): number => {
    const used = row.window.usedPercent;
    return typeof used === 'number' && Number.isFinite(used) ? used : Number.NEGATIVE_INFINITY;
  };

  let best: UsageLimitRow | null = null;
  let bestBucket = Number.POSITIVE_INFINITY;
  let bestUsed = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const bucket = bucketOf(row);
    const used = usedPercentOf(row);
    if (bucket < bestBucket || (bucket === bestBucket && used > bestUsed)) {
      best = row;
      bestBucket = bucket;
      bestUsed = used;
    }
  }

  // `rows.length > 0` above, and the loop scores its first row every time, so
  // `best` is set whenever there is anything to choose from; `rows[0]` stays
  // only as the guarantee that a non-empty group never headlines nothing.
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
 * metric under the provider's own heading — so whatever lands here is read as a
 * statement about the provider.
 *
 * The server keeps that true for Claude: `buildMultiAccountResult` leaves
 * `usage.windows` empty when more than one subscription reports, because Claude
 * bills per login and there is no provider-level budget for that field to
 * describe. It used to hold the maximum across the accounts, and the header
 * printed "5h 44%" under "Claude" when 44% was one account's 5-hour and the 7d
 * beside it another's 7-day. So on a multi-account machine the headline normally
 * resolves to an `account` row, and this function's job is the other half of the
 * rule: an account row is never shown without its name.
 *
 * When the chosen row is an account row but the caller has no room for the name,
 * `hasRoomForAccountLabel: false` yields the mode word instead — an absent number
 * beats a misattributed one.
 *
 * A row that carries a `subtitle` but no `account` is a per-model row of a
 * provider that bills per model (Google). Its number is the provider's, so it
 * reads as it always did, and so does a single-account Claude, whose numbers
 * really are the provider's.
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

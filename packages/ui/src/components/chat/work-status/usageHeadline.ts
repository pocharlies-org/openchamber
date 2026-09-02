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

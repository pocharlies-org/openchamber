import React from 'react';
import { useI18n } from '@/lib/i18n';
import { formatWindowLabel, QUOTA_PROVIDERS, resolveQuotaProviderId } from '@/lib/quota';
import { getDisplayModelName } from '@/lib/quota/model-families';
import { getQuotaAccountEntries, formatQuotaSharedWith } from '@/lib/quota/accounts';
import { useQuotaStore } from '@/stores/useQuotaStore';
import type { ProviderResult, QuotaProviderId, UsageWindow } from '@/types';

export type UsageLimitRow = {
  key: string;
  label: string;
  /**
   * What this row is really about, for the renderer to put before `label`.
   *
   * For Claude that is one subscription — `accounts.ts` is the owner of that
   * name and of the "one budget shared by X" note, so this is composed from
   * `getQuotaAccountEntries`, the same source the header dropdown and the tray
   * read. Composing it here instead of from the model key would split the rule
   * across two files, and Google rows are model names, not accounts.
   */
  subtitle?: string;
  /** The account this row belongs to, when it belongs to one. */
  account?: string;
  window: UsageWindow;
};

export type UsageProviderGroup = {
  providerId: QuotaProviderId;
  providerName: string;
  rows: UsageLimitRow[];
  /** Provider-level message: a fetch error, or "nothing reported". */
  status: string | null;
};

/**
 * The model this readout should speak for, in the shape its callers already hold
 * (`{ providerID, modelID }` from a message, a saved selection or the composer).
 *
 * Anything that is not a quota provider — a local gateway, an unknown custom
 * provider, no model picked yet — resolves to null and therefore to no groups.
 * Collapsing those together is deliberate: a caller must not be able to tell
 * "unknown" from "no model" and start guessing a provider from it.
 */
export type ActiveUsageModel = { providerID?: string | null; modelID?: string | null } | null | undefined;

export const resolveActiveUsageQuotaProviderId = (
  model: ActiveUsageModel,
): QuotaProviderId | null => resolveQuotaProviderId(model?.providerID);

/** Everything the grouping needs, as plain data. */
export type UsageGroupsInput = {
  results: ProviderResult[];
  dropdownProviderIds: readonly QuotaProviderId[];
  selectedModels: Record<string, string[]>;
  /** The provider the session spends; null yields no groups. */
  activeQuotaProviderId: QuotaProviderId | null;
  /** Label for "configured, but reported no windows". */
  noRateLimitsLabel: string;
};

/**
 * The grouping itself, with no store and no React.
 *
 * Split out because the hook cannot be exercised in a test: `renderToStaticMarkup`
 * reads `useSyncExternalStore`'s server snapshot, which is the store as it was at
 * creation, so a `setState` made by a test is invisible to it — and this repo's
 * store tests already work through `getState()` for the same reason. The
 * selection is the part worth pinning down; the subscription around it is zustand's.
 */
export const buildUsageProviderGroups = (
  input: UsageGroupsInput,
): UsageProviderGroup[] => {
  const {
    results,
    dropdownProviderIds,
    selectedModels,
    activeQuotaProviderId,
    noRateLimitsLabel,
  } = input;

  if (activeQuotaProviderId === null) return [];

  const resultsByProvider = new Map(results.map((result) => [result.providerId, result]));
  return QUOTA_PROVIDERS
    .filter((providerMeta) => providerMeta.id === activeQuotaProviderId)
    .filter((providerMeta) => dropdownProviderIds.includes(providerMeta.id))
    .filter((providerMeta) => resultsByProvider.get(providerMeta.id)?.configured === true)
    .map((providerMeta) => {
      const result = resultsByProvider.get(providerMeta.id)!;
      const rows: UsageLimitRow[] = [];

      for (const [label, window] of Object.entries(result?.usage?.windows ?? {})) {
        rows.push({ key: `window-${label}`, label: formatWindowLabel(label), window });
      }

      const modelEntries = Object.entries(result?.usage?.models ?? {});
      const providerSelectedModels = selectedModels[providerMeta.id] ?? [];
      const visibleModelEntries = providerSelectedModels.length > 0
        ? modelEntries.filter(([modelName]) => providerSelectedModels.includes(modelName))
        : modelEntries;
      // Claude's `models` are accounts, and `accounts.ts` is what knows that —
      // which of the three windows answers "can I keep working right now", and
      // the operator's label rather than the identity line. Reading the map
      // directly here would give this surface a different account name, and a
      // different window, than the dropdown and the tray print for the same
      // subscription.
      const accountEntries = new Map(
        getQuotaAccountEntries(result, formatWindowLabel).map((entry) => [entry.id, entry]),
      );
      for (const [modelName, modelUsage] of visibleModelEntries) {
        const entries = Object.entries(modelUsage.windows ?? {});
        if (entries.length === 0) continue;
        const account = accountEntries.get(modelName);
        // A model row keeps the first window it reported, as it always did; an
        // account row takes the shortest, which is the one that answers the
        // question the row is there for.
        const [label, window] = account
          ? [account.label, account.window]
          : entries[0];
        // The account, and the other names on its budget, go in the one field
        // this row type already has for "what this row is really about".
        // A separate field would have to be taught to every renderer of these
        // rows — the work-status panel, the mobile popover, the tray — and the
        // failure mode of forgetting one is exactly the failure this whole
        // change exists to remove: two accounts on one pool read as two pools.
        // The compact surfaces have no room for a second line, but they do have
        // this one, and a truncated suffix loses nothing that matters.
        //
        // `account` is the same name without the shared-budget note: a surface
        // with a few characters for it (the collapsed Usage header) cannot fit
        // the note, and the note is what makes the name unreadable there.
        const sharedWith = modelUsage.sharedWith;
        const subtitle = account
          ? (sharedWith && sharedWith.length > 0
            ? `${account.name} · ${formatQuotaSharedWith(sharedWith)}`
            : account.name)
          : getDisplayModelName(modelName);
        rows.push({
          key: `model-${modelName}-${label}`,
          label,
          subtitle,
          ...(account ? { account: account.name } : {}),
          window,
        });
      }

      const status = !result.ok && result.error
        ? result.error
        : rows.length === 0
          ? noRateLimitsLabel
          : null;

      return {
        providerId: providerMeta.id,
        providerName: providerMeta.name,
        rows,
        status,
      };
    });
};

/**
 * Quota windows grouped by provider, shaped for the compact usage list.
 *
 * Shared by the mobile session-metadata popover and the work-status panel so
 * the two cannot drift on which providers appear, how model rows are filtered,
 * or what counts as a provider-level status.
 *
 * Only providers the user put in the dropdown *and* that reported themselves as
 * configured are included — an unconfigured provider has nothing to say, and
 * listing it reads as a fault.
 *
 * `activeModel` narrows that to the provider the session actually spends, and
 * the condition lives here rather than in either caller's JSX precisely because
 * this hook is shared: filtered in one panel's markup, the other surface keeps
 * listing every provider the machine holds credentials for. These readouts are
 * per provider, so a Claude quota shown while a local model runs is not extra
 * information — it is the remaining balance of a subscription this session is
 * not spending, which is how an operator ends up rationing the wrong account.
 * No model, or a model no quota provider answers for, yields no groups at all:
 * both callers already render nothing on an empty list, and an empty Usage
 * section would be a heading with no claim behind it.
 */
export const useUsageProviderGroups = (
  activeModel?: ActiveUsageModel,
): UsageProviderGroup[] => {
  const { t } = useI18n();
  const quotaResults = useQuotaStore((state) => state.results);
  const dropdownProviderIds = useQuotaStore((state) => state.dropdownProviderIds);
  const selectedQuotaModels = useQuotaStore((state) => state.selectedModels);
  const activeQuotaProviderId = resolveActiveUsageQuotaProviderId(activeModel);
  const noRateLimitsLabel = t('header.services.noRateLimitsReported');

  return React.useMemo(
    () => buildUsageProviderGroups({
      results: quotaResults,
      dropdownProviderIds,
      selectedModels: selectedQuotaModels,
      activeQuotaProviderId,
      noRateLimitsLabel,
    }),
    [activeQuotaProviderId, dropdownProviderIds, noRateLimitsLabel, quotaResults, selectedQuotaModels],
  );
};

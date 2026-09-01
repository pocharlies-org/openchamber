import React from 'react';
import { useI18n } from '@/lib/i18n';
import { formatWindowLabel, QUOTA_PROVIDERS, resolveQuotaProviderId } from '@/lib/quota';
import { getDisplayModelName } from '@/lib/quota/model-families';
import { useQuotaStore } from '@/stores/useQuotaStore';
import type { QuotaProviderId, UsageWindow } from '@/types';

export type UsageLimitRow = {
  key: string;
  label: string;
  subtitle?: string;
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

  return React.useMemo<UsageProviderGroup[]>(() => {
    if (activeQuotaProviderId === null) return [];

    const resultsByProvider = new Map(quotaResults.map((result) => [result.providerId, result]));
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
        const providerSelectedModels = selectedQuotaModels[providerMeta.id] ?? [];
        const visibleModelEntries = providerSelectedModels.length > 0
          ? modelEntries.filter(([modelName]) => providerSelectedModels.includes(modelName))
          : modelEntries;
        for (const [modelName, modelUsage] of visibleModelEntries) {
          const entries = Object.entries(modelUsage.windows ?? {});
          if (entries.length === 0) continue;
          const [label, window] = entries[0];
          rows.push({
            key: `model-${modelName}-${label}`,
            label: formatWindowLabel(label),
            subtitle: getDisplayModelName(modelName),
            window,
          });
        }

        const status = !result.ok && result.error
          ? result.error
          : rows.length === 0
            ? t('header.services.noRateLimitsReported')
            : null;

        return {
          providerId: providerMeta.id,
          providerName: providerMeta.name,
          rows,
          status,
        };
      });
  }, [activeQuotaProviderId, dropdownProviderIds, quotaResults, selectedQuotaModels, t]);
};

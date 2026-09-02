import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { preloadProviderLogos } from '@/hooks/useProviderLogo';
import { formatQuotaResetLabel, formatQuotaValueLabel } from '@/lib/quota';
import { useQuotaAutoRefresh, useQuotaStore } from '@/stores/useQuotaStore';
import { useSelectionStore } from '@/sync/selection-store';
import { useSessionMessages } from '@/sync/sync-context';
import { useUIStore } from '@/stores/useUIStore';
import { useUsageProviderGroups } from '@/components/usage/usageGroups';
import { useConfigStore } from '@/stores/useConfigStore';
import { pickUsageHeadline } from './usageHeadline';
import { runBackgroundNetworkTask } from '@/lib/background-network';
import { WorkStatusRow, WorkStatusCollapsibleSection, WorkStatusValue } from './WorkStatusPrimitives';
import { useReportWorkStatusPresence } from './presenceContext';
import type { UsageWindow } from '@/types';

/**
 * Provider rate limits.
 *
 * The mobile popover renders these as filled cards; that language does not
 * survive here — the fills and their padding fight the panel's flat rows and
 * cost roughly twice the height. Only the data is shared
 * (`useUsageProviderGroups`); the presentation is the panel's own row
 * vocabulary, with each provider as a quiet sub-heading.
 *
 * Sits above Subagents and MCP: a spent quota stops the work outright, so it
 * belongs with the readouts that hold for the whole session rather than with
 * whatever happens to be running.
 */

/**
 * The model this session runs on, read the way the mobile metadata popover
 * reads it: the newest user message wins, then the saved per-session choice,
 * then the composer.
 *
 * The panel is a session readout, so the composer cannot be its source — the
 * composer selection is global, and with several sessions open it reports what
 * some other session is pointed at. The message trail comes first because it is
 * what this session actually ran on; the composer is the fallback a brand-new
 * draft needs, where there is no trail yet.
 */
const useActiveSessionModel = (
  sessionId: string | null,
  directory: string | null | undefined,
): { providerID: string; modelID: string } | null => {
  const messages = useSessionMessages(sessionId ?? '', directory ?? undefined);
  const savedSessionModel = useSelectionStore(
    React.useCallback(
      (state) => (sessionId ? state.sessionModelSelections.get(sessionId) ?? null : null),
      [sessionId],
    ),
  );
  const currentProviderId = useConfigStore((state) => state.currentProviderId);
  const currentModelId = useConfigStore((state) => state.currentModelId);

  return React.useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i] as typeof messages[number] & {
        model?: { providerID?: string; modelID?: string };
      };
      if (message.role !== 'user') continue;
      const providerID = typeof message.model?.providerID === 'string' && message.model.providerID.trim().length > 0
        ? message.model.providerID
        : undefined;
      const modelID = typeof message.model?.modelID === 'string' && message.model.modelID.trim().length > 0
        ? message.model.modelID
        : undefined;
      if (providerID && modelID) return { providerID, modelID };
    }
    if (savedSessionModel) {
      return { providerID: savedSessionModel.providerId, modelID: savedSessionModel.modelId };
    }
    if (currentProviderId && currentModelId) {
      return { providerID: currentProviderId, modelID: currentModelId };
    }
    return null;
  }, [currentModelId, currentProviderId, messages, savedSessionModel]);
};

const windowTone = (window: UsageWindow): 'default' | 'warning' | 'error' => {
  const used = window.usedPercent;
  if (typeof used !== 'number' || !Number.isFinite(used)) return 'default';
  if (used >= 80) return 'error';
  if (used >= 50) return 'warning';
  return 'default';
};

export const WorkStatusUsageSection: React.FC<{
  sessionId?: string | null;
  directory?: string | null;
}> = ({ sessionId, directory }) => {
  const { t } = useI18n();
  const activeModel = useActiveSessionModel(sessionId ?? null, directory);
  const groups = useUsageProviderGroups(activeModel);
  const displayMode = useQuotaStore((state) => state.displayMode);
  const isLoading = useQuotaStore((state) => state.isLoading);
  const quotaResults = useQuotaStore((state) => state.results);
  const dropdownProviderIds = useQuotaStore((state) => state.dropdownProviderIds);
  const fetchQuotas = useQuotaStore((state) => state.fetchQuotas);
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const currentProviderId = useConfigStore((state) => state.currentProviderId);

  // Keeps the periodic refresh running while the panel is mounted.
  useQuotaAutoRefresh();

  // `useQuotaAutoRefresh` only schedules an interval — it never performs the
  // first fetch. That was owned by the header dropdown's open handler, so the
  // panel stayed empty until the user opened it. Kick off the initial load for
  // any enabled provider that has not reported yet, background-gated so it
  // cannot compete with chat bootstrap traffic.
  React.useEffect(() => {
    if (isLoading || dropdownProviderIds.length === 0) return;
    const missingProvider = dropdownProviderIds.some(
      (providerId) => !quotaResults.some((result) => result.providerId === providerId),
    );
    if (!missingProvider) return;
    void runBackgroundNetworkTask(() => fetchQuotas(dropdownProviderIds));
  }, [dropdownProviderIds, fetchQuotas, isLoading, quotaResults]);

  React.useEffect(() => {
    if (groups.length === 0) return;
    preloadProviderLogos(groups.map((group) => group.providerId));
  }, [groups]);

  useReportWorkStatusPresence('usage', groups.length > 0);

  if (groups.length === 0) return null;

  const modeLabel = displayMode === 'remaining'
    ? t('header.services.remaining')
    : t('header.services.used');

  // Collapsed, the section shows the tightest quota of the provider this
  // session runs on — the number that decides whether the next turn lands. With
  // no match it falls back to the display-mode label rather than showing some
  // other provider's quota as if it were the active one. The session's own model
  // wins over the composer for the same reason the list does: the composer is
  // global, so a panel pinned to one session must not read another's selection.
  const headline = pickUsageHeadline(groups, activeModel?.providerID ?? currentProviderId);
  const headlineMetric = headline
    ? formatQuotaValueLabel(
      headline.row.window.valueLabel,
      displayMode === 'remaining' ? headline.row.window.remainingPercent : headline.row.window.usedPercent,
    )
    : null;

  return (
    <WorkStatusCollapsibleSection
      id="usage"
      title={t('chat.workStatus.section.usage')}
      icon="timer"
      summary={(
        <span className="inline-flex items-center gap-1.5">
          {headline && headlineMetric && headlineMetric !== '-' ? (
            <>
              <span className="truncate">{headline.row.label}</span>
              <WorkStatusValue tone={windowTone(headline.row.window)}>{headlineMetric}</WorkStatusValue>
            </>
          ) : modeLabel}
        </span>
      )}
      action={(
        <Button
          size="icon"
          variant="ghost"
          className="size-6 shrink-0 text-muted-foreground"
          onClick={() => void fetchQuotas(dropdownProviderIds)}
          aria-label={t('settings.usage.sidebar.actions.refreshAria')}
          title={t('settings.usage.sidebar.actions.refreshTitle')}
          disabled={isLoading}
        >
          <Icon name="refresh" className={cn('size-3.5', isLoading && 'animate-spin')} />
        </Button>
      )}
    >
      {groups.map((group) => (
        <React.Fragment key={group.providerId}>
          <WorkStatusRow
            leading={<ProviderLogo providerId={group.providerId} className="size-4 shrink-0" />}
            label={group.providerName}
            muted
            value={group.status && group.rows.length === 0 ? (
              <WorkStatusValue tone="muted">{group.status}</WorkStatusValue>
            ) : undefined}
          />
          {group.rows.map((row) => {
            const displayPercent = displayMode === 'remaining'
              ? row.window.remainingPercent
              : row.window.usedPercent;
            const metricLabel = formatQuotaValueLabel(row.window.valueLabel, displayPercent);
            const resetLabel = formatQuotaResetLabel(
              row.window.resetAt,
              row.window.resetAfterFormatted ?? row.window.resetAtFormatted,
              timeFormatPreference,
            );
            return (
              <WorkStatusRow
                key={`${group.providerId}-${row.key}`}
                label={(
                  <span className="inline-flex min-w-0 items-baseline gap-1.5">
                    <span className="truncate">
                      {row.subtitle ? `${row.subtitle} · ${row.label}` : row.label}
                    </span>
                    {resetLabel ? (
                      <span className="shrink-0 text-[11px] text-muted-foreground">{resetLabel}</span>
                    ) : null}
                  </span>
                )}
                value={metricLabel === '-' ? undefined : (
                  <WorkStatusValue tone={windowTone(row.window)}>{metricLabel}</WorkStatusValue>
                )}
              />
            );
          })}
        </React.Fragment>
      ))}
    </WorkStatusCollapsibleSection>
  );
};

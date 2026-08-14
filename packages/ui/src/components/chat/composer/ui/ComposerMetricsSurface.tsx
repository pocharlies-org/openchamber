import React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { isDesktopShell, isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { isCapacitorApp } from '@/lib/platform';
import {
  isComposerMetricsContributionSupported,
  type ComposerMetricsContribution,
  type UIPluginRuntime,
} from '@/lib/uiPlugins';
import { cn } from '@/lib/utils';
import {
  getLatestCompletedAssistantMessage,
  streamMetrics,
  type StreamMetricIdentity,
  type StreamMetricSnapshot,
} from '@/sync/stream-metrics';
import { useSessionMessages } from '@/sync/sync-context';
import { findEnabledComposerMetricsContributions, useUIPluginsStore } from '@/stores/useUIPluginsStore';
import { compactMetricNumber, formatComposerMetricIndicator, formatMetricDuration } from './composer-metrics-format';

type ComposerMetricsSurfaceProps = {
  isMobile: boolean;
  sessionId: string | null;
  directory?: string;
  runtimeKey: string;
  placement: ComposerMetricsContribution['placement'];
  className?: string;
};

const getRuntime = (isMobile: boolean): UIPluginRuntime => {
  if (isVSCodeRuntime()) return 'vscode';
  if (isMobile) return isCapacitorApp() ? 'capacitorMobile' : 'hostedMobile';
  return isDesktopShell() ? 'desktop' : 'web';
};

const MetricDetails: React.FC<{ snapshot: StreamMetricSnapshot }> = ({ snapshot }) => {
  const { t } = useI18n();
  const rows = [
    [t('chat.streamMetrics.speed'), snapshot.speedTokensPerSecond === null ? '—' : `${snapshot.speedTokensPerSecond.toFixed(1)} tok/s`],
    [t('chat.streamMetrics.accuracy'), t(snapshot.exact ? 'chat.streamMetrics.exact' : 'chat.streamMetrics.estimated')],
    ['TTFT', formatMetricDuration(snapshot.ttftMs)],
    [t('chat.streamMetrics.inputTokens'), compactMetricNumber(snapshot.tokens.input)],
    [t('chat.streamMetrics.outputTokens'), compactMetricNumber(snapshot.tokens.output)],
    [t('chat.streamMetrics.reasoningTokens'), compactMetricNumber(snapshot.tokens.reasoning)],
    [t('chat.streamMetrics.cacheRead'), compactMetricNumber(snapshot.tokens.cacheRead)],
    [t('chat.streamMetrics.cacheWrite'), compactMetricNumber(snapshot.tokens.cacheWrite)],
    [t('chat.streamMetrics.duration'), formatMetricDuration(snapshot.durationMs)],
    [t('chat.streamMetrics.characters'), snapshot.characters.toLocaleString()],
    [t('chat.streamMetrics.bytes'), compactMetricNumber(snapshot.bytes)],
    [t('chat.streamMetrics.model'), snapshot.modelId ?? '—'],
    [t('chat.streamMetrics.provider'), snapshot.providerId ?? '—'],
  ];

  return (
    <div className="grid min-w-56 grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-left">
      {rows.map(([label, value]) => (
        <React.Fragment key={label}>
          <span className="text-muted-foreground">{label}</span>
          <span className="min-w-0 break-words text-right text-foreground">{value}</span>
        </React.Fragment>
      ))}
    </div>
  );
};

const MetricIndicator: React.FC<{
  identity: StreamMetricIdentity;
  isMobile: boolean;
}> = ({ identity, isMobile }) => {
  const { t } = useI18n();
  const subscribe = React.useCallback(
    (listener: () => void) => streamMetrics.subscribe(identity, listener),
    [identity],
  );
  const getSnapshot = React.useCallback(() => streamMetrics.getSnapshot(identity), [identity]);
  const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (!snapshot) return null;

  const accuracy = t(snapshot.exact ? 'chat.streamMetrics.exact' : 'chat.streamMetrics.estimated');

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            'typography-meta flex min-w-0 max-w-full items-center overflow-hidden rounded-md px-1.5 py-0.5 text-muted-foreground',
            'hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--interactive-focus-ring)]',
          )}
          aria-label={t('chat.streamMetrics.openDetails', { accuracy })}
        >
          <span className="truncate whitespace-nowrap">{formatComposerMetricIndicator(snapshot, isMobile)}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6} className="max-w-[min(22rem,calc(100vw-1rem))]">
        <MetricDetails snapshot={snapshot} />
      </TooltipContent>
    </Tooltip>
  );
};

export function ComposerMetricsSurface({
  isMobile,
  sessionId,
  directory,
  runtimeKey,
  placement,
  className,
}: ComposerMetricsSurfaceProps) {
  const catalog = useUIPluginsStore((state) => state.catalog);
  const disabledPluginIds = useUIPluginsStore((state) => state.disabledPluginIds);
  const contributions = React.useMemo(
    () => findEnabledComposerMetricsContributions({ catalog, disabledPluginIds })
      .filter((contribution) => contribution.placement === placement
        && isComposerMetricsContributionSupported(contribution, getRuntime(isMobile))),
    [catalog, disabledPluginIds, isMobile, placement],
  );
  const identity = React.useMemo<StreamMetricIdentity | null>(() => (
    sessionId && directory
      ? { runtimeKey, directory, sessionId }
      : null
  ), [directory, runtimeKey, sessionId]);
  const messages = useSessionMessages(sessionId ?? '', directory);
  const latestCompletedAssistant = React.useMemo(
    () => getLatestCompletedAssistantMessage(messages),
    [messages],
  );

  React.useEffect(() => {
    if (!identity || contributions.length === 0 || !latestCompletedAssistant) return;
    streamMetrics.hydrateCompleted(identity, latestCompletedAssistant);
  }, [contributions.length, identity, latestCompletedAssistant]);

  if (!identity || contributions.length === 0) return null;

  return (
    <div className={cn('flex min-w-0 max-w-full items-center overflow-hidden', className)} data-composer-metrics="true">
      {contributions.map((contribution) => (
        <MetricIndicator key={contribution.id} identity={identity} isMobile={isMobile} />
      ))}
    </div>
  );
}

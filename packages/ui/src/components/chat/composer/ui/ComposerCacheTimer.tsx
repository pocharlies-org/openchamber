import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { getLatestCompletedAssistantMessage } from '@/sync/stream-metrics';
import { useSessionMessages } from '@/sync/sync-context';

const MINUTE = 60_000;

/**
 * Prompt-cache TTL of the provider that served the last turn, or null when the
 * provider has no TTL worth counting down. Claude Code (every account provider,
 * `claude-code` and `claude-code-<account>`) writes its cache with the 1h TTL —
 * the CLI transcripts only ever show `ephemeral_1h_input_tokens`. The raw
 * Anthropic API defaults to 5 minutes.
 */
const promptCacheTtlMs = (providerId: string | undefined): number | null => {
  if (!providerId) return null;
  if (providerId === 'claude-code' || providerId.startsWith('claude-code-')) return 60 * MINUTE;
  if (providerId === 'anthropic') return 5 * MINUTE;
  return null;
};

const formatCacheDuration = (ms: number): string => {
  if (ms < MINUTE) return '<1m';
  const minutes = Math.floor(ms / MINUTE);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
};

const useNow = (intervalMs: number): number => {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
};

type ComposerCacheTimerProps = {
  sessionId: string | null;
  directory?: string;
  className?: string;
};

/**
 * Time left before the prompt cache of this session expires, counted from the
 * end of the last assistant turn — the same "last prompt" clock the Claude
 * Code VS Code extension shows. A turn after expiry re-writes the whole
 * context, so this is the number that says whether continuing now is cheap.
 */
export function ComposerCacheTimer({ sessionId, directory, className }: ComposerCacheTimerProps) {
  const { t } = useI18n();
  const messages = useSessionMessages(sessionId ?? '', directory);
  const last = React.useMemo(() => getLatestCompletedAssistantMessage(messages), [messages]);
  const now = useNow(10_000);

  if (!sessionId || !last) return null;
  const ttl = promptCacheTtlMs(last.providerID);
  const endedAt = last.time.completed ?? last.time.created;
  if (ttl === null || !endedAt) return null;

  const elapsed = Math.max(0, now - endedAt);
  const left = ttl - elapsed;
  const expired = left <= 0;
  const ago = formatCacheDuration(elapsed);
  const ttlLabel = formatCacheDuration(ttl);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'typography-meta flex flex-shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5',
            expired
              ? 'text-[var(--status-error)]'
              : left <= 5 * MINUTE
                ? 'text-[var(--status-warning)]'
                : 'text-muted-foreground',
            className,
          )}
          data-composer-cache-timer="true"
        >
          <Icon name="timer" className="h-3.5 w-3.5 text-current" />
          {expired ? t('chat.cacheTimer.expired') : formatCacheDuration(left)}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        {expired
          ? t('chat.cacheTimer.tooltipExpired', { ago, ttl: ttlLabel })
          : t('chat.cacheTimer.tooltip', { ago, ttl: ttlLabel, left: formatCacheDuration(left) })}
      </TooltipContent>
    </Tooltip>
  );
}

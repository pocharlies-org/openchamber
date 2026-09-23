import React, { memo } from 'react';

import { Icon } from '@/components/icon/Icon';
import { BusyDots } from '@/components/chat/message/parts/BusyDots';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { getClaudeLiveState, type ClaudeLiveOwnerKind } from '@/lib/claudeSessionMetadata';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useSession } from '@/sync/sync-context';

const TITLE_KEYS = {
  terminal: 'chat.claudeLive.title.terminal',
  vscode: 'chat.claudeLive.title.vscode',
  desktop: 'chat.claudeLive.title.desktop',
  other: 'chat.claudeLive.title.other',
} as const satisfies Record<ClaudeLiveOwnerKind, string>;

type ClaudeLiveSessionBannerProps = {
  sessionId: string | null;
  directory: string | null;
};

/**
 * Where a Claude Code session is live besides this window.
 *
 * Open in another process (a terminal, VS Code, Claude Desktop): the
 * transcript follows live here, but only one process may write it, so the
 * composer offers to take it over — the other process is closed and this one
 * resumes it. Linked to claude.ai: a link to continue it from there or the
 * Claude app.
 */
export const ClaudeLiveSessionBanner = memo(({ sessionId, directory }: ClaudeLiveSessionBannerProps) => {
  const { t } = useI18n();
  const session = useSession(sessionId, directory ?? undefined);
  const { liveElsewhere, remoteControlUrl } = getClaudeLiveState(session);
  const [takingOver, setTakingOver] = React.useState(false);

  const handleTakeOver = React.useCallback(async () => {
    if (!sessionId) return;
    setTakingOver(true);
    try {
      const response = await runtimeFetch(`/api/session/${encodeURIComponent(sessionId)}/claude/takeover`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ directory }),
      });
      if (!response.ok) toast.error(t('chat.claudeLive.toast.takeOverFailed'));
    } catch {
      toast.error(t('chat.claudeLive.toast.takeOverFailed'));
    } finally {
      setTakingOver(false);
    }
  }, [directory, sessionId, t]);

  if (!sessionId || (!liveElsewhere && !remoteControlUrl)) {
    return null;
  }

  const remoteLink = remoteControlUrl ? (
    <Button asChild type="button" variant="secondary" size="xs">
      <a href={remoteControlUrl} target="_blank" rel="noreferrer">
        <Icon name="smartphone" className="h-3.5 w-3.5" aria-hidden="true" />
        {t('chat.claudeLive.actions.openRemote')}
      </a>
    </Button>
  ) : null;

  if (!liveElsewhere) {
    return (
      <div className="pb-2 w-full px-1">
        <div className="flex w-full items-center gap-2 rounded-xl border border-border/60 bg-[var(--surface-elevated)] px-3 py-1.5 text-[var(--surface-elevated-foreground)]">
          <Icon name="claude-code" className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <span className="typography-meta min-w-0 flex-1 text-muted-foreground">
            {t('chat.claudeLive.remoteLinked')}
          </span>
          {remoteLink}
        </div>
      </div>
    );
  }

  return (
    <div className="pb-2 w-full px-1">
      <div className="rounded-xl border border-border/60 bg-[var(--surface-elevated)] text-[var(--surface-elevated-foreground)] shadow-sm overflow-hidden">
        <div className="flex w-full items-center gap-2 px-3 py-2 text-left">
          <Icon name="lock" className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <span className="typography-ui-label font-medium text-foreground">
              {t(TITLE_KEYS[liveElsewhere.kind])}
              {liveElsewhere.busy ? <BusyDots /> : null}
            </span>
            <div className="typography-meta text-muted-foreground">
              {t('chat.claudeLive.description')}
            </div>
          </div>
          {remoteLink}
          <Button
            type="button"
            variant="secondary"
            size="xs"
            disabled={takingOver}
            onClick={() => { void handleTakeOver(); }}
          >
            {t('chat.claudeLive.actions.takeOver')}
          </Button>
        </div>
      </div>
    </div>
  );
});

ClaudeLiveSessionBanner.displayName = 'ClaudeLiveSessionBanner';

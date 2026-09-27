import React, { memo } from 'react';

import { Icon } from '@/components/icon/Icon';
import { BusyDots } from '@/components/chat/message/parts/BusyDots';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { claudeVSCodeUrl, getClaudeLiveState, type ClaudeLiveOwnerKind } from '@/lib/claudeSessionMetadata';
import { CLAUDE_FOLLOW_KEEPALIVE_MS, keepFollowingClaudeSession, releaseClaudeSession, takeOverClaudeSession } from '@/lib/claudeTakeOver';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/sync/sync-context';
import { cn } from '@/lib/utils';

const TITLE_KEYS = {
  terminal: 'chat.claudeLive.title.terminal',
  vscode: 'chat.claudeLive.title.vscode',
  desktop: 'chat.claudeLive.title.desktop',
  other: 'chat.claudeLive.title.other',
} as const satisfies Record<ClaudeLiveOwnerKind, string>;

// Below `sm` the text takes the whole row after the icon (1rem + 0.5rem gap)
// and the actions take the next row, indented to the text, wrapping among
// themselves: a row that may not shrink ran off a 390px screen (measured).
const OWN_LINE_ON_PHONE = 'basis-[calc(100%-1.5rem)] sm:basis-auto';
const ACTIONS_CLASS = 'flex min-w-0 basis-full flex-wrap items-center gap-2 pl-6 sm:basis-auto sm:shrink-0 sm:pl-0';

type ClaudeLiveSessionBannerProps = {
  sessionId: string | null;
  directory: string | null;
};

/**
 * Where a Claude Code session is live besides this window.
 *
 * Open in another process (a terminal, VS Code, Claude Desktop): the
 * transcript follows live here. Linked to claude.ai, the composer writes to it
 * through that link and that process answers, as Claude Desktop does. Either
 * way it can be taken over — the other process is closed and this one resumes
 * it. Linked to claude.ai: a link to continue it from there or the
 * Claude app, and one to open it in VS Code.
 */
export const ClaudeLiveSessionBanner = memo(({ sessionId, directory }: ClaudeLiveSessionBannerProps) => {
  const { t } = useI18n();
  const session = useSession(sessionId, directory ?? undefined);
  const { liveElsewhere, remoteControlUrl } = getClaudeLiveState(session);
  const [takingOver, setTakingOver] = React.useState(false);
  const isLiveElsewhere = Boolean(liveElsewhere);

  // While this banner shows a session another process writes, its messages
  // keep streaming here however long it stays open.
  React.useEffect(() => {
    if (!sessionId || !isLiveElsewhere) return undefined;
    void keepFollowingClaudeSession(sessionId, directory);
    const timer = window.setInterval(() => {
      void keepFollowingClaudeSession(sessionId, directory);
    }, CLAUDE_FOLLOW_KEEPALIVE_MS);
    return () => window.clearInterval(timer);
  }, [directory, isLiveElsewhere, sessionId]);

  const handleTakeOver = React.useCallback(async () => {
    if (!sessionId) return;
    setTakingOver(true);
    const ok = await takeOverClaudeSession(sessionId, directory);
    if (!ok) toast.error(t('chat.claudeLive.toast.takeOverFailed'));
    setTakingOver(false);
  }, [directory, sessionId, t]);

  const [releasingVSCode, setReleasingVSCode] = React.useState(false);
  // The VS Code extension refuses a transcript a live process holds (single
  // writer): release ours first — a no-op when this server hosts nothing — and
  // only then open the link, as the handoff does.
  const handleOpenVSCode = React.useCallback((event: React.MouseEvent<HTMLAnchorElement>) => {
    const url = claudeVSCodeUrl(sessionId);
    if (!sessionId || !url) return;
    event.preventDefault();
    setReleasingVSCode(true);
    void releaseClaudeSession(sessionId, directory).then((result) => {
      setReleasingVSCode(false);
      if (!result.released) {
        toast.error(t(result.busy ? 'chat.claudeLive.toast.vscodeBusy' : 'chat.claudeLive.toast.vscodeFailed'));
        return;
      }
      window.open(url, '_blank', 'noopener');
    });
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

  const vscodeUrl = claudeVSCodeUrl(sessionId);
  const vscodeLink = vscodeUrl ? (
    <Button asChild type="button" variant="secondary" size="xs">
      <a href={vscodeUrl} target="_blank" rel="noreferrer" onClick={handleOpenVSCode} aria-disabled={releasingVSCode || undefined}>
        <Icon name="code" className="h-3.5 w-3.5" aria-hidden="true" />
        {t('chat.claudeLive.actions.openVSCode')}
      </a>
    </Button>
  ) : null;

  if (!liveElsewhere) {
    return (
      <div className="pb-2 w-full px-1">
        {/* Wraps on a phone: the sentence keeps a line of its own and the links
            go under it. In one row, three items that do not fit squeezed the
            sentence to one word per line (seen on iOS, 27-09-2026). */}
        <div className="flex w-full flex-wrap items-center gap-x-2 gap-y-1.5 rounded-xl border border-border/60 bg-[var(--surface-elevated)] px-3 py-1.5 text-[var(--surface-elevated-foreground)]">
          <Icon name="claude-code" className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className={cn('typography-meta min-w-0 flex-1 text-muted-foreground', OWN_LINE_ON_PHONE)}>
            {t('chat.claudeLive.remoteLinked')}
          </span>
          <div className={ACTIONS_CLASS}>
            {remoteLink}
            {vscodeLink}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pb-2 w-full px-1">
      <div className="rounded-xl border border-border/60 bg-[var(--surface-elevated)] text-[var(--surface-elevated-foreground)] shadow-sm overflow-hidden">
        <div className="flex w-full flex-wrap items-center gap-x-2 gap-y-1.5 px-3 py-2 text-left">
          <Icon name={liveElsewhere.attachable ? 'lock-unlock' : 'lock'} className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className={cn('min-w-0 flex-1', OWN_LINE_ON_PHONE)}>
            <span className="typography-ui-label font-medium text-foreground">
              {t(TITLE_KEYS[liveElsewhere.kind])}
              {liveElsewhere.busy ? <BusyDots /> : null}
            </span>
            <div className="typography-meta text-muted-foreground">
              {t(liveElsewhere.attachable ? 'chat.claudeLive.descriptionAttached' : 'chat.claudeLive.description')}
            </div>
          </div>
          <div className={ACTIONS_CLASS}>
          {remoteLink}
          {vscodeLink}
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
    </div>
  );
});

ClaudeLiveSessionBanner.displayName = 'ClaudeLiveSessionBanner';

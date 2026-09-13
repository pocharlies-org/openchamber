import React from 'react';

import { Icon } from '@/components/icon/Icon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { useI18n } from '@/lib/i18n';
import { SESSION_SOURCE_FILTERS, SESSION_SOURCE_LABEL_KEYS } from '@/lib/sessionSourceFilter';
import { cn } from '@/lib/utils';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useSessionSourceFilterStore } from '@/stores/useSessionSourceFilterStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSession } from '@/sync/sync-context';

import { MobileSessionMetadataButton } from './MobileSessionMetadata';
import { MobileSessionSwitcher } from './MobileSessionSwitcher';

export const MobileHeader: React.FC<{
  onOpenSessions: () => void;
  /** Opens the right workspace drawer (Changes / Files / Terminal / Notes / MCP). */
  onOpenWorkspace: () => void;
  /** Tablet: size the title trigger to its text instead of the free width, so
      a wide header doesn't turn the switcher into a full-width tap target. */
  compactTitle?: boolean;
}> = ({ onOpenSessions, onOpenWorkspace, compactTitle = false }) => {
  const { t } = useI18n();
  const [metadataOpen, setMetadataOpen] = React.useState(false);
  const [switcherOpen, setSwitcherOpen] = React.useState(false);
  const titleRef = React.useRef<HTMLButtonElement>(null);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentSessionDirectory = useSessionUIStore(
    React.useCallback((state) => (currentSessionId ? state.getDirectoryForSession(currentSessionId) : null), [currentSessionId]),
  );
  const effectiveDirectory = currentSessionDirectory || currentDirectory;
  const currentSession = useSession(currentSessionId, effectiveDirectory || undefined);
  const isNewSessionDraftOpen = useSessionUIStore((state) => Boolean(state.newSessionDraft?.open));
  const sourceFilterAvailable = useSessionSourceFilterStore((state) => state.available);
  const sourceFilter = useSessionSourceFilterStore((state) => state.filter);
  const setSourceFilter = useSessionSourceFilterStore((state) => state.setFilter);

  const sessionTitle = currentSession?.title?.trim();
  // Single-line title, desktop-style: session title, or the "New session"
  // placeholder on the draft screen. No project/branch metadata line.
  const primaryLabel = sessionTitle
    || (currentSessionId ? t('mobile.sessions.untitled') : t('sessions.switcher.draftTitle'));

  React.useEffect(() => {
    setMetadataOpen(false);
    setSwitcherOpen(false);
  }, [currentSessionId, effectiveDirectory]);

  const handleOpenSessions = React.useCallback(() => {
    setMetadataOpen(false);
    setSwitcherOpen(false);
    onOpenSessions();
  }, [onOpenSessions]);

  // The two header popovers are mutually exclusive.
  const handleMetadataOpenChange = React.useCallback((value: boolean | ((open: boolean) => boolean)) => {
    setMetadataOpen((current) => {
      const next = typeof value === 'function' ? value(current) : value;
      if (next) setSwitcherOpen(false);
      return next;
    });
  }, []);

  const toggleSwitcher = React.useCallback(() => {
    setSwitcherOpen((current) => {
      const next = !current;
      if (next) setMetadataOpen(false);
      return next;
    });
  }, []);

  return (
    <>
      <header
        className="oc-mobile-header relative z-30 flex shrink-0 items-center gap-1 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80"
        style={{ paddingTop: 'var(--oc-safe-area-top, 0px)' }}
      >
        <div className="flex h-[var(--oc-header-height,56px)] w-full items-center gap-1 px-2">
          <button
            type="button"
            className="flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={t('mobile.sessions.openSheetAria')}
            onClick={handleOpenSessions}
            style={{ touchAction: 'manipulation' }}
          >
            <Icon name="list-unordered" className="size-5" />
          </button>

          {/* Which tool owns the sessions is a question asked before the drawer
              is opened, so it gets a header control rather than living only
              inside the sheet. Icon-only while unfiltered; the tool's own name
              once one is picked, so the active filter reads at a glance. */}
          {sourceFilterAvailable ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={cn(dropdownTriggerVariants({ size: 'default' }), 'shrink-0')}
                  aria-label={t('sessions.sidebar.header.sourceFilter.label')}
                  style={{ touchAction: 'manipulation' }}
                >
                  <Icon name="equalizer-2" className="size-4" />
                  {sourceFilter === 'all' ? null : (
                    <span className="min-w-0 truncate">{t(SESSION_SOURCE_LABEL_KEYS[sourceFilter])}</span>
                  )}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-[180px]">
                <DropdownMenuLabel>{t('sessions.sidebar.header.sourceFilter.label')}</DropdownMenuLabel>
                {SESSION_SOURCE_FILTERS.map((source) => (
                  <DropdownMenuItem
                    key={source}
                    onSelect={() => setSourceFilter(source)}
                    className="flex items-center justify-between"
                  >
                    <span>{t(SESSION_SOURCE_LABEL_KEYS[source])}</span>
                    {sourceFilter === source ? <Icon name="check" className="size-4 text-primary" /> : null}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}

          {/* Session title doubles as the recent-sessions switcher trigger. */}
          <button
            ref={titleRef}
            type="button"
            className={cn(
              'flex min-w-0 items-center rounded-lg px-2 py-1.5 text-left transition-colors active:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
              compactTitle ? 'shrink' : 'flex-1',
            )}
            aria-label={t('sessions.switcher.openAria')}
            aria-haspopup="dialog"
            aria-expanded={switcherOpen}
            onClick={toggleSwitcher}
            style={{ touchAction: 'manipulation' }}
          >
            <span className="flex min-w-0 items-center gap-1">
              <span className="block min-w-0 truncate typography-ui-label text-foreground">{primaryLabel}</span>
              {/* Discoverability: the chevron marks the title as a disclosure
                  trigger and flips while the switcher is open. */}
              <Icon
                name="arrow-down-s"
                className={cn(
                  'size-4 shrink-0 text-muted-foreground transition-transform duration-150',
                  switcherOpen && 'rotate-180',
                )}
              />
            </span>
          </button>

          {/* Compact title: this takes the leftover width so the trailing
              controls stay pinned to the right edge. */}
          {compactTitle ? <div className="min-w-0 flex-1" /> : null}

          <MobileSessionMetadataButton
            open={metadataOpen}
            onOpenChange={handleMetadataOpenChange}
            currentSessionId={currentSessionId}
            effectiveDirectory={effectiveDirectory}
            isNewSessionDraftOpen={isNewSessionDraftOpen}
          />

          <button
            type="button"
            className="flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={t('mobile.header.openWorkspaceAria')}
            onClick={() => {
              setMetadataOpen(false);
              setSwitcherOpen(false);
              onOpenWorkspace();
            }}
            style={{ touchAction: 'manipulation' }}
          >
            <Icon name="pencil-ruler-2" className="size-5" />
          </button>
        </div>
      </header>
      <MobileSessionSwitcher
        open={switcherOpen}
        onClose={() => setSwitcherOpen(false)}
        anchorRef={titleRef}
      />
    </>
  );
};

import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { getCurrentIntlLocale, useI18n, type I18nKey } from '@/lib/i18n';
import { openExternalUrl } from '@/lib/url';
import { loadCompanyOfficeSnapshot, type CompanyOfficeActivity, type CompanyOfficeSnapshot } from '@/lib/companyOffice';
import { isDesktopShell, isVSCodeRuntime } from '@/lib/desktop';
import { isCapacitorApp } from '@/lib/platform';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useDeviceInfo } from '@/lib/device';
import { isWorkspaceViewContributionSupported, type UIPluginRuntime } from '@/lib/uiPlugins';
import { findEnabledWorkspaceViewContributions, useUIPluginsStore } from '@/stores/useUIPluginsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { cn } from '@/lib/utils';

type LoadState =
  | { status: 'idle' | 'loading'; snapshot: CompanyOfficeSnapshot | null }
  | { status: 'ready'; snapshot: CompanyOfficeSnapshot }
  | { status: 'error'; snapshot: CompanyOfficeSnapshot | null };

const resolveRuntime = (isMobile: boolean): UIPluginRuntime => isVSCodeRuntime()
  ? 'vscode'
  : isMobile
    ? isCapacitorApp() ? 'capacitorMobile' : 'hostedMobile'
    : isDesktopShell() ? 'desktop' : 'web';

const activityClass = (activity: CompanyOfficeActivity): string => activity === 'busy'
  ? 'bg-primary'
  : activity === 'idle'
    ? 'bg-[var(--status-success)]'
    : 'bg-muted-foreground/50';

const sourceTone = (state: 'ready' | 'partial' | 'error'): string => state === 'ready'
  ? 'border-[var(--status-success-border)] bg-[var(--status-success-background)] text-[var(--status-success-foreground)]'
  : state === 'partial'
    ? 'border-[var(--status-warning-border)] bg-[var(--status-warning-background)] text-[var(--status-warning-foreground)]'
    : 'border-[var(--status-error-border)] bg-[var(--status-error-background)] text-[var(--status-error-foreground)]';

const sourceKeys = {
  roster: 'companyOffice.sources.roster',
  sessions: 'companyOffice.sources.sessions',
  activity: 'companyOffice.sources.activity',
  jira: 'companyOffice.sources.jira',
} satisfies Record<string, I18nKey>;

const sourceStateKeys = {
  ready: 'companyOffice.sourceState.ready',
  partial: 'companyOffice.sourceState.partial',
  error: 'companyOffice.sourceState.error',
} satisfies Record<string, I18nKey>;

const activityKeys = {
  busy: 'companyOffice.activity.busy',
  idle: 'companyOffice.activity.idle',
  unknown: 'companyOffice.activity.unknown',
} satisfies Record<CompanyOfficeActivity, I18nKey>;

export function CompanyOfficeView({ onNavigateToSession }: { onNavigateToSession?: () => void } = {}): React.ReactNode {
  const { t } = useI18n();
  const open = useUIStore((state) => state.isCompanyOfficePageOpen);
  const setOpen = useUIStore((state) => state.setCompanyOfficePageOpen);
  const setActiveMainTab = useUIStore((state) => state.setActiveMainTab);
  const { isMobile } = useDeviceInfo();
  const workspaceView = useUIPluginsStore((state) => findEnabledWorkspaceViewContributions(state).find(
    (contribution) => isWorkspaceViewContributionSupported(contribution, resolveRuntime(isMobile)),
  ) ?? null);
  const [loadState, setLoadState] = React.useState<LoadState>({ status: 'idle', snapshot: null });
  const generationRef = React.useRef(0);

  const load = React.useCallback(() => {
    if (!open || !workspaceView) return () => {};
    const generation = ++generationRef.current;
    const controller = new AbortController();
    setLoadState((current) => ({ status: 'loading', snapshot: current.snapshot }));
    void loadCompanyOfficeSnapshot(workspaceView.endpoint, controller.signal).then((snapshot) => {
      if (generation === generationRef.current) setLoadState({ status: 'ready', snapshot });
    }).catch((error) => {
      if (controller.signal.aborted) return;
      console.error('[CompanyOffice] Failed to load snapshot:', error);
      if (generation === generationRef.current) {
        setLoadState((current) => ({ status: 'error', snapshot: current.snapshot }));
      }
    });
    return () => controller.abort();
  }, [open, workspaceView]);

  React.useEffect(load, [load]);
  React.useEffect(() => subscribeRuntimeEndpointChanged(() => {
    generationRef.current += 1;
    setLoadState({ status: 'idle', snapshot: null });
    load();
  }), [load]);

  if (!open) return null;
  const snapshot = loadState.snapshot;

  const openSession = (session: { id: string; directory: string }) => {
    void useSessionUIStore.getState().setCurrentSession(session.id, session.directory);
    setActiveMainTab('chat');
    setOpen(false);
    onNavigateToSession?.();
  };

  return (
    <div className="absolute inset-0 z-10 overflow-y-auto bg-background">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-5 sm:px-6 lg:px-8">
        <section className="overflow-hidden rounded-2xl border border-border bg-[var(--surface-elevated)]">
          <div className="flex flex-col gap-5 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-7">
            <div className="min-w-0">
              <div className="mb-2 flex items-center gap-2 text-muted-foreground">
                <Icon name="home-office" className="size-4" />
                <span className="typography-micro uppercase tracking-[0.12em]">{t('companyOffice.hero.eyebrow')}</span>
              </div>
              <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
                {snapshot?.company.displayName ?? t('companyOffice.title')}
              </h1>
              <p className="mt-2 max-w-2xl typography-ui-label text-muted-foreground">
                {snapshot
                  ? t('companyOffice.hero.description', { ceo: snapshot.company.ceo })
                  : t('companyOffice.hero.descriptionLoading')}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <Button
                onClick={() => snapshot?.intakeSession && openSession(snapshot.intakeSession)}
                disabled={!snapshot?.intakeSession}
              >
                <Icon name="chat-3" className="size-4" />
                {t('companyOffice.actions.talkToCto')}
              </Button>
              <Button variant="outline" onClick={() => { load(); }} disabled={loadState.status === 'loading'}>
                <Icon name="refresh" className={cn('size-4', loadState.status === 'loading' && 'animate-spin')} />
                {t('companyOffice.actions.refresh')}
              </Button>
            </div>
          </div>
          {snapshot ? (
            <div className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-3 sm:px-7">
              {Object.entries(snapshot.sources).map(([source, state]) => (
                <span key={source} className={cn('rounded-full border px-2 py-1 typography-micro', sourceTone(state))}>
                  {t(sourceKeys[source as keyof typeof sourceKeys])}: {t(sourceStateKeys[state])}
                </span>
              ))}
              <span className="typography-micro text-muted-foreground">
                {t('companyOffice.freshness', {
                  time: new Intl.DateTimeFormat(getCurrentIntlLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(snapshot.generatedAt)),
                })}
              </span>
            </div>
          ) : null}
        </section>

        {loadState.status === 'error' && !snapshot ? (
          <section className="rounded-2xl border border-[var(--status-error-border)] bg-[var(--status-error-background)] p-6 text-[var(--status-error-foreground)]">
            <div className="flex items-start gap-3">
              <Icon name="error-warning" className="mt-0.5 size-5" />
              <div>
                <h2 className="font-medium">{t('companyOffice.error.title')}</h2>
                <p className="mt-1 typography-ui-label">{t('companyOffice.error.description')}</p>
                <Button className="mt-4" variant="outline" onClick={() => { load(); }}>{t('companyOffice.actions.retry')}</Button>
              </div>
            </div>
          </section>
        ) : null}

        {!workspaceView ? (
          <section className="rounded-2xl border border-border bg-[var(--surface-elevated)] p-6 text-muted-foreground">
            {t('companyOffice.unavailable')}
          </section>
        ) : null}

        {loadState.status === 'loading' && !snapshot ? (
          <section className="flex min-h-64 items-center justify-center rounded-2xl border border-border bg-[var(--surface-elevated)] text-muted-foreground">
            <Icon name="loader-4" className="mr-2 size-5 animate-spin" />
            {t('companyOffice.loading')}
          </section>
        ) : null}

        {snapshot ? (
          <>
            <section>
              <div className="mb-3 flex items-end justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold text-foreground">{t('companyOffice.team.title')}</h2>
                  <p className="typography-ui-label text-muted-foreground">{t('companyOffice.team.description')}</p>
                </div>
                <span className="typography-micro text-muted-foreground">{t('companyOffice.team.count', { count: snapshot.employees.length })}</span>
              </div>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {snapshot.employees.map((employee) => (
                  <article key={employee.id} className="rounded-2xl border border-border bg-[var(--surface-elevated)] p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[var(--surface-muted)] text-foreground">
                          <Icon name="user-3" className="size-5" />
                        </div>
                        <div className="min-w-0">
                          <h3 className="truncate font-medium text-foreground">{employee.name}</h3>
                          <p className="truncate typography-micro text-muted-foreground">{employee.title}{employee.specialty ? ` · ${employee.specialty}` : ''}</p>
                        </div>
                      </div>
                      <span className="flex items-center gap-1.5 typography-micro text-muted-foreground">
                        <span className={cn('size-2 rounded-full', activityClass(employee.activity))} />
                        {t(activityKeys[employee.activity])}
                      </span>
                    </div>
                    <div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-3">
                      <span className="truncate typography-micro text-muted-foreground" title={employee.model}>{employee.model}</span>
                      <span className="typography-micro text-muted-foreground">{t('companyOffice.sessions.count', { count: employee.sessions.length })}</span>
                    </div>
                    {!employee.sessionsAvailable ? (
                      <p className="mt-3 rounded-lg bg-[var(--status-error-background)] px-2 py-1.5 typography-micro text-[var(--status-error-foreground)]">
                        {t('companyOffice.sessions.unavailable')}
                      </p>
                    ) : null}
                    <div className="mt-2 space-y-1">
                      {employee.sessions.slice(0, 4).map((session) => (
                        <button
                          key={session.id}
                          type="button"
                          onClick={() => openSession(session)}
                          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                        >
                          <span className={cn('size-1.5 shrink-0 rounded-full', activityClass(session.activity))} />
                          <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground">{session.title}</span>
                          <Icon name="arrow-right-s" className="size-4 shrink-0 text-muted-foreground" />
                        </button>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
            </section>

            <section>
              <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold text-foreground">{t('companyOffice.initiatives.title')}</h2>
                  <p className="typography-ui-label text-muted-foreground">{t('companyOffice.initiatives.description')}</p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => { void openExternalUrl(snapshot.company.jiraProjectUrl); }}>
                  {t('companyOffice.actions.openJira')}
                  <Icon name="external-link" className="size-4" />
                </Button>
              </div>
              {snapshot.sources.jira === 'error' ? (
                <div className="rounded-2xl border border-[var(--status-error-border)] bg-[var(--status-error-background)] p-4 text-[var(--status-error-foreground)]">
                  {t('companyOffice.jiraUnavailable')}
                </div>
              ) : snapshot.initiatives.length === 0 ? (
                <div className="rounded-2xl border border-border bg-[var(--surface-elevated)] p-6 text-muted-foreground">
                  {t('companyOffice.initiatives.empty')}
                </div>
              ) : (
                <div className="space-y-3">
                  {snapshot.initiatives.map((initiative) => (
                    <article key={initiative.key} className="overflow-hidden rounded-2xl border border-border bg-[var(--surface-elevated)]">
                      <div className="flex flex-wrap items-start justify-between gap-3 p-4 sm:p-5">
                        <div className="min-w-0">
                          <button type="button" onClick={() => { void openExternalUrl(initiative.url); }} className="typography-micro font-medium text-primary hover:underline">
                            {initiative.key}
                          </button>
                          <h3 className="mt-1 font-medium text-foreground">{initiative.summary}</h3>
                        </div>
                        <span className="rounded-full border border-border px-2 py-1 typography-micro text-muted-foreground">{initiative.status}</span>
                      </div>
                      <div className="divide-y divide-border border-t border-border">
                        {initiative.tickets.map((ticket) => (
                          <div key={ticket.key} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:px-5">
                            <div className="flex min-w-0 flex-1 items-center gap-3">
                              <button type="button" onClick={() => { void openExternalUrl(ticket.url); }} className="shrink-0 typography-micro font-medium text-primary hover:underline">{ticket.key}</button>
                              <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground">{ticket.summary}</span>
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                              <span className="typography-micro text-muted-foreground">{ticket.status}</span>
                              {ticket.session ? (
                                <Button variant="ghost" size="xs" onClick={() => openSession(ticket.session!)}>
                                  {t('companyOffice.actions.openSession')}
                                  <Icon name="arrow-right-s" className="size-3.5" />
                                </Button>
                              ) : null}
                              {ticket.mapping === 'ambiguous' ? (
                                <span className="typography-micro text-[var(--status-warning-foreground)]">{t('companyOffice.mapping.ambiguous')}</span>
                              ) : null}
                            </div>
                          </div>
                        ))}
                      </div>
                    </article>
                  ))}
                </div>
              )}
              <p className="mt-3 typography-micro text-muted-foreground">{t('companyOffice.mapping.reconstructed')}</p>
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}

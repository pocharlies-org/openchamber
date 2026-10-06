import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { agentStatusOf, formatElapsed, mergeChildren, type AgentStatus } from '@/lib/claudeAgentMap';
import { getClaudeSubagentState } from '@/lib/claudeSessionMetadata';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { opencodeClient } from '@/lib/opencode/client';
import type { Session } from '@/lib/opencode/model';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useDirectorySync, useSessions } from '@/sync/sync-context';

const STATUS_LABELS = {
    running: 'chat.agentMap.running',
    completed: 'chat.agentMap.completed',
    failed: 'chat.agentMap.failed',
    stopped: 'chat.agentMap.stopped',
} satisfies Record<AgentStatus, I18nKey>;

/**
 * The agent map of a Claude Code session, as the VS Code extension's: an
 * "N agents" pill in the composer footer whose dot says whether any subagent
 * still works; open, it lists each subagent with its status and elapsed time,
 * opens its read-only transcript, or stops it while it runs.
 */
export const ClaudeAgentMap: React.FC<{ sessionId: string; directory?: string; className?: string }> = ({ sessionId, directory, className }) => {
    const { t } = useI18n();
    const sessions = useSessions(directory);
    const statuses = useDirectorySync(React.useCallback((state) => state.session_status, []), directory);
    const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
    const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
    const isMobile = useUIStore((state) => state.isMobile);

    const live = React.useMemo(() => sessions.filter((session) => session.parentID === sessionId), [sessions, sessionId]);
    const [fetched, setFetched] = React.useState<Session[]>([]);
    const [open, setOpen] = React.useState(false);
    const [now, setNow] = React.useState(() => Date.now());

    // Subagents that ran before this page opened are only on the server.
    React.useEffect(() => {
        let cancelled = false;
        setFetched([]);
        void opencodeClient
            .listSessionsPage({ directory, parentID: sessionId })
            .then((page) => {
                if (!cancelled) setFetched(page.sessions.filter((session) => session.parentID === sessionId));
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [sessionId, directory, open]);

    const children = React.useMemo(() => mergeChildren(live, fetched), [live, fetched]);
    const busyOf = React.useCallback((id: string) => {
        const status = statuses?.[id];
        return status?.type === 'busy' || status?.type === 'retry';
    }, [statuses]);
    const running = children.filter((child) => agentStatusOf(child, busyOf(child.id)) === 'running').length;

    React.useEffect(() => {
        if (!open || running === 0) return undefined;
        const id = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(id);
    }, [open, running]);

    if (children.length === 0) return null;

    const openChild = (child: Session) => {
        setOpen(false);
        if (!directory || isMobile) {
            setCurrentSession(child.id, directory ?? null);
            return;
        }
        const agentType = getClaudeSubagentState(child)?.agentType || 'subagent';
        openContextPanelTab(directory, {
            mode: 'chat',
            dedupeKey: `session:${child.id}`,
            label: agentType.charAt(0).toUpperCase() + agentType.slice(1),
            readOnly: true,
        });
    };

    const stopChild = (child: Session) => {
        void opencodeClient.abortSession(child.id, directory).catch(() => {
            toast.error(t('chat.agentMap.stopFailed'));
        });
    };

    const label = children.length === 1 ? t('chat.agentMap.one') : t('chat.agentMap.many', { count: children.length });

    return (
        <DropdownMenu open={open} onOpenChange={setOpen}>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    className={cn(
                        'typography-meta flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 py-0.5 text-muted-foreground hover:text-foreground',
                        className,
                    )}
                    data-claude-agent-map="true"
                    aria-label={label}
                >
                    <span
                        className={cn(
                            'inline-block size-1.5 rounded-full',
                            running > 0 ? 'bg-[var(--status-success)] animate-pulse' : 'bg-muted-foreground/60',
                        )}
                    />
                    <Icon name="robot-2" className="size-3.5 text-current" />
                    <span>{label}</span>
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="end" className="w-[min(360px,calc(100vw-2rem))] p-1">
                <DropdownMenuLabel className="typography-ui-header font-semibold text-foreground">
                    {t('chat.agentMap.title')}
                </DropdownMenuLabel>
                <div className="flex flex-col gap-0.5 max-h-[50vh] overflow-y-auto">
                    {children.map((child) => {
                        const state = getClaudeSubagentState(child);
                        const status = agentStatusOf(child, busyOf(child.id));
                        const startedAt = state?.startedAt ?? child.time?.created ?? null;
                        const endedAt = status === 'running' ? now : (state?.endedAt ?? child.time?.updated ?? null);
                        const elapsed = startedAt && endedAt ? formatElapsed(endedAt - startedAt) : null;
                        return (
                            <div key={child.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-interactive-hover/40" data-claude-agent-row={child.id}>
                                <span
                                    className={cn(
                                        'inline-block size-2 flex-shrink-0 rounded-full',
                                        status === 'running' && 'bg-[var(--status-success)] animate-pulse',
                                        status === 'completed' && 'bg-muted-foreground/60',
                                        status === 'failed' && 'bg-[var(--status-error)]',
                                        status === 'stopped' && 'bg-[var(--status-warning)]',
                                    )}
                                />
                                <button type="button" className="flex min-w-0 flex-1 flex-col text-left" onClick={() => openChild(child)} title={t('chat.agentMap.open')}>
                                    <span className="typography-meta font-medium text-foreground truncate">{child.title}</span>
                                    <span className="typography-micro text-muted-foreground truncate">
                                        {[state?.agentType, t(STATUS_LABELS[status]), elapsed].filter(Boolean).join(' · ')}
                                    </span>
                                </button>
                                {status === 'running' ? (
                                    <button
                                        type="button"
                                        className="flex-shrink-0 rounded p-1 text-muted-foreground hover:text-[var(--status-error)]"
                                        onClick={() => stopChild(child)}
                                        title={t('chat.agentMap.stop')}
                                        aria-label={t('chat.agentMap.stop')}
                                    >
                                        <Icon name="stop" className="size-3.5" />
                                    </button>
                                ) : null}
                            </div>
                        );
                    })}
                </div>
            </DropdownMenuContent>
        </DropdownMenu>
    );
};

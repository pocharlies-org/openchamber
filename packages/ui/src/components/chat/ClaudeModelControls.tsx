import React from 'react';

import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from '@/components/icon/Icon';
import { useIsVSCodeRuntime } from '@/hooks/useRuntimeAPIs';
import { getClaudeLiveState } from '@/lib/claudeSessionMetadata';
import {
    catalogEntryMatches,
    claudeModelLabel,
    fetchClaudeModelCatalog,
    findClaudeAnswerKey,
    selectClaudeModel,
    type ClaudeModelCatalog,
} from '@/lib/claudeModels';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { useDirectorySync, useSession } from '@/sync/sync-context';

/**
 * What the composer picked for a Claude session, per session id, for this page.
 * A model pick is shown until the next answer arrives: from then on the
 * answer's own model is the truth, whatever the pick resolved to.
 */
type ClaudePick = { modelId?: string; pickedAfterAnswer: string | null; effort?: string };
const picks = new Map<string, ClaudePick>();

/**
 * The model and thinking controls of the composer for a Claude Code session.
 *
 * OpenCode's controls list OpenCode's providers, which a Claude session cannot
 * run on (the server ignores them), and fall back to OpenCode's default model:
 * a session answering on Opus read as qwen38. These list Claude Code's own
 * picker and name the model the transcript last answered with.
 */
export const ClaudeModelControls: React.FC<{ sessionId: string; directory?: string; className?: string }> = ({
    sessionId,
    directory,
    className,
}) => {
    const { t } = useI18n();
    const { isMobile: deviceIsMobile } = useDeviceInfo();
    const uiIsMobile = useUIStore((state) => state.isMobile);
    const isMobile = deviceIsMobile || uiIsMobile;
    const isVSCodeRuntime = useIsVSCodeRuntime();
    const buttonHeight = isMobile ? 'h-9' : isVSCodeRuntime ? 'h-6' : 'h-8';
    const controlIconSize = isMobile ? 'size-5' : 'size-4';
    const controlTextSize = isMobile ? 'typography-micro' : 'typography-meta';

    const [catalog, setCatalog] = React.useState<ClaudeModelCatalog | null>(null);
    React.useEffect(() => {
        let cancelled = false;
        void fetchClaudeModelCatalog().then((result) => {
            if (!cancelled) setCatalog(result);
        });
        return () => {
            cancelled = true;
        };
    }, []);

    const answerKey = useDirectorySync(
        React.useCallback((state) => findClaudeAnswerKey(state.message[sessionId] ?? []), [sessionId]),
        directory,
    );
    const answeredModelId = answerKey ? answerKey.slice(answerKey.indexOf('\n') + 1) : null;
    // Another process owns the session: its effort was fixed when it started.
    const liveElsewhere = getClaudeLiveState(useSession(sessionId, directory)).liveElsewhere;

    const [pick, setPick] = React.useState<ClaudePick | undefined>(() => picks.get(sessionId));
    React.useEffect(() => setPick(picks.get(sessionId)), [sessionId]);

    const pickedModelId = pick?.modelId && pick.pickedAfterAnswer === answerKey ? pick.modelId : null;
    const shownModelId = pickedModelId ?? answeredModelId ?? catalog?.defaultModelId ?? null;
    const effort = pick?.effort ?? catalog?.defaultEffort ?? null;

    const commit = React.useCallback(async (next: ClaudePick) => {
        const ok = await selectClaudeModel(sessionId, { id: next.modelId ?? '', variant: next.effort });
        if (!ok) return;
        picks.set(sessionId, next);
        setPick(next);
    }, [sessionId]);

    const handleModelSelect = (modelId: string) => {
        void commit({ modelId, pickedAfterAnswer: answerKey, effort: pick?.effort });
    };
    const handleEffortSelect = (nextEffort: string) => {
        void commit({ modelId: pick?.modelId, pickedAfterAnswer: pick?.pickedAfterAnswer ?? answerKey, effort: nextEffort });
    };

    if (!catalog) return null;

    const modelLabel = shownModelId ? claudeModelLabel(shownModelId, catalog) : t('chat.modelControls.selectModel');
    const effortLabel = catalog.efforts.find((option) => option.id === effort)?.label ?? t('chat.modelControls.default');
    const triggerClass = cn(
        'flex items-center gap-1.5 cursor-pointer select-none hover:bg-transparent hover:opacity-70 min-w-0',
        buttonHeight,
    );

    return (
        <div className={cn('flex items-center justify-end min-w-0', isMobile ? 'gap-x-1' : 'gap-x-3', className)}>
            {!liveElsewhere ? (
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <div className={triggerClass}>
                            <Icon name="brain-ai-3" className={cn(controlIconSize, 'flex-shrink-0 text-muted-foreground')} />
                            <span className={cn(controlTextSize, 'font-medium truncate min-w-0 text-muted-foreground')}>
                                {effortLabel}
                            </span>
                        </div>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent side="top" align="end" className="w-[min(180px,calc(100vw-2rem))]">
                        <DropdownMenuLabel className="typography-ui-header font-semibold text-foreground">
                            {t('chat.modelControls.thinking')}
                        </DropdownMenuLabel>
                        {catalog.efforts.map((option) => (
                            <DropdownMenuItem key={option.id} className="typography-meta" onSelect={() => handleEffortSelect(option.id)}>
                                <div className="flex items-center justify-between gap-2 w-full min-w-0">
                                    <span className="typography-meta font-medium text-foreground truncate min-w-0">{option.label}</span>
                                    {option.id === effort && <Icon name="check" className="size-4 text-primary flex-shrink-0" />}
                                </div>
                            </DropdownMenuItem>
                        ))}
                    </DropdownMenuContent>
                </DropdownMenu>
            ) : null}
            <Tooltip delayDuration={600}>
                <DropdownMenu>
                    <TooltipTrigger asChild>
                        <DropdownMenuTrigger asChild>
                            <div className={triggerClass} data-claude-model={shownModelId ?? undefined}>
                                <Icon name="pencil-ai" className={cn(controlIconSize, 'flex-shrink-0 text-muted-foreground')} />
                                <span className={cn(controlTextSize, 'font-medium whitespace-nowrap truncate text-foreground min-w-0 max-w-[260px]')}>
                                    {modelLabel}
                                </span>
                            </div>
                        </DropdownMenuTrigger>
                    </TooltipTrigger>
                    <DropdownMenuContent side="top" align="end" className="w-[min(320px,calc(100vw-2rem))]">
                        <DropdownMenuLabel className="typography-ui-header font-semibold text-foreground">
                            {t('chat.modelControls.model')}
                        </DropdownMenuLabel>
                        {catalog.models.map((entry) => {
                            const current = shownModelId !== null && catalogEntryMatches(entry.id, shownModelId);
                            return (
                                <DropdownMenuItem key={entry.id} className="typography-meta" onSelect={() => handleModelSelect(entry.id)}>
                                    <div className="flex items-center justify-between gap-2 w-full min-w-0">
                                        <div className="flex flex-col min-w-0">
                                            <span className="typography-meta font-medium text-foreground truncate">{entry.label}</span>
                                            {entry.description ? (
                                                <span className="typography-micro text-muted-foreground truncate">{entry.description}</span>
                                            ) : null}
                                        </div>
                                        {current && <Icon name="check" className="size-4 text-primary flex-shrink-0" />}
                                    </div>
                                </DropdownMenuItem>
                            );
                        })}
                    </DropdownMenuContent>
                </DropdownMenu>
                <TooltipContent side="top">
                    <p className="typography-meta">{t('chat.modelControls.model')}: {shownModelId ?? modelLabel}</p>
                </TooltipContent>
            </Tooltip>
        </div>
    );
};

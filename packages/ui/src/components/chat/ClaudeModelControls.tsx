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
import type { IconName } from '@/components/icon/icons';
import { toast } from '@/components/ui';
import { useIsVSCodeRuntime } from '@/hooks/useRuntimeAPIs';
import { getClaudeEngineState, getClaudeLiveState } from '@/lib/claudeSessionMetadata';
import {
    catalogEntryMatches,
    claudeModelLabel,
    fetchClaudeModelCatalog,
    findClaudeAnswerKey,
    selectClaudeMode,
    selectClaudeModel,
    type ClaudeModeOption,
    type ClaudeModelCatalog,
} from '@/lib/claudeModels';
import { useDeviceInfo } from '@/lib/device';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { useDirectorySync, useSession } from '@/sync/sync-context';

/**
 * What the composer picked for a Claude session, per session id, for this page.
 * A model pick is shown until the next answer arrives: from then on the
 * answer's own model is the truth, whatever the pick resolved to.
 */
type ClaudePick = { modelId?: string; pickedAfterAnswer: string | null; effort?: string; mode?: string };
const picks = new Map<string, ClaudePick>();

/** Drop a stored mode pick (failed switch, or the engine moved on its own). */
const forgetPickedMode = (sessionId: string) => {
    const stored = picks.get(sessionId);
    if (!stored?.mode) return;
    picks.set(sessionId, { ...stored, mode: undefined });
};

/** The mode indicator's names and glyphs, as the VS Code extension shows them. */
const MODE_PRESENTATION: Record<string, { label: I18nKey; description: I18nKey; icon: IconName }> = {
    default: { label: 'chat.claudeMode.default', description: 'chat.claudeMode.default.description', icon: 'shield-check' },
    acceptEdits: { label: 'chat.claudeMode.acceptEdits', description: 'chat.claudeMode.acceptEdits.description', icon: 'edit-2' },
    plan: { label: 'chat.claudeMode.plan', description: 'chat.claudeMode.plan.description', icon: 'file-list-2' },
    auto: { label: 'chat.claudeMode.auto', description: 'chat.claudeMode.auto.description', icon: 'sparkling' },
    bypassPermissions: { label: 'chat.claudeMode.bypassPermissions', description: 'chat.claudeMode.bypassPermissions.description', icon: 'error-warning' },
};

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
    const session = useSession(sessionId, directory);
    const liveElsewhere = getClaudeLiveState(session).liveElsewhere;
    // The mode the engine reports for the session. A pick shows until the engine
    // moves on its own (`/plan`, an approved plan): the FIRST report of a session
    // is the mode it started on — often the one just picked at creation — so it
    // must not discard the pick, and neither must a re-render.
    const reportedMode = getClaudeEngineState(session).mode;
    const lastReportedMode = React.useRef({ session: sessionId, mode: reportedMode as string | null });
    const [pickedMode, setPickedMode] = React.useState<string | null>(() => picks.get(sessionId)?.mode ?? null);
    React.useEffect(() => setPickedMode(picks.get(sessionId)?.mode ?? null), [sessionId]);
    React.useEffect(() => {
        const previous = lastReportedMode.current;
        lastReportedMode.current = { session: sessionId, mode: reportedMode };
        if (previous.session !== sessionId) return;
        if (previous.mode === null || previous.mode === reportedMode) return;
        forgetPickedMode(sessionId);
    }, [sessionId, reportedMode]);

    const [pick, setPick] = React.useState<ClaudePick | undefined>(() => picks.get(sessionId));
    React.useEffect(() => setPick(picks.get(sessionId)), [sessionId]);

    const pickedModelId = pick?.modelId && pick.pickedAfterAnswer === answerKey ? pick.modelId : null;
    const shownModelId = pickedModelId ?? answeredModelId ?? catalog?.defaultModelId ?? null;
    const effort = pick?.effort ?? catalog?.defaultEffort ?? null;

    const commit = React.useCallback(async (next: ClaudePick) => {
        const ok = await selectClaudeModel(sessionId, { id: next.modelId ?? '', variant: next.effort });
        if (!ok) return;
        // Merged, not replaced: the stored pick also carries the mode.
        picks.set(sessionId, { ...picks.get(sessionId), ...next });
        setPick(picks.get(sessionId));
    }, [sessionId]);

    const handleModelSelect = (modelId: string) => {
        void commit({ modelId, pickedAfterAnswer: answerKey, effort: pick?.effort });
    };
    const handleEffortSelect = (nextEffort: string) => {
        void commit({ modelId: pick?.modelId, pickedAfterAnswer: pick?.pickedAfterAnswer ?? answerKey, effort: nextEffort });
    };

    const handleModeSelect = (mode: string) => {
        setPickedMode(mode);
        picks.set(sessionId, { ...picks.get(sessionId), pickedAfterAnswer: pick?.pickedAfterAnswer ?? null, mode });
        void selectClaudeMode(sessionId, mode).then((ok) => {
            if (ok) return;
            forgetPickedMode(sessionId);
            setPickedMode(null);
            toast.error(t('chat.claudeMode.changeFailed'));
        });
    };

    if (!catalog) return null;

    const modes: ClaudeModeOption[] = catalog.modes ?? [];
    const modeId = pickedMode ?? reportedMode ?? catalog.defaultMode ?? modes.find((mode) => mode.isDefault)?.id ?? 'default';
    const modeText = (mode: ClaudeModeOption | undefined, id: string) => {
        const presentation = MODE_PRESENTATION[id];
        return {
            label: presentation ? t(presentation.label) : (mode?.label ?? id),
            description: presentation ? t(presentation.description) : (mode?.description ?? ''),
            icon: presentation?.icon ?? ('shield-check' as IconName),
        };
    };
    const currentMode = modeText(modes.find((mode) => mode.id === modeId), modeId);

    const modelLabel = shownModelId ? claudeModelLabel(shownModelId, catalog) : t('chat.modelControls.selectModel');
    const effortLabel = catalog.efforts.find((option) => option.id === effort)?.label ?? t('chat.modelControls.default');
    const triggerClass = cn(
        'flex items-center gap-1.5 cursor-pointer select-none hover:bg-transparent hover:opacity-70 min-w-0',
        buttonHeight,
    );

    return (
        <div className={cn('flex items-center justify-end min-w-0', isMobile ? 'gap-x-1' : 'gap-x-3', className)}>
            {!liveElsewhere && modes.length > 0 ? (
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <div
                            className={cn(triggerClass, modeId === 'bypassPermissions' && 'text-[var(--status-error)]')}
                            data-claude-mode={modeId}
                            title={currentMode.description}
                        >
                            <Icon name={currentMode.icon} className={cn(controlIconSize, 'flex-shrink-0', modeId === 'bypassPermissions' ? 'text-current' : 'text-muted-foreground')} />
                            {!isMobile ? (
                                <span className={cn(controlTextSize, 'font-medium truncate min-w-0', modeId === 'bypassPermissions' ? 'text-current' : 'text-muted-foreground')}>
                                    {currentMode.label}
                                </span>
                            ) : null}
                        </div>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent side="top" align="end" className="w-[min(300px,calc(100vw-2rem))]">
                        <DropdownMenuLabel className="typography-ui-header font-semibold text-foreground">
                            {t('chat.claudeMode.title')}
                        </DropdownMenuLabel>
                        {modes.map((mode) => {
                            const text = modeText(mode, mode.id);
                            return (
                                <DropdownMenuItem key={mode.id} className="typography-meta" onSelect={() => handleModeSelect(mode.id)} data-claude-mode-option={mode.id}>
                                    <div className="flex items-center justify-between gap-2 w-full min-w-0">
                                        <div className="flex items-start gap-2 min-w-0">
                                            <Icon name={text.icon} className={cn('size-4 flex-shrink-0 mt-0.5', mode.dangerous ? 'text-[var(--status-error)]' : 'text-muted-foreground')} />
                                            <div className="flex flex-col min-w-0">
                                                <span className="typography-meta font-medium text-foreground truncate">{text.label}</span>
                                                {text.description ? (
                                                    <span className="typography-micro text-muted-foreground whitespace-normal">{text.description}</span>
                                                ) : null}
                                            </div>
                                        </div>
                                        {mode.id === modeId && <Icon name="check" className="size-4 text-primary flex-shrink-0" />}
                                    </div>
                                </DropdownMenuItem>
                            );
                        })}
                    </DropdownMenuContent>
                </DropdownMenu>
            ) : null}
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

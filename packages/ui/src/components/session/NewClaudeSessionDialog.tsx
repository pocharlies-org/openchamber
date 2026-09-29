import React from 'react';

import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { toast } from '@/components/ui';
import {
    fetchClaudeModelCatalog,
    type ClaudeModelCatalog,
    type ClaudeModeOption,
} from '@/lib/claudeModels';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn, formatPathForDisplay } from '@/lib/utils';
import type { Session } from '@/lib/opencode/model';
import { createClaudeSession } from '@/sync/session-actions';
import { updateDesktopSettings } from '@/lib/persistence';

/** The mode names and glyphs the composer's mode indicator already uses. */
const MODE_PRESENTATION: Record<string, { label: I18nKey; icon: IconName }> = {
    default: { label: 'chat.claudeMode.default', icon: 'shield-check' },
    acceptEdits: { label: 'chat.claudeMode.acceptEdits', icon: 'edit-2' },
    plan: { label: 'chat.claudeMode.plan', icon: 'file-list-2' },
    auto: { label: 'chat.claudeMode.auto', icon: 'sparkling' },
    bypassPermissions: { label: 'chat.claudeMode.bypassPermissions', icon: 'error-warning' },
};

type Option = { id: string; label: string };

const PickerRow: React.FC<{
    label: string;
    value: string;
    options: Option[];
    onChange: (value: string) => void;
}> = ({ label, value, options, onChange }) => {
    const current = options.find((option) => option.id === value);
    return (
        <div className="flex items-center justify-between gap-3">
            <span className="typography-meta font-medium text-foreground shrink-0">{label}</span>
            <Select value={value} onValueChange={onChange}>
                <SelectTrigger size="default" className="w-[min(240px,55vw)] shrink-0">
                    <SelectValue>{current?.label ?? value}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                    {options.map((option) => (
                        <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </div>
    );
};

/**
 * The `+` of a Claude project: picks what the session starts on — model,
 * thinking level, mode — while it still has no turns.
 *
 * The three open on this host's defaults (OpenChamber's Settings › Defaults,
 * then Claude Code's own settings) and travel with the create, so the CLI is
 * spawned on them at the first prompt. Each can still be changed later: the
 * composer carries the same three controls.
 */
export const NewClaudeSessionDialog: React.FC<{
    open: boolean;
    onOpenChange: (open: boolean) => void;
    directory: string;
    onCreated?: (session: Session | null) => void;
}> = ({ open, onOpenChange, directory, onCreated }) => {
    const { t } = useI18n();
    const [catalog, setCatalog] = React.useState<ClaudeModelCatalog | null>(null);
    const [modelId, setModelId] = React.useState('');
    const [effort, setEffort] = React.useState('');
    const [mode, setMode] = React.useState('');
    const [isCreating, setIsCreating] = React.useState(false);

    // Re-read on every open: the defaults may have changed in Settings since.
    React.useEffect(() => {
        if (!open) return;
        let cancelled = false;
        void fetchClaudeModelCatalog().then((result) => {
            if (cancelled || !result) return;
            setCatalog(result);
            setModelId(result.defaultModelId ?? result.models[0]?.id ?? '');
            setEffort(result.defaultEffort ?? result.efforts[0]?.id ?? '');
            setMode(result.defaultMode ?? result.modes?.find((entry) => entry.isDefault)?.id ?? 'default');
        });
        return () => {
            cancelled = true;
        };
    }, [open]);

    const modeOptions = React.useMemo<Option[]>(
        () => (catalog?.modes ?? []).map((entry: ClaudeModeOption) => ({
            id: entry.id,
            label: MODE_PRESENTATION[entry.id] ? t(MODE_PRESENTATION[entry.id].label) : entry.label,
        })),
        [catalog, t],
    );

    const handleCreate = React.useCallback(async () => {
        setIsCreating(true);
        const session = await createClaudeSession(directory, { model: modelId, effort, mode }).catch(() => null);
        setIsCreating(false);
        if (!session) {
            toast.error(t('dialog.claudeNew.failed'));
            return;
        }
        onCreated?.(session);
        onOpenChange(false);
    }, [directory, effort, modelId, mode, onCreated, onOpenChange, t]);

    /** Starts the session and stops asking: the next `+` goes straight in. */
    const handleCreateAndStopAsking = React.useCallback(async () => {
        await updateDesktopSettings({ claudeAskSessionDefaults: false }).catch(() => undefined);
        await handleCreate();
    }, [handleCreate]);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-[min(440px,calc(100vw-2rem))]">
                <DialogHeader>
                    <DialogTitle>{t('dialog.claudeNew.title')}</DialogTitle>
                    <DialogDescription>{t('dialog.claudeNew.description')}</DialogDescription>
                </DialogHeader>

                {directory ? (
                    <div className="flex items-center gap-1.5 min-w-0 typography-micro text-muted-foreground">
                        <Icon name="folder" className="size-3.5 shrink-0" />
                        <span className="truncate" title={directory}>{formatPathForDisplay(directory)}</span>
                    </div>
                ) : null}

                <div className={cn('space-y-3 py-2')}>
                    <PickerRow
                        label={t('chat.modelControls.model')}
                        value={modelId}
                        options={(catalog?.models ?? []).map((entry) => ({ id: entry.id, label: entry.label }))}
                        onChange={setModelId}
                    />
                    <PickerRow
                        label={t('chat.modelControls.thinking')}
                        value={effort}
                        options={(catalog?.efforts ?? []).map((entry) => ({ id: entry.id, label: entry.label }))}
                        onChange={setEffort}
                    />
                    {modeOptions.length > 0 ? (
                        <PickerRow
                            label={t('chat.claudeMode.title')}
                            value={mode}
                            options={modeOptions}
                            onChange={setMode}
                        />
                    ) : null}
                </div>

                <DialogFooter className="gap-2">
                    <Button
                        variant="ghost"
                        className="mr-auto text-muted-foreground"
                        onClick={() => { void handleCreateAndStopAsking(); }}
                        disabled={isCreating}
                    >
                        {t('dialog.claudeNew.dontAsk')}
                    </Button>
                    <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isCreating}>
                        {t('sessions.sidebar.dialogs.cancel')}
                    </Button>
                    <Button onClick={() => void handleCreate()} disabled={isCreating || !modelId}>
                        {isCreating ? t('dialog.claudeNew.creating') : t('dialog.claudeNew.create')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

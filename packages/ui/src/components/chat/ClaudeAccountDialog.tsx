import React from 'react';

import { Button } from '@/components/ui/button';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Input } from '@/components/ui/input';
import {
    cancelClaudeLogin,
    CLAUDE_LOGIN_POLL_MS,
    describeClaudeAccount,
    fetchClaudeAccount,
    fetchClaudeLogin,
    isClaudeLoginActive,
    signOutClaude,
    startClaudeLogin,
    submitClaudeLoginCode,
    type ClaudeAccount,
    type ClaudeLoginFlow,
    type ClaudeLoginMode,
    type ClaudeLoginStatus,
} from '@/lib/claudeAccount';
import { useI18n, type I18nKey } from '@/lib/i18n';

const MODE_OPTIONS: readonly { id: ClaudeLoginMode; labelKey: I18nKey }[] = [
    { id: 'claudeai', labelKey: 'dialog.claudeAccount.mode.subscription' },
    { id: 'console', labelKey: 'dialog.claudeAccount.mode.console' },
];

/** What the sign-in is doing right now, in the user's terms. */
const FLOW_STATUS_KEYS: Record<ClaudeLoginStatus, I18nKey> = {
    starting: 'dialog.claudeAccount.flow.starting',
    'waiting-code': 'dialog.claudeAccount.flow.waiting',
    exchanging: 'dialog.claudeAccount.flow.exchanging',
    'signed-in': 'dialog.claudeAccount.flow.signedIn',
    failed: 'dialog.claudeAccount.flow.failed',
    cancelled: 'dialog.claudeAccount.flow.cancelled',
    expired: 'dialog.claudeAccount.flow.expired',
};

interface ClaudeAccountDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

/**
 * The Claude Code account OpenChamber's Claude sessions run as, and the way to
 * change it. Claude Code owns the credential and performs the OAuth exchange:
 * this dialog shows the URL the CLI printed, hands back the code the sign-in
 * page gives, and reports what the CLI said — including "invalid code", which
 * costs a retry and not a new sign-in page.
 *
 * A session already running keeps the token it started with until its next turn
 * spawns a new process, which is what the footer says: switching account is not
 * a restart of whatever is answering.
 */
export const ClaudeAccountDialog: React.FC<ClaudeAccountDialogProps> = ({ open, onOpenChange }) => {
    const { t } = useI18n();
    const [account, setAccount] = React.useState<ClaudeAccount | null>(null);
    const [loggedIn, setLoggedIn] = React.useState(false);
    const [mode, setMode] = React.useState<ClaudeLoginMode>('claudeai');
    const [flow, setFlow] = React.useState<ClaudeLoginFlow | null>(null);
    const [code, setCode] = React.useState('');
    const [busy, setBusy] = React.useState(false);

    const pollRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
    const stopPolling = React.useCallback(() => {
        if (!pollRef.current) return;
        clearInterval(pollRef.current);
        pollRef.current = null;
    }, []);

    const refresh = React.useCallback(async () => {
        const result = await fetchClaudeAccount();
        if (!result.ok) return null;
        setLoggedIn(result.data.loggedIn);
        setAccount(result.data.account);
        return result.data.flow;
    }, []);

    /**
     * Follows a flow until it ends, and only then reports it: the CLI is the one
     * that knows whether the code worked, so the dialog never guesses from the
     * last line it saw.
     */
    const followFlow = React.useCallback((next: ClaudeLoginFlow | null) => {
        setFlow(next);
        setCode('');
        stopPolling();
        if (!next) return;
        if (!isClaudeLoginActive(next.status)) return;
        pollRef.current = setInterval(async () => {
            const result = await fetchClaudeLogin(next.id);
            if (!result.ok) {
                // The server no longer has it: the sign-in is over, whatever it says.
                stopPolling();
                setFlow((current) => (current ? { ...current, status: 'expired' } : current));
                return;
            }
            setFlow(result.data.flow);
            if (isClaudeLoginActive(result.data.flow.status)) return;
            stopPolling();
            if (result.data.flow.status === 'signed-in') {
                toast.success(t('dialog.claudeAccount.signedIn'));
                void refresh();
            }
        }, CLAUDE_LOGIN_POLL_MS);
    }, [refresh, stopPolling, t]);

    // Rejoining a sign-in must not depend on `followFlow`'s identity: the effect
    // that opens the dialog runs it, and a new function each render would start
    // the read again on every one of them.
    const followFlowRef = React.useRef(followFlow);
    followFlowRef.current = followFlow;

    React.useEffect(() => {
        if (!open) {
            stopPolling();
            return;
        }
        let cancelled = false;
        void refresh().then((running) => {
            if (!cancelled && running) followFlowRef.current(running);
        });
        return () => {
            cancelled = true;
            stopPolling();
        };
    }, [open, refresh, stopPolling]);

    const beginLogin = React.useCallback(async () => {
        setBusy(true);
        const result = await startClaudeLogin(mode);
        setBusy(false);
        if (!result.ok) {
            toast.error(result.error);
            return;
        }
        followFlow(result.data.flow);
    }, [followFlow, mode]);

    const sendCode = React.useCallback(async () => {
        if (!flow || !code.trim()) return;
        setBusy(true);
        const result = await submitClaudeLoginCode(flow.id, code.trim());
        setBusy(false);
        if (!result.ok) {
            // The CLI's own words: a wrong code says so and asks again.
            toast.error(result.error);
            const current = await fetchClaudeLogin(flow.id);
            if (current.ok) setFlow(current.data.flow);
            return;
        }
        setCode('');
        setFlow(result.data.flow);
        if (isClaudeLoginActive(result.data.flow.status)) followFlow(result.data.flow);
    }, [code, flow, followFlow]);

    const endLogin = React.useCallback(async () => {
        if (!flow) return;
        stopPolling();
        const result = await cancelClaudeLogin(flow.id);
        setFlow(result.ok ? result.data.flow : null);
    }, [flow, stopPolling]);

    const signOut = React.useCallback(async () => {
        setBusy(true);
        const result = await signOutClaude();
        setBusy(false);
        if (!result.ok) {
            toast.error(result.error);
            return;
        }
        setLoggedIn(result.data.loggedIn);
        setAccount(result.data.account);
        toast.success(t('dialog.claudeAccount.signedOut'));
    }, [t]);

    const accountName = describeClaudeAccount(account);
    const waiting = !!flow && isClaudeLoginActive(flow.status);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-[min(480px,calc(100vw-2rem))]">
                <DialogHeader>
                    <DialogTitle>{t('dialog.claudeAccount.title')}</DialogTitle>
                    <DialogDescription>{t('dialog.claudeAccount.description')}</DialogDescription>
                </DialogHeader>

                <div className="space-y-3 py-1" data-claude-account="state">
                    <div className="flex items-center gap-2 min-w-0">
                        <Icon
                            name={loggedIn ? 'shield-check' : 'error-warning'}
                            className="size-4 shrink-0 text-muted-foreground"
                        />
                        <span className="truncate typography-micro" title={accountName || undefined}>
                            {loggedIn
                                ? t('dialog.claudeAccount.signedInAs', { name: accountName || t('dialog.claudeAccount.unknownAccount') })
                                : t('dialog.claudeAccount.notSignedIn')}
                        </span>
                    </div>

                    {!flow ? (
                        <div className="flex flex-wrap items-center gap-2">
                            <Select value={mode} onValueChange={(value) => setMode(value as ClaudeLoginMode)}>
                                <SelectTrigger className="h-8 w-[190px] typography-micro" data-claude-account-mode>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {MODE_OPTIONS.map((option) => (
                                        <SelectItem key={option.id} value={option.id} className="typography-micro">
                                            {t(option.labelKey)}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            <Button size="sm" onClick={() => { void beginLogin(); }} disabled={busy} data-claude-account-login>
                                {loggedIn ? t('dialog.claudeAccount.switch') : t('dialog.claudeAccount.signIn')}
                            </Button>
                            {loggedIn ? (
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    className="text-muted-foreground"
                                    onClick={() => { void signOut(); }}
                                    disabled={busy}
                                    data-claude-account-signout
                                >
                                    {t('dialog.claudeAccount.signOut')}
                                </Button>
                            ) : null}
                        </div>
                    ) : (
                        <div className="space-y-2" data-claude-account="flow">
                            <p className="typography-micro text-muted-foreground" data-claude-account-flow-status={flow.status}>
                                {t(FLOW_STATUS_KEYS[flow.status])}
                            </p>

                            {flow.url ? (
                                <a
                                    href={flow.url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="block rounded-md border border-border bg-muted/40 px-2.5 py-2 typography-micro break-all hover:bg-muted"
                                    data-claude-account-url
                                >
                                    {t('dialog.claudeAccount.openSignIn')}
                                </a>
                            ) : null}

                            {waiting ? (
                                <div className="flex gap-2">
                                    <Input
                                        value={code}
                                        onChange={(event) => setCode(event.target.value)}
                                        onKeyDown={(event) => {
                                            if (event.key === 'Enter') {
                                                event.preventDefault();
                                                void sendCode();
                                            }
                                        }}
                                        placeholder={t('dialog.claudeAccount.codePlaceholder')}
                                        className="h-8 typography-micro"
                                        spellCheck={false}
                                        autoComplete="off"
                                        data-claude-account-code
                                    />
                                    <Button size="sm" onClick={() => { void sendCode(); }} disabled={busy || !code.trim()} data-claude-account-send>
                                        {t('dialog.claudeAccount.sendCode')}
                                    </Button>
                                </div>
                            ) : null}

                            {flow.error ? (
                                <p className="typography-micro text-destructive break-all" data-claude-account-error>
                                    {flow.error}
                                </p>
                            ) : null}

                            {flow.messages.length > 0 ? (
                                <ul className="space-y-0.5 typography-micro text-muted-foreground">
                                    {flow.messages.map((message, index) => (
                                        <li key={`${index}-${message}`} className="break-all">{message}</li>
                                    ))}
                                </ul>
                            ) : null}

                            {waiting ? (
                                <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => { void endLogin(); }}>
                                    {t('dialog.claudeAccount.cancel')}
                                </Button>
                            ) : (
                                <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => followFlow(null)}>
                                    {t('dialog.claudeAccount.back')}
                                </Button>
                            )}
                        </div>
                    )}
                </div>

                <DialogFooter className="gap-2">
                    <span className="mr-auto typography-micro text-muted-foreground">
                        {t('dialog.claudeAccount.runningSessions')}
                    </span>
                    <Button variant="ghost" onClick={() => onOpenChange(false)}>
                        {t('dialog.claudeAccount.close')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

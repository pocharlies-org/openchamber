import React, { act } from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';

// React detects input-event support when its DOM renderer is first imported.
// Give that probe a document, then restore the caller's globals immediately.
const rendererWindow = new Window();
const rendererGlobals = ['window', 'document'] as const;
const previousRendererGlobals = rendererGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
Object.defineProperty(globalThis, 'window', { value: rendererWindow, configurable: true, writable: true });
Object.defineProperty(globalThis, 'document', { value: rendererWindow.document, configurable: true, writable: true });
const { createRoot } = await import('react-dom/client');
for (const [name, descriptor] of previousRendererGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
}
rendererWindow.close();

import type { ClaudeAccount, ClaudeLoginFlow, ClaudeLoginMode, ClaudeLoginStatus } from '@/lib/claudeAccount';

const ACCOUNT: ClaudeAccount = {
    authMethod: 'claude.ai',
    email: 'me@example.com',
    orgName: null,
    subscriptionType: 'max',
    configDirectory: '/home/test/.claude',
};

const flowWith = (status: ClaudeLoginStatus, extra: Partial<ClaudeLoginFlow> = {}): ClaudeLoginFlow => ({
    id: 'clf_1',
    mode: 'claudeai',
    status,
    url: 'https://claude.com/cai/oauth/authorize?state=abc',
    messages: [],
    error: null,
    createdAt: 1,
    expiresAt: 2,
    account: null,
    ...extra,
});

/** The dialog's own view of the server: what a read answers and what the poll answers. */
let accountState: { loggedIn: boolean; account: ClaudeAccount | null; reason: string; flow: ClaudeLoginFlow | null } = {
    loggedIn: true,
    account: ACCOUNT,
    reason: 'logged-in',
    flow: null,
};
let pollFlow: ClaudeLoginFlow = flowWith('waiting-code');
const calls: string[] = [];
const toasts: { kind: 'success' | 'error'; message: string }[] = [];

const passthrough = ({ children }: React.PropsWithChildren) => <div>{children}</div>;

const actualDialog = await import('@/components/ui/dialog');
const actualI18n = await import('@/lib/i18n');

mock.module('@/components/ui/dialog', () => ({
    ...actualDialog,
    Dialog: ({ children, open }: React.PropsWithChildren<{ open: boolean }>) => (open ? <>{children}</> : null),
    DialogContent: passthrough,
    DialogHeader: passthrough,
    DialogTitle: passthrough,
    DialogDescription: passthrough,
    DialogFooter: passthrough,
}));

mock.module('@/components/ui/button', () => ({
    Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
}));

mock.module('@/components/ui/input', () => ({
    Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

mock.module('@/components/ui/select', () => ({
    Select: ({ value, onValueChange, children }: React.PropsWithChildren<{ value: string; onValueChange: (value: string) => void }>) => (
        <select value={value} onChange={(event) => onValueChange(event.target.value)}>{children}</select>
    ),
    SelectTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
    SelectValue: () => null,
    SelectContent: ({ children }: React.PropsWithChildren) => <>{children}</>,
    SelectItem: ({ children, value }: React.PropsWithChildren<{ value: string }>) => <option value={value}>{children}</option>,
}));

mock.module('@/components/ui', () => ({
    toast: {
        success: (message: string) => { toasts.push({ kind: 'success', message }); },
        error: (message: string) => { toasts.push({ kind: 'error', message }); },
    },
}));

mock.module('@/components/icon/Icon', () => ({ Icon: () => null }));

// The real provider memoizes `t`; the mock must too, or the dialog would see a
// new one every render.
const i18nValue = {
    t: (key: string, params?: Record<string, string | number>) => (params?.name !== undefined ? `${key}:${params.name}` : key),
};
mock.module('@/lib/i18n', () => ({ ...actualI18n, useI18n: () => i18nValue }));

// The poll interval is the module's, so the test sets it short instead of waiting.
mock.module('@/lib/claudeAccount', () => ({
    CLAUDE_LOGIN_POLL_MS: 5,
    isClaudeLoginActive: (status: ClaudeLoginStatus | undefined) => status === 'starting' || status === 'waiting-code' || status === 'exchanging',
    describeClaudeAccount: (account: ClaudeAccount | null) => (account?.email ? `${account.email} · ${account.subscriptionType ?? ''}` : null),
    fetchClaudeAccount: async () => {
        calls.push('read');
        return { ok: true, data: accountState };
    },
    startClaudeLogin: async (mode: ClaudeLoginMode) => {
        calls.push(`start:${mode}`);
        return { ok: true, data: { flow: flowWith('waiting-code') } };
    },
    fetchClaudeLogin: async () => {
        calls.push('poll');
        return { ok: true, data: { flow: pollFlow } };
    },
    submitClaudeLoginCode: async (_id: string, code: string) => {
        calls.push(`code:${code}`);
        // The server keeps what the CLI said in the flow itself, so the poll that
        // follows reports the same messages.
        pollFlow = flowWith('waiting-code', { messages: [`Invalid code for ${code}.`] });
        return { ok: true, data: { flow: pollFlow } };
    },
    cancelClaudeLogin: async () => {
        calls.push('cancel');
        return { ok: true, data: { flow: flowWith('cancelled') } };
    },
    signOutClaude: async () => {
        calls.push('logout');
        return { ok: true, data: { loggedIn: false, account: null } };
    },
}));

const { ClaudeAccountDialog } = await import('./ClaudeAccountDialog');

const DOM_GLOBAL_NAMES = [
    'window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'HTMLInputElement',
    'KeyboardEvent', 'Event', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT',
] as const;

const installDom = () => {
    const happyWindow = new Window({ url: 'http://localhost' });
    const previous = DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
    const values: Record<string, unknown> = {
        window: happyWindow,
        document: happyWindow.document,
        navigator: happyWindow.navigator,
        Node: happyWindow.Node,
        Element: happyWindow.Element,
        HTMLElement: happyWindow.HTMLElement,
        HTMLInputElement: happyWindow.HTMLInputElement,
        KeyboardEvent: happyWindow.KeyboardEvent,
        Event: happyWindow.Event,
        localStorage: happyWindow.localStorage,
        requestAnimationFrame: happyWindow.requestAnimationFrame.bind(happyWindow),
        cancelAnimationFrame: happyWindow.cancelAnimationFrame.bind(happyWindow),
        IS_REACT_ACT_ENVIRONMENT: true,
    };
    for (const name of DOM_GLOBAL_NAMES) {
        Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    return {
        container,
        restore: () => {
            happyWindow.close();
            for (const [name, descriptor] of previous) {
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else Reflect.deleteProperty(globalThis, name);
            }
        },
    };
};

const buttonByText = (container: HTMLElement, text: string) => {
    const found = [...container.querySelectorAll('button')].find((button) => button.textContent === text);
    if (!found) throw new Error(`Missing button: ${text}`);
    return found;
};

const wait = async (ms = 25) => {
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, ms); }); });
};

const reset = () => {
    accountState = { loggedIn: true, account: ACCOUNT, reason: 'logged-in', flow: null };
    pollFlow = flowWith('waiting-code');
    calls.length = 0;
    toasts.length = 0;
};

describe('ClaudeAccountDialog behavior', () => {
    test('names the account Claude Code is signed in as and offers to switch it', async () => {
        const dom = installDom();
        reset();
        const root = createRoot(dom.container);
        try {
            await act(async () => { root.render(<ClaudeAccountDialog open onOpenChange={() => undefined} />); });
            await wait();

            expect(calls).toContain('read');
            expect(dom.container.textContent).toContain('dialog.claudeAccount.signedInAs');
            expect(dom.container.textContent).toContain('me@example.com');
            expect(dom.container.querySelector('[data-claude-account-signout]')).not.toBeNull();

            await act(async () => { buttonByText(dom.container, 'dialog.claudeAccount.switch').click(); });
            await wait();

            expect(calls).toContain('start:claudeai');
            const link = dom.container.querySelector('a[data-claude-account-url]');
            expect(link?.getAttribute('href')).toBe('https://claude.com/cai/oauth/authorize?state=abc');
            expect(link?.getAttribute('target')).toBe('_blank');
            expect(dom.container.querySelector('input[data-claude-account-code]')).not.toBeNull();
        } finally {
            await act(async () => { root.unmount(); });
            dom.restore();
        }
    });

    test('sends the pasted code and shows what the CLI answered', async () => {
        const dom = installDom();
        reset();
        accountState = { loggedIn: true, account: ACCOUNT, reason: 'logged-in', flow: flowWith('waiting-code') };
        const root = createRoot(dom.container);
        try {
            await act(async () => { root.render(<ClaudeAccountDialog open onOpenChange={() => undefined} />); });
            await wait();

            const input = dom.container.querySelector<HTMLInputElement>('input[data-claude-account-code]');
            if (!input) throw new Error('Missing code input');
            const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            await act(async () => {
                setValue?.call(input, '  the-code  ');
                input.dispatchEvent(new Event('input', { bubbles: true }));
            });
            await act(async () => { buttonByText(dom.container, 'dialog.claudeAccount.sendCode').click(); });
            await wait();

            expect(calls).toContain('code:the-code');
            expect(dom.container.textContent).toContain('Invalid code for the-code.');
        } finally {
            await act(async () => { root.unmount(); });
            dom.restore();
        }
    });

    test('reports a sign-in that ends signed-in by re-reading the account', async () => {
        const dom = installDom();
        reset();
        pollFlow = flowWith('signed-in', { account: ACCOUNT });
        const root = createRoot(dom.container);
        try {
            accountState = { loggedIn: true, account: ACCOUNT, reason: 'logged-in', flow: flowWith('waiting-code') };
            await act(async () => { root.render(<ClaudeAccountDialog open onOpenChange={() => undefined} />); });
            await wait(80);

            expect(calls.filter((entry) => entry === 'poll').length).toBeGreaterThan(0);
            expect(calls.filter((entry) => entry === 'read').length).toBeGreaterThan(1);
            expect(toasts.some((entry) => entry.kind === 'success' && entry.message === 'dialog.claudeAccount.signedIn'))
                .toBe(true);
            expect(dom.container.querySelector('[data-claude-account-flow-status]')?.getAttribute('data-claude-account-flow-status'))
                .toBe('signed-in');
        } finally {
            await act(async () => { root.unmount(); });
            dom.restore();
        }
    });

    test('signing out leaves no account to name', async () => {
        const dom = installDom();
        reset();
        const root = createRoot(dom.container);
        try {
            await act(async () => { root.render(<ClaudeAccountDialog open onOpenChange={() => undefined} />); });
            await wait();

            await act(async () => { buttonByText(dom.container, 'dialog.claudeAccount.signOut').click(); });
            await wait();

            expect(calls).toContain('logout');
            expect(dom.container.textContent).toContain('dialog.claudeAccount.notSignedIn');
            expect(dom.container.querySelector('[data-claude-account-signout]')).toBeNull();
        } finally {
            await act(async () => { root.unmount(); });
            dom.restore();
        }
    });
});

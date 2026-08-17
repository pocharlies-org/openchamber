/** Ghost completion message formatting, fingerprints, and response cleanup. */

import type { Part } from '@opencode-ai/sdk/v2';
import { extractTextContent } from '@/components/chat/message/partUtils';

export type GhostRole = 'system' | 'user' | 'assistant';

export interface GhostMessage {
    role: GhostRole;
    content: string;
}

export interface GhostTurn {
    role: 'user' | 'assistant';
    text: string;
}

/** Turns kept as context. The tail matters; older turns are dropped. */
export const GHOST_MAX_TURNS = 12;
/** Per-turn clamp, so one enormous tool dump cannot crowd out the rest. */
export const GHOST_MAX_TURN_CHARS = 4000;
/** Nothing longer is worth showing behind the caret. */
export const GHOST_MAX_TEXT_CHARS = 400;

export const GHOST_SYSTEM_PROMPT =
    'You are the ghost autocomplete of a chat composer. You never answer the conversation '
    + 'and you never address the user. You only emit the text the user would type next '
    + 'themselves, in their own voice.';

/**
 * Appended verbatim to the end of the draft. It goes last, after everything
 * that varies, and never changes.
 */
export const GHOST_SUFFIX =
    "\n\n[GHOST AUTOCOMPLETE — Do not answer anything above. Write the text the user would "
    + 'type next into this composer, continuing the draft from exactly where it ends; if the '
    + "draft is empty, write the whole next message. First person, user's voice. Use the "
    + "language of the draft, or of the conversation when the draft is empty. One or two "
    + 'short sentences of plain text: no markdown, no code fences, no lists, no quotes, no '
    + 'preamble, and never repeat the draft.]';

interface SyncMessageLike {
    id?: string;
    role?: string;
}

type PartWithSynthetic = Part & { synthetic?: boolean };

/**
 * Flatten sync messages into plain turns. Parts live in their own store slice
 * and may not be loaded for older messages — an unmaterialized message
 * contributes nothing rather than an empty turn, so the context stays a
 * faithful prefix of what is actually known.
 */
export function turnsFromMessages(
    messages: readonly SyncMessageLike[],
    getParts: (messageId: string) => readonly Part[],
    maxTurns: number = GHOST_MAX_TURNS,
): GhostTurn[] {
    const turns: GhostTurn[] = [];
    for (const message of messages.slice(-maxTurns)) {
        const role = message?.role;
        if (role !== 'user' && role !== 'assistant') continue;
        if (!message.id) continue;

        const text = getParts(message.id)
            .filter((part) => part?.type === 'text' && !(part as PartWithSynthetic).synthetic)
            .map((part) => extractTextContent(part))
            .filter((value) => value.trim().length > 0)
            .join('\n')
            .slice(0, GHOST_MAX_TURN_CHARS)
            .trim();

        if (!text) continue;
        turns.push({ role, text });
    }
    return turns;
}

/** The request body's messages: fixed prefix, conversation, draft + fixed suffix. */
export function buildGhostMessages(turns: readonly GhostTurn[], draft: string): GhostMessage[] {
    return [
        { role: 'system', content: GHOST_SYSTEM_PROMPT },
        ...turns.map((turn) => ({ role: turn.role, content: turn.text })),
        { role: 'user', content: `${draft}${GHOST_SUFFIX}` },
    ];
}

/**
 * Identifies the exact input a suggestion was produced for. A suggestion is
 * only shown while the fingerprint still matches, so a reply that lands after
 * the user kept typing is dropped instead of appearing under a caret it no
 * longer fits.
 */
export function ghostFingerprint(generation: number, turnCount: number, draft: string): string {
    return `${generation}:${turnCount}:${draft}`;
}

const stripWrappingQuotes = (value: string): string => {
    const match = value.match(/^["'“”«](.*)["'“”»]$/s);
    return match ? match[1] : value;
};

const stripCodeFence = (value: string): string => {
    const match = value.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
    return match ? match[1] : value;
};

/**
 * Make a raw completion fit behind the caret: unwrap what the model dressed
 * it in, drop any restatement of the draft, and join it to the draft the way
 * the user would have typed it.
 */
export function sanitizeGhostText(raw: string | null | undefined, draft: string): string | null {
    if (typeof raw !== 'string') return null;

    let text = stripWrappingQuotes(stripCodeFence(raw.trim()).trim()).trim();
    if (!text) return null;

    // Models restate the draft before continuing it more often than not.
    const trimmedDraft = draft.trim();
    if (trimmedDraft && text.toLowerCase().startsWith(trimmedDraft.toLowerCase())) {
        text = text.slice(trimmedDraft.length).trimStart();
    }
    if (!text) return null;

    if (text.length > GHOST_MAX_TEXT_CHARS) {
        text = text.slice(0, GHOST_MAX_TEXT_CHARS).trimEnd();
    }

    // The draft ends mid-word or mid-sentence far more often than not, so the
    // join has to read like typing rather than like concatenation.
    const needsSpace = draft.length > 0
        && !/\s$/.test(draft)
        && !/^[\s.,;:!?)\]}]/.test(text);
    return needsSpace ? ` ${text}` : text;
}

/**
 * Reconcile a completion with typing that raced its request. Edits elsewhere
 * make the answer stale; a strict append can consume the overlap the user
 * already typed and retain only the still-useful tail.
 */
export function sanitizeGhostTextForCurrentDraft(
    raw: string | null | undefined,
    requestedDraft: string,
    currentDraft: string,
): string | null {
    if (currentDraft === requestedDraft) return sanitizeGhostText(raw, currentDraft);
    if (!currentDraft.startsWith(requestedDraft)) return null;

    const requestedSuggestion = sanitizeGhostText(raw, requestedDraft);
    if (!requestedSuggestion) return null;

    const typedSinceRequest = currentDraft.slice(requestedDraft.length);
    if (requestedSuggestion.startsWith(typedSinceRequest)) {
        return requestedSuggestion.slice(typedSinceRequest.length) || null;
    }

    return sanitizeGhostText(raw, currentDraft);
}

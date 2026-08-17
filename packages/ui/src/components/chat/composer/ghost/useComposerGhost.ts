/**
 * Drives the composer's ghost suggestion.
 *
 * The suggestion is asked for after typing settles and the moment a turn
 * finishes. Typing requests have a cost floor so bursts cannot turn a slow
 * completion into a queue of paid work.
 *
 * Nothing is requested unless the window is actually in front of the user, so
 * a workspace left open overnight costs nothing.
 */

import React from 'react';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getSyncMessages, getSyncParts } from '@/sync/sync-refs';
import {
    buildGhostMessages,
    ghostFingerprint,
    sanitizeGhostTextForCurrentDraft,
    turnsFromMessages,
} from './ghostCompletion';
import { createGhostRequestGate, ghostTypingDebounceMs } from './ghostRequestTiming';

export interface UseComposerGhostOptions {
    sessionId: string | null;
    directory?: string;
    draft: string;
    /** Session activity; a busy → idle edge means a turn just finished. */
    phase: 'idle' | 'busy' | 'retry';
    enabled?: boolean;
}

export interface ComposerGhost {
    /** Text to paint behind the caret, already joined to the draft. */
    suggestion: string | null;
    /** Consume the suggestion. Returns the text to insert, or null. */
    accept: () => string | null;
    clear: () => void;
}

const isWindowInFront = (): boolean =>
    typeof document !== 'undefined'
    && document.visibilityState === 'visible'
    && document.hasFocus();

export function useComposerGhost({
    sessionId,
    directory,
    draft,
    phase,
    enabled = true,
}: UseComposerGhostOptions): ComposerGhost {
    const [suggestion, setSuggestion] = React.useState<string | null>(null);

    const suggestionRef = React.useRef<string | null>(null);
    const fingerprintRef = React.useRef<string | null>(null);
    const inFlightRef = React.useRef<AbortController | null>(null);
    const draftRef = React.useRef(draft);
    const requestGateRef = React.useRef<ReturnType<typeof createGhostRequestGate> | null>(null);
    if (!requestGateRef.current) requestGateRef.current = createGhostRequestGate();

    const clear = React.useCallback(() => {
        suggestionRef.current = null;
        fingerprintRef.current = null;
        setSuggestion(null);
    }, []);

    // An edit invalidates a suggestion produced for the text before it.
    React.useEffect(() => {
        draftRef.current = draft;
        inFlightRef.current?.abort();
        inFlightRef.current = null;
        if (suggestionRef.current !== null) clear();
    }, [draft, clear]);

    React.useEffect(() => {
        inFlightRef.current?.abort();
        inFlightRef.current = null;
        requestGateRef.current = createGhostRequestGate();
        clear();
    }, [sessionId, directory, clear]);

    React.useEffect(() => () => inFlightRef.current?.abort(), []);

    const request = React.useCallback(async (requestedDraft?: string) => {
        if (!enabled || !sessionId) return;
        if (!isWindowInFront()) return;
        if (inFlightRef.current) return;
        const requestGate = requestGateRef.current!;
        if (requestGate.delay(Date.now(), 0) > 0) return;

        const currentDraft = requestedDraft ?? draftRef.current;
        const turns = turnsFromMessages(
            getSyncMessages(sessionId, directory),
            (messageId) => getSyncParts(messageId, directory),
        );
        // With neither history nor a draft there is nothing to predict from.
        if (turns.length === 0 && !currentDraft.trim()) return;

        const fingerprint = ghostFingerprint(turns, currentDraft);
        // Same input as the suggestion already on screen: asking again would
        // buy the same answer.
        if (suggestionRef.current !== null && fingerprintRef.current === fingerprint) return;

        const controller = new AbortController();
        inFlightRef.current = controller;
        requestGate.markStarted(Date.now());
        try {
            const response = await runtimeFetch('/api/composer/ghost', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    directory,
                    messages: buildGhostMessages(turns, currentDraft),
                    // Stable for the whole session so repeated polls present
                    // the endpoint with the same cache identity.
                    promptCacheKey: `openchamber-ghost:${directory ?? ''}:${sessionId}`,
                }),
                signal: controller.signal,
            });
            if (!response.ok) return;

            const payload = await response.json() as { text?: string | null };
            if (controller.signal.aborted || inFlightRef.current !== controller) return;
            const latestDraft = draftRef.current;
            const text = sanitizeGhostTextForCurrentDraft(payload?.text, currentDraft, latestDraft);
            if (!text) return;

            suggestionRef.current = text;
            fingerprintRef.current = ghostFingerprint(turns, latestDraft);
            setSuggestion(text);
        } catch {
            // Aborted, offline, rate-limited: a ghost that cannot be produced
            // is simply not shown. Never surfaced to the user.
        } finally {
            if (inFlightRef.current === controller) inFlightRef.current = null;
        }
    }, [directory, enabled, sessionId]);

    React.useEffect(() => {
        if (!enabled || !sessionId || !draft.trim()) return;
        let timer: ReturnType<typeof setTimeout>;
        const attempt = () => {
            const delay = requestGateRef.current!.delay(Date.now(), 0);
            if (delay > 0) {
                timer = setTimeout(attempt, delay);
                return;
            }
            void request();
        };
        timer = setTimeout(attempt, ghostTypingDebounceMs());
        return () => clearTimeout(timer);
    }, [draft, enabled, request, sessionId]);

    // A turn settling is the moment the next prompt is worth guessing.
    const previousPhaseRef = React.useRef(phase);
    React.useEffect(() => {
        const previous = previousPhaseRef.current;
        previousPhaseRef.current = phase;
        if (previous === 'idle' || phase !== 'idle') return;
        const settledDraft = draftRef.current;
        let timer: ReturnType<typeof setTimeout>;
        const attempt = () => {
            const delay = requestGateRef.current!.delay(Date.now(), 0);
            if (delay > 0) {
                timer = setTimeout(attempt, delay);
                return;
            }
            void request(settledDraft);
        };
        attempt();
        return () => clearTimeout(timer);
    }, [phase, request]);

    const accept = React.useCallback(() => {
        const text = suggestionRef.current;
        if (!text) return null;
        clear();
        return text;
    }, [clear]);

    return { suggestion, accept, clear };
}

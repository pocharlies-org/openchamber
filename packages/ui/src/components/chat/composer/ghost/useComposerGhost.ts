/**
 * Drives the composer's ghost suggestion.
 *
 * The suggestion is asked for after 15 seconds of focused inactivity with an
 * empty composer, and the moment a turn finishes. Identical inputs are asked
 * only once, including misses.
 *
 * Nothing is requested unless the window is actually in front of the user, so
 * a workspace left open overnight costs nothing.
 */

import React from 'react';
import { runtimeFetch } from '@/lib/runtime-fetch';
import {
    ghostFingerprint,
    sanitizeGhostTextForCurrentDraft,
} from './ghostCompletion';
import {
    createGhostRequestGate,
    ghostIdlePollMs,
    isAuthoritativeGhostSettle,
    shouldRunGhostIdle,
    shouldScheduleGhostIdle,
} from './ghostRequestTiming';

export interface UseComposerGhostOptions {
    sessionId: string | null;
    directory?: string;
    draft: string;
    /** Session activity; a busy → idle edge means a turn just finished. */
    phase: 'idle' | 'busy' | 'retry';
    authoritativePhase: 'idle' | 'busy' | 'retry' | null;
    hasAuthoritativeStatus: boolean;
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
    authoritativePhase,
    hasAuthoritativeStatus,
    enabled = true,
}: UseComposerGhostOptions): ComposerGhost {
    const [suggestion, setSuggestion] = React.useState<string | null>(null);

    const suggestionRef = React.useRef<string | null>(null);
    const serverRevisionRef = React.useRef({ generation: 0, turnCount: 0 });
    const requestedFingerprintRef = React.useRef<string | null>(null);
    const inFlightRef = React.useRef<AbortController | null>(null);
    const draftRef = React.useRef(draft);
    const requestGateRef = React.useRef<ReturnType<typeof createGhostRequestGate> | null>(null);
    if (!requestGateRef.current) requestGateRef.current = createGhostRequestGate();

    const clear = React.useCallback(() => {
        suggestionRef.current = null;
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
        requestedFingerprintRef.current = null;
        serverRevisionRef.current = { generation: 0, turnCount: 0 };
        clear();
    }, [sessionId, directory, clear]);

    React.useEffect(() => () => inFlightRef.current?.abort(), []);

    const request = React.useCallback(async (requestedDraft?: string, reconcileHistory = false) => {
        if (!enabled || !sessionId) return;
        if (!isWindowInFront()) return;
        if (inFlightRef.current) return;
        const requestGate = requestGateRef.current!;
        if (requestGate.delay(Date.now(), 0) > 0) return;

        const currentDraft = requestedDraft ?? draftRef.current;
        const serverRevision = serverRevisionRef.current;
        const fingerprint = ghostFingerprint(serverRevision.generation, serverRevision.turnCount, currentDraft);
        if (!reconcileHistory && serverRevision.generation > 0 && requestedFingerprintRef.current === fingerprint) return;

        const controller = new AbortController();
        inFlightRef.current = controller;
        requestedFingerprintRef.current = fingerprint;
        requestGate.markStarted(Date.now());
        try {
            const response = await runtimeFetch('/api/composer/ghost', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sessionId,
                    directory,
                    draft: currentDraft,
                }),
                signal: controller.signal,
            });
            if (!response.ok) return;

            const payload = await response.json() as {
                text?: string | null;
                generation?: number;
                turnCount?: number;
                prefixHash?: string;
            };
            if (controller.signal.aborted || inFlightRef.current !== controller) return;
            if (!isWindowInFront()) return;
            if (Number.isFinite(payload.generation) && Number.isFinite(payload.turnCount)) {
                const nextRevision = { generation: payload.generation!, turnCount: payload.turnCount! };
                serverRevisionRef.current = nextRevision;
                requestedFingerprintRef.current = ghostFingerprint(
                    nextRevision.generation,
                    nextRevision.turnCount,
                    currentDraft,
                );
            }
            if (payload.prefixHash) console.debug('[composer-ghost] prefix', payload.prefixHash);
            const latestDraft = draftRef.current;
            const text = sanitizeGhostTextForCurrentDraft(payload.text, currentDraft, latestDraft);
            if (!text) return;

            suggestionRef.current = text;
            setSuggestion(text);
        } catch {
            // Ghost suggestions fail silently.
        } finally {
            if (inFlightRef.current === controller) inFlightRef.current = null;
        }
    }, [directory, enabled, sessionId]);

    React.useEffect(() => {
        if (!shouldScheduleGhostIdle({ enabled, sessionId, draft })) return;
        let timer: ReturnType<typeof setInterval> | undefined;
        const stop = () => {
            if (timer) clearInterval(timer);
            timer = undefined;
            inFlightRef.current?.abort();
            inFlightRef.current = null;
            clear();
        };
        const start = () => {
            stop();
            if (!isWindowInFront() || !shouldRunGhostIdle(authoritativePhase ?? phase, hasAuthoritativeStatus, false)) return;
            timer = setInterval(() => {
                if (!shouldRunGhostIdle(authoritativePhase ?? phase, hasAuthoritativeStatus, serverRevisionRef.current.generation > 0)) return;
                void request('');
            }, ghostIdlePollMs());
        };
        const handleActivity = () => start();
        window.addEventListener('focus', handleActivity);
        window.addEventListener('blur', stop);
        document.addEventListener('visibilitychange', handleActivity);
        start();
        return () => {
            stop();
            window.removeEventListener('focus', handleActivity);
            window.removeEventListener('blur', stop);
            document.removeEventListener('visibilitychange', handleActivity);
        };
    }, [authoritativePhase, clear, draft, enabled, hasAuthoritativeStatus, phase, request, sessionId]);

    // A turn settling is the moment the next prompt is worth guessing.
    const effectivePhase = authoritativePhase ?? phase;
    const previousPhaseRef = React.useRef(effectivePhase);
    const observedAuthoritativeActiveRef = React.useRef(
        hasAuthoritativeStatus && effectivePhase !== 'idle',
    );
    const settleSessionRef = React.useRef(sessionId);
    React.useEffect(() => {
        if (settleSessionRef.current !== sessionId) {
            settleSessionRef.current = sessionId;
            previousPhaseRef.current = effectivePhase;
            observedAuthoritativeActiveRef.current = hasAuthoritativeStatus && effectivePhase !== 'idle';
            return;
        }
        const previous = previousPhaseRef.current;
        const previousWasAuthoritative = observedAuthoritativeActiveRef.current;
        previousPhaseRef.current = effectivePhase;
        observedAuthoritativeActiveRef.current = hasAuthoritativeStatus && effectivePhase !== 'idle';
        if (!isAuthoritativeGhostSettle(previous, previousWasAuthoritative, effectivePhase)) return;
        const settledDraft = draftRef.current;
        let remainingReconciliations = 1;
        let timer: ReturnType<typeof setTimeout>;
        const attempt = () => {
            const delay = requestGateRef.current!.delay(Date.now(), 0);
            if (delay > 0) {
                timer = setTimeout(attempt, delay);
                return;
            }
            void request(settledDraft, true);
            if (remainingReconciliations > 0) {
                remainingReconciliations -= 1;
                timer = setTimeout(attempt, ghostIdlePollMs() + 1);
            }
        };
        attempt();
        return () => clearTimeout(timer);
    }, [effectivePhase, hasAuthoritativeStatus, request, sessionId]);

    const accept = React.useCallback(() => {
        const text = suggestionRef.current;
        if (!text) return null;
        clear();
        return text;
    }, [clear]);

    return { suggestion, accept, clear };
}

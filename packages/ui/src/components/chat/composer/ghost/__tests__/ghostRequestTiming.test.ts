import { describe, expect, test } from 'bun:test';

import {
    createGhostRequestGate,
    ghostIdlePollMs,
    ghostRequestDelay,
    isAuthoritativeGhostSettle,
    shouldRunGhostIdle,
    shouldScheduleGhostIdle,
} from '../ghostRequestTiming';

const IDLE_POLL_MS = ghostIdlePollMs();
const MIN_INTERVAL_MS = 30_000;

describe('ghostRequestDelay', () => {
    test('waits for the idle interval before the first poll', () => {
        expect(ghostRequestDelay(10_000, null, IDLE_POLL_MS)).toBe(IDLE_POLL_MS);
    });

    test('holds a burst behind the minimum request interval', () => {
        expect(ghostRequestDelay(12_000, 10_000, IDLE_POLL_MS)).toBe(
            MIN_INTERVAL_MS - 2_000,
        );
    });

    test('still applies the poll interval when the request floor has elapsed', () => {
        expect(ghostRequestDelay(40_000, 10_000, IDLE_POLL_MS)).toBe(IDLE_POLL_MS);
    });

    test('uses the later boundary when the floor expires during the poll interval', () => {
        expect(ghostRequestDelay(38_750, 10_000, IDLE_POLL_MS)).toBe(IDLE_POLL_MS);
    });

    test('applies the cost floor without debounce to a turn-settled request', () => {
        expect(ghostRequestDelay(12_000, 10_000, 0)).toBe(
            MIN_INTERVAL_MS - 2_000,
        );
        expect(ghostRequestDelay(40_000, 10_000, 0)).toBe(0);
    });
});

describe('createGhostRequestGate', () => {
    test('shares one request floor across independent trigger paths', () => {
        const gate = createGhostRequestGate();

        expect(gate.delay(10_000, IDLE_POLL_MS)).toBe(IDLE_POLL_MS);
        gate.markStarted(11_500);
        expect(gate.delay(12_000, 0)).toBe(29_500);
        expect(gate.delay(12_000, IDLE_POLL_MS)).toBe(29_500);
    });
});

describe('shouldScheduleGhostIdle', () => {
    test('arms for an empty enabled session independently of session activity', () => {
        expect(shouldScheduleGhostIdle({ enabled: true, sessionId: 'ses_1', draft: '' })).toBe(true);
    });

    test('does not arm without a session, while disabled, or with a non-empty draft', () => {
        expect(shouldScheduleGhostIdle({ enabled: true, sessionId: null, draft: '' })).toBe(false);
        expect(shouldScheduleGhostIdle({ enabled: false, sessionId: 'ses_1', draft: '' })).toBe(false);
        expect(shouldScheduleGhostIdle({ enabled: true, sessionId: 'ses_1', draft: 'next' })).toBe(false);
    });

    test('allows unknown startup activity but stops an active phase after server reconciliation', () => {
        expect(shouldRunGhostIdle('busy', false, false)).toBe(true);
        expect(shouldRunGhostIdle('retry', false, false)).toBe(true);
        expect(shouldRunGhostIdle('busy', true, false)).toBe(false);
        expect(shouldRunGhostIdle('retry', true, false)).toBe(false);
        expect(shouldRunGhostIdle('busy', false, true)).toBe(false);
        expect(shouldRunGhostIdle('idle', true, true)).toBe(true);
    });

    test('treats only authoritative active-to-idle transitions as settled turns', () => {
        expect(isAuthoritativeGhostSettle('busy', true, 'idle')).toBe(true);
        expect(isAuthoritativeGhostSettle('retry', true, 'idle')).toBe(true);
        expect(isAuthoritativeGhostSettle('busy', false, 'idle')).toBe(false);
        expect(isAuthoritativeGhostSettle('idle', true, 'idle')).toBe(false);
    });
});

import { describe, expect, test } from 'bun:test';

import { createGhostRequestGate, ghostIdlePollMs, ghostRequestDelay } from '../ghostRequestTiming';

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

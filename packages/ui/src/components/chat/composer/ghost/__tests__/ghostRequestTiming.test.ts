import { describe, expect, test } from 'bun:test';

import { createGhostRequestGate, ghostRequestDelay, ghostTypingDebounceMs } from '../ghostRequestTiming';

const DEBOUNCE_MS = ghostTypingDebounceMs();
const MIN_INTERVAL_MS = 30_000;

describe('ghostRequestDelay', () => {
    test('waits for typing to be idle before the first request', () => {
        expect(ghostRequestDelay(10_000, null, DEBOUNCE_MS)).toBe(DEBOUNCE_MS);
    });

    test('holds a burst behind the minimum request interval', () => {
        expect(ghostRequestDelay(12_000, 10_000, DEBOUNCE_MS)).toBe(
            MIN_INTERVAL_MS - 2_000,
        );
    });

    test('still applies the debounce when the request floor has elapsed', () => {
        expect(ghostRequestDelay(40_000, 10_000, DEBOUNCE_MS)).toBe(DEBOUNCE_MS);
    });

    test('uses the later boundary when the floor expires during the debounce', () => {
        expect(ghostRequestDelay(38_750, 10_000, DEBOUNCE_MS)).toBe(DEBOUNCE_MS);
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

        expect(gate.delay(10_000, DEBOUNCE_MS)).toBe(DEBOUNCE_MS);
        gate.markStarted(11_500);
        expect(gate.delay(12_000, 0)).toBe(29_500);
        expect(gate.delay(12_000, DEBOUNCE_MS)).toBe(29_500);
    });
});

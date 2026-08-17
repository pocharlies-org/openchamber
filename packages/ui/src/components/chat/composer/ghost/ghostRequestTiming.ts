const GHOST_IDLE_POLL_MS = 15_000;
const GHOST_REQUEST_MIN_INTERVAL_MS = 30_000;

export function ghostIdlePollMs(): number {
    return GHOST_IDLE_POLL_MS;
}

export interface GhostRequestGate {
    delay(now: number, debounceMs: number): number;
    markStarted(now: number): void;
}

export function createGhostRequestGate(
    minIntervalMs: number = GHOST_REQUEST_MIN_INTERVAL_MS,
): GhostRequestGate {
    let lastRequestStartedAt: number | null = null;
    return {
        delay: (now, debounceMs) => ghostRequestDelay(
            now,
            lastRequestStartedAt,
            debounceMs,
            minIntervalMs,
        ),
        markStarted: (now) => {
            lastRequestStartedAt = now;
        },
    };
}

/** Delay until a request satisfies the global cost floor and optional debounce. */
export function ghostRequestDelay(
    now: number,
    lastRequestStartedAt: number | null,
    debounceMs: number,
    minIntervalMs: number = GHOST_REQUEST_MIN_INTERVAL_MS,
): number {
    const floorDelay = lastRequestStartedAt === null
        ? 0
        : Math.max(0, lastRequestStartedAt + minIntervalMs - now);
    return Math.max(debounceMs, floorDelay);
}

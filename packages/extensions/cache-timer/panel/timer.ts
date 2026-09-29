// Pure cache-countdown logic, ported from the core ComposerCacheTimer
// (packages/ui/src/components/chat/composer/ui/ComposerCacheTimer.tsx). No DOM
// and no host access here: the guest in main.ts feeds it the host's
// composer-status snapshot and paints the result.

const MINUTE = 60_000;

/**
 * Label shown once the countdown is over. The panel substitutes the i18n
 * string; this constant keeps the pure logic testable.
 */
export const EXPIRED_LABEL = 'expired';

/**
 * Prompt-cache TTL of the provider that served the last turn, or null when the
 * provider has no TTL worth counting down. Claude Code (every account provider,
 * `claude-code` and `claude-code-<account>`) writes its cache with the 1h TTL —
 * the CLI transcripts only ever show `ephemeral_1h_input_tokens`. The raw
 * Anthropic API defaults to 5 minutes.
 */
export const promptCacheTtlMs = (providerId: string | null): number | null => {
  if (!providerId) return null;
  if (providerId === 'claude-code' || providerId.startsWith('claude-code-')) return 60 * MINUTE;
  if (providerId === 'anthropic') return 5 * MINUTE;
  return null;
};

export const formatCacheDuration = (ms: number): string => {
  if (ms < MINUTE) return '<1m';
  const minutes = Math.floor(ms / MINUTE);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
};

export type CacheTimer = {
  ttl: number;
  elapsed: number;
  left: number;
  expired: boolean;
  label: string;
  tone: 'error' | 'warning' | 'muted';
};

/**
 * Time left before the prompt cache expires, counted from the end of the last
 * assistant turn — the same "last prompt" clock the Claude Code VS Code
 * extension shows. A turn after expiry re-writes the whole context, so this is
 * the number that says whether continuing now is cheap.
 *
 * `cacheTtlMs` is the lifetime the host's engine read from the last answer's
 * usage and takes preference over the static provider map; `compacted` says a
 * compaction happened after that answer, so the cache no longer covers the
 * conversation and the clock reads expired until the next one.
 */
export const computeCacheTimer = (input: {
  providerId: string | null;
  lastAssistantAt: number | null;
  now: number;
  cacheTtlMs: number | null;
  compacted: boolean;
}): CacheTimer | null => {
  const ttl = input.cacheTtlMs ?? promptCacheTtlMs(input.providerId);
  if (ttl === null || input.lastAssistantAt === null) return null;

  const elapsed = Math.max(0, input.now - input.lastAssistantAt);
  const left = ttl - elapsed;
  const expired = left <= 0 || input.compacted;
  return {
    ttl,
    elapsed,
    left,
    expired,
    label: expired ? EXPIRED_LABEL : formatCacheDuration(left),
    tone: expired ? 'error' : left <= 5 * MINUTE ? 'warning' : 'muted',
  };
};

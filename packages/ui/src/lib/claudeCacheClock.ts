import { z } from 'zod';

import type { Message } from '@/lib/opencode/model';

const MINUTE = 60_000;

const cacheMetadataSchema = z.object({
  claude: z.object({ cacheTtlMs: z.number().positive().finite().nullable().catch(null) }).nullable().catch(null),
}).catch({ claude: null });

/**
 * Prompt-cache TTL of the provider that served the last turn, or null when the
 * provider has no TTL worth counting down. Claude Code (every account provider,
 * `claude-code` and `claude-code-<account>`) writes its cache with the 1h TTL —
 * the CLI transcripts only ever show `ephemeral_1h_input_tokens`. The raw
 * Anthropic API defaults to 5 minutes.
 * `claude` is OpenChamber's own Claude engine: the same CLI behind it writes
 * the 1h tier (measured: `ephemeral_1h_input_tokens` writes in its transcripts);
 * the usage-derived TTL from `claudeCacheTtlMs` wins when the engine read one,
 * and this entry is what keeps the clock counting when the answer arrived
 * through a route that hides the tier (a router-served turn reports no tier).
 */
export const providerCacheTtlMs = (providerId: string | null | undefined): number | null => {
  if (!providerId) return null;
  if (providerId === 'claude-code' || providerId.startsWith('claude-code-')) return 60 * MINUTE;
  if (providerId === 'claude') return 60 * MINUTE;
  if (providerId === 'anthropic') return 5 * MINUTE;
  return null;
};

/**
 * The lifetime a Claude Code session's cache was written with, as its engine
 * read it from the API's usage (`cache_creation.ephemeral_1h/5m_input_tokens`):
 * the answer's own reading first, then the session's latest. Null when the
 * engine could not tell (a local model's prefix cache has no lifetime).
 */
export const claudeCacheTtlMs = (message: Message, sessionTtlMs: number | null): number | null => {
  const own = cacheMetadataSchema.parse(message.metadata ?? {}).claude?.cacheTtlMs;
  if (own) return own;
  return message.role === 'assistant' && message.providerID === 'claude' ? sessionTtlMs : null;
};

/**
 * A compaction newer than the last answer: the cache does not cover the
 * compacted conversation yet, so the clock shows it expired until the next
 * answer (as the VS Code extension's clock does).
 */
export const compactedSince = (messages: readonly Message[], last: Message): boolean => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === last) return false;
    if (message?.role === 'compaction' && message.status !== 'failed') return true;
  }
  return false;
};

import { z } from 'zod';

import type { Message } from '@/lib/opencode/model';

const cacheMetadataSchema = z.object({
  claude: z.object({ cacheTtlMs: z.number().positive().finite().nullable().catch(null) }).nullable().catch(null),
}).catch({ claude: null });

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

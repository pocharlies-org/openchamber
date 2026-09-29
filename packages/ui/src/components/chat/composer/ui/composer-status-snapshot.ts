import type { ComposerStatusSnapshot } from '@openchamber/sdk';
import type { Message, Session } from '@/lib/opencode/model';
import { claudeCacheTtlMs, compactedSince } from '@/lib/claudeCacheClock';
import { getClaudeEngineState } from '@/lib/claudeSessionMetadata';
import { getLatestCompletedAssistantMessage } from '@/sync/stream-metrics';

/**
 * The composer-status snapshot for one session, computed from the sync's
 * message bucket. Pure: the caller reads the messages, the session and the
 * engine and passes them in, so this stays testable and never touches sync
 * context. Without a session or a completed assistant turn the snapshot still
 * exists with `null` fields — the contract is always a snapshot, never an
 * absence. `cacheTtlMs` is the lifetime the engine read from the last answer's
 * usage (falling back to the session's), `compacted` says a compaction happened
 * after that last answer.
 */
export const buildComposerStatusSnapshot = ({
  sessionId,
  engine,
  messages,
  session,
}: {
  sessionId: string | null;
  engine: string;
  messages: readonly Message[];
  session: Session | null | undefined;
}): ComposerStatusSnapshot => {
  const last = sessionId ? getLatestCompletedAssistantMessage(messages) : null;
  return {
    sessionId: sessionId ?? '',
    engine,
    providerId: last?.providerID ?? null,
    lastAssistantAt: last?.time.completed ?? last?.time.created ?? null,
    cacheTtlMs: last ? claudeCacheTtlMs(last, getClaudeEngineState(session).cacheTtlMs) : null,
    compacted: last ? compactedSince(messages, last) : false,
  };
};

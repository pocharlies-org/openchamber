import type { ComposerStatusSnapshot } from '@openchamber/sdk';
import type { Message } from '@/lib/opencode/model';
import { getLatestCompletedAssistantMessage } from '@/sync/stream-metrics';

/**
 * The composer-status snapshot for one session, computed from the sync's
 * message bucket. Pure: the caller reads the messages and the engine and
 * passes them in, so this stays testable and never touches sync context.
 * Without a session or a completed assistant turn the snapshot still exists
 * with `null` fields — the contract is always a snapshot, never an absence.
 */
export const buildComposerStatusSnapshot = ({
  sessionId,
  engine,
  messages,
}: {
  sessionId: string | null;
  engine: string;
  messages: readonly Message[];
}): ComposerStatusSnapshot => {
  const last = sessionId ? getLatestCompletedAssistantMessage(messages) : null;
  return {
    sessionId: sessionId ?? '',
    engine,
    providerId: last?.providerID ?? null,
    lastAssistantAt: last?.time.completed ?? last?.time.created ?? null,
  };
};

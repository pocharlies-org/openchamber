import React from 'react';
import { getLastConversationMessage, isIncompleteAssistantTurn, type Message } from '@/lib/opencode/model';
import { useDurationTickerNow } from '@/hooks/useDurationTicker';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionStatus, useSessionMessages, useSessionPermissions, useSessionForms } from '@/sync/sync-context';
import { MESSAGE_ACTIVITY_STALE_MS, useStreamingStore } from '@/sync/streaming';

// Mirrors OpenCode SessionStatus: busy|retry|idle.
type SessionActivityPhase = 'idle' | 'busy' | 'retry';

/**
 * Whether a trailing assistant message with no completion still counts as
 * work in progress. Without a session status the composer falls back to that
 * message, and an orphaned one — the stream dropped, the server restarted
 * before `step.ended`, an error that never closed it — would otherwise keep
 * the session "working" (stop button, spinner) forever. It expires after
 * `MESSAGE_ACTIVITY_STALE_MS` with no event for the message.
 */
export function isIncompleteAssistantWorking(
  message: Message | undefined,
  now: number,
  lastUpdateAt?: number,
): boolean {
  if (!message || !isIncompleteAssistantTurn(message) || message.role !== 'assistant') return false;
  if (message.error !== undefined) return false;
  const activityAt = Math.max(
    message.time.created,
    message.time.streamed ?? 0,
    typeof lastUpdateAt === 'number' && Number.isFinite(lastUpdateAt) ? lastUpdateAt : 0,
  );
  return now - activityAt <= MESSAGE_ACTIVITY_STALE_MS;
}

export interface SessionActivityResult {
  phase: SessionActivityPhase;
  isWorking: boolean;
  isBusy: boolean;
  isCooldown: boolean;
}

const IDLE_RESULT: SessionActivityResult = {
  phase: 'idle',
  isWorking: false,
  isBusy: false,
  isCooldown: false,
};

/**
 * Determines if a session is actively working.
 * Checks session_status and, only when status is missing, falls back to the
 * trailing assistant message when its completion update has not landed yet.
 * Returns idle when permissions or forms are pending (the permission /
 * form indicator takes priority, and the send button must stay available so
 * the user can supersede the prompt with a new message).
 */
export function useSessionActivity(sessionId: string | null | undefined, directory?: string): SessionActivityResult {
  const status = useSessionStatus(sessionId ?? '', directory);
  const messages = useSessionMessages(sessionId ?? '', directory);
  const permissions = useSessionPermissions(sessionId ?? '', directory);
  const forms = useSessionForms(sessionId ?? '', directory);
  // Plumbing roles are transparent here: a synthetic or switch message
  // landing after the streaming assistant must not read as the turn ending.
  const lastMessage = getLastConversationMessage(messages);
  const lastAssistantId = lastMessage?.role === 'assistant' ? lastMessage.id : null;
  const lastAssistantActivityAt = useStreamingStore(React.useCallback(
    (state) => (lastAssistantId ? state.messageActivityAt.get(lastAssistantId) : undefined),
    [lastAssistantId],
  ));
  // Only the status-less fallback needs a clock, to let an orphaned message expire.
  const needsFallbackClock = status === undefined
    && lastMessage?.role === 'assistant'
    && isIncompleteAssistantTurn(lastMessage)
    && lastMessage.error === undefined;
  const now = useDurationTickerNow(needsFallbackClock, 5_000);

  return React.useMemo<SessionActivityResult>(() => {
    if (!sessionId) return IDLE_RESULT;

    // Permissions or forms pending → idle (the blocking indicator takes
    // priority and the send button must remain a send, not a stop).
    if (permissions.length > 0 || forms.length > 0) return IDLE_RESULT;

    const phase: SessionActivityPhase = (status?.type ?? 'idle') as SessionActivityPhase;

    // Only trust the trailing assistant message as a transient fallback while
    // waiting for session.status/message.updated to settle, and only while it
    // keeps receiving events.
    const hasPendingAssistant = isIncompleteAssistantWorking(lastMessage, now, lastAssistantActivityAt);

    const hasAuthoritativeStatus = status !== undefined;
    const statusWorking = hasAuthoritativeStatus && phase !== 'idle';
    const isWorking = statusWorking || hasPendingAssistant;

    if (hasAuthoritativeStatus && !statusWorking) return IDLE_RESULT;

    if (!isWorking) return IDLE_RESULT;

    return {
      phase: statusWorking ? phase : 'busy',
      isWorking: true,
      isBusy: phase === 'busy' || (!statusWorking && hasPendingAssistant),
      isCooldown: false,
    };
  }, [sessionId, status, permissions, forms, lastMessage, now, lastAssistantActivityAt]);
}

export function useCurrentSessionActivity(): SessionActivityResult {
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);
  return useSessionActivity(currentSessionId, currentSessionDirectory ?? undefined);
}

import React from 'react';
import type { Message } from '@opencode-ai/sdk/v2/client';
import { useDurationTickerNow } from '@/hooks/useDurationTicker';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionStatus, useSessionMessages, useSessionPermissions, useSessionQuestions } from '@/sync/sync-context';
import { MESSAGE_ACTIVITY_STALE_MS, useStreamingStore } from '@/sync/streaming';

// Mirrors OpenCode SessionStatus: busy|retry|idle.
type SessionActivityPhase = 'idle' | 'busy' | 'retry';
export function isIncompleteAssistantWorking(
  message: Message | undefined,
  now: number,
  lastUpdateAt?: number,
): boolean {
  if (!message || message.role !== 'assistant') return false;
  if (typeof message.time?.completed === 'number' || message.error !== undefined) return false;

  const activityAt = typeof lastUpdateAt === 'number' && Number.isFinite(lastUpdateAt)
    ? Math.max(message.time.created, lastUpdateAt)
    : message.time.created;
  return now - activityAt <= MESSAGE_ACTIVITY_STALE_MS;
}

export interface SessionActivityResult {
  phase: SessionActivityPhase;
  authoritativePhase: SessionActivityPhase | null;
  hasAuthoritativeStatus: boolean;
  isWorking: boolean;
  isBusy: boolean;
  isCooldown: boolean;
}

const IDLE_RESULT: SessionActivityResult = {
  phase: 'idle',
  authoritativePhase: null,
  hasAuthoritativeStatus: false,
  isWorking: false,
  isBusy: false,
  isCooldown: false,
};
const AUTHORITATIVE_IDLE_RESULT: SessionActivityResult = {
  ...IDLE_RESULT,
  authoritativePhase: 'idle',
  hasAuthoritativeStatus: true,
};

/**
 * Determines if a session is actively working.
 * Checks session_status and, only when status is missing, falls back to the
 * trailing assistant message when its completion update has not landed yet.
 * Returns idle when permissions or questions are pending (the permission /
 * question indicator takes priority, and the send button must stay available so
 * the user can supersede the prompt with a new message).
 */
export function useSessionActivity(sessionId: string | null | undefined, directory?: string): SessionActivityResult {
  const status = useSessionStatus(sessionId ?? '', directory);
  const messages = useSessionMessages(sessionId ?? '', directory);
  const permissions = useSessionPermissions(sessionId ?? '', directory);
  const questions = useSessionQuestions(sessionId ?? '', directory);
  const lastMessage = messages[messages.length - 1];
  const lastAssistantId = lastMessage?.role === 'assistant' ? lastMessage.id : null;
  const lastAssistantActivityAt = useStreamingStore(React.useCallback(
    (state) => lastAssistantId ? state.messageActivityAt.get(lastAssistantId) : undefined,
    [lastAssistantId],
  ));
  const needsFallbackClock = status === undefined
    && lastMessage?.role === 'assistant'
    && typeof lastMessage.time?.completed !== 'number'
    && lastMessage.error === undefined;
  const now = useDurationTickerNow(needsFallbackClock, 5_000);

  return React.useMemo<SessionActivityResult>(() => {
    if (!sessionId) return IDLE_RESULT;

    const phase: SessionActivityPhase = (status?.type ?? 'idle') as SessionActivityPhase;
    const hasAuthoritativeStatus = status !== undefined;

    // Permissions or questions pending → idle (the blocking indicator takes
    // priority and the send button must remain a send, not a stop).
    if (permissions.length > 0 || questions.length > 0) {
      return hasAuthoritativeStatus
        ? { ...AUTHORITATIVE_IDLE_RESULT, authoritativePhase: phase }
        : IDLE_RESULT;
    }

    // Only trust the trailing assistant message as a transient fallback while
    // waiting for session.status/message.updated to settle.
    const hasPendingAssistant = isIncompleteAssistantWorking(lastMessage, now, lastAssistantActivityAt);

    const statusWorking = hasAuthoritativeStatus && phase !== 'idle';
    const isWorking = statusWorking || hasPendingAssistant;

    if (hasAuthoritativeStatus && !statusWorking) return AUTHORITATIVE_IDLE_RESULT;

    if (!isWorking) return IDLE_RESULT;

    return {
      phase: statusWorking ? phase : 'busy',
      authoritativePhase: hasAuthoritativeStatus ? phase : null,
      hasAuthoritativeStatus,
      isWorking: true,
      isBusy: phase === 'busy' || (!statusWorking && hasPendingAssistant),
      isCooldown: false,
    };
  }, [sessionId, status, permissions, questions, lastMessage, now, lastAssistantActivityAt]);
}

export function useCurrentSessionActivity(): SessionActivityResult {
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);
  return useSessionActivity(currentSessionId, currentSessionDirectory ?? undefined);
}

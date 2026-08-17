import React from 'react';
import { getLastConversationMessage, isIncompleteAssistantTurn } from '@/lib/opencode/model';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionStatus, useSessionMessages, useSessionPermissions, useSessionForms } from '@/sync/sync-context';

// Mirrors OpenCode SessionStatus: busy|retry|idle.
type SessionActivityPhase = 'idle' | 'busy' | 'retry';

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
 * Returns idle when permissions or forms are pending (the permission /
 * form indicator takes priority, and the send button must stay available so
 * the user can supersede the prompt with a new message).
 */
export function useSessionActivity(sessionId: string | null | undefined, directory?: string): SessionActivityResult {
  const status = useSessionStatus(sessionId ?? '', directory);
  const messages = useSessionMessages(sessionId ?? '', directory);
  const permissions = useSessionPermissions(sessionId ?? '', directory);
  const forms = useSessionForms(sessionId ?? '', directory);

  return React.useMemo<SessionActivityResult>(() => {
    if (!sessionId) return IDLE_RESULT;

    const phase: SessionActivityPhase = (status?.type ?? 'idle') as SessionActivityPhase;
    const hasAuthoritativeStatus = status !== undefined;

    // Permissions or forms pending → idle (the blocking indicator takes
    // priority and the send button must remain a send, not a stop).
    if (permissions.length > 0 || forms.length > 0) {
      return hasAuthoritativeStatus
        ? { ...AUTHORITATIVE_IDLE_RESULT, authoritativePhase: phase }
        : IDLE_RESULT;
    }

    // Only trust the trailing assistant message as a transient fallback while
    // waiting for session.status/message.updated to settle.
    // Plumbing roles are transparent here: a synthetic or switch message
    // landing after the streaming assistant must not read as the turn ending.
    const hasPendingAssistant = isIncompleteAssistantTurn(getLastConversationMessage(messages));

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
  }, [sessionId, status, messages, permissions, forms]);
}

export function useCurrentSessionActivity(): SessionActivityResult {
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);
  return useSessionActivity(currentSessionId, currentSessionDirectory ?? undefined);
}

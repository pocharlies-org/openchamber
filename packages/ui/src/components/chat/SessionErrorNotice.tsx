import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { ErrorResponseDetails } from '@/components/chat/ErrorResponseDetails';
import { useI18n } from '@/lib/i18n';
import { showOpenCodeStatus } from '@/lib/openCodeStatus';
import { getLastConversationMessage, type Message, type Part, type Session } from '@/lib/opencode/model';
import { useLatestSessionError } from '@/sync/notification-store';
import { useDirectoryStore, useSession, useSessionStatus, useSessionStatusSnapshotReady } from '@/sync/sync-context';
import { useSessionEngine } from '@/hooks/useSessionEngine';
import { getClaudeLiveState } from '@/lib/claudeSessionMetadata';
import { refetchSessionMessages } from '@/sync/session-actions';
import { LongErrorText } from './LongErrorText';
import { readLastMessageState, scheduleUnansweredRechecks, type LastMessageState } from './sessionErrorNoticeState';

interface SessionErrorNoticeProps {
  sessionId: string;
  directory?: string;
}

/**
 * What the stored history says about a session that stopped without a reply.
 *
 * OpenCode keeps the failure reason only on the live `session.execution.failed`
 * event; after a reload the session record carries just `outcome`. A subagent
 * session is the exception: its parent's `subagent` tool call records the
 * reason ("Subagent failed (…): Model unavailable: …") and points at the child
 * through `metadata.sessionID`, so the child can show that text as its own.
 */
type StoredFailure = {
  outcome: Session['outcome'];
  parentToolError: string | null;
} | null;

const isFailedOutcome = (outcome: Session['outcome']): boolean => outcome === 'failed' || outcome === 'interrupted';

const findParentToolError = (
  parent: Session | undefined,
  messages: Record<string, Message[] | undefined>,
  parts: Record<string, Part[] | undefined>,
  childSessionId: string,
): string | null => {
  if (!parent) return null;
  for (const message of messages[parent.id] ?? []) {
    for (const part of parts[message.id] ?? []) {
      if (part.type !== 'tool' || part.state.status !== 'error') continue;
      if (part.state.metadata?.sessionID !== childSessionId) continue;
      const text = part.state.error.trim();
      if (text.length > 0) return text;
    }
  }
  return null;
};

const useStoredFailure = (sessionId: string, directory?: string): StoredFailure => {
  const store = useDirectoryStore(directory);
  const cacheRef = React.useRef<StoredFailure>(null);
  const getSnapshot = React.useCallback((): StoredFailure => {
    if (!sessionId) return null;
    const state = store.getState();
    const session = state.session.find((candidate) => candidate.id === sessionId);
    if (!session || !isFailedOutcome(session.outcome)) {
      cacheRef.current = null;
      return null;
    }
    const parent = session.parentID
      ? state.session.find((candidate) => candidate.id === session.parentID)
      : undefined;
    const next: StoredFailure = {
      outcome: session.outcome,
      parentToolError: findParentToolError(parent, state.message, state.part, sessionId),
    };
    const cached = cacheRef.current;
    if (cached && cached.outcome === next.outcome && cached.parentToolError === next.parentToolError) return cached;
    cacheRef.current = next;
    return next;
  }, [sessionId, store]);
  const subscribe = React.useCallback((notify: () => void) => {
    if (!sessionId) return () => undefined;
    return store.subscribe(notify);
  }, [sessionId, store]);
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

// The last conversation message of a session, with whether it already carries
// an error of its own: an assistant message that OpenCode marked failed
// renders its error inline, so the session-level notice must not repeat it.
// v2 plumbing roles (synthetic prompts, skill/shell records, agent/model
// switches) are transparent here — one of them arriving after an unanswered
// prompt must not hide the "no reply" notice.
const useLastMessageState = (sessionId: string, directory?: string): LastMessageState => {
  const store = useDirectoryStore(directory);
  const cacheRef = React.useRef<LastMessageState>(null);
  const getSnapshot = React.useCallback((): LastMessageState => {
    if (!sessionId) return null;
    const next = readLastMessageState(getLastConversationMessage(store.getState().message[sessionId]));
    if (!next) {
      cacheRef.current = null;
      return null;
    }
    const cached = cacheRef.current;
    if (cached && cached.role === next.role && cached.timestamp === next.timestamp && cached.hasError === next.hasError) {
      return cached;
    }
    cacheRef.current = next;
    return next;
  }, [sessionId, store]);
  const subscribe = React.useCallback((notify: () => void) => {
    if (!sessionId) return () => undefined;
    return store.subscribe(notify);
  }, [sessionId, store]);
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

/**
 * Shows what the session's engine (OpenCode or Claude Code, see
 * sessionEngine.ts) reported when it stopped a turn without producing a
 * reply. The copy names the engine that owns the session: a Claude Code
 * session never blames OpenCode, nor offers OpenCode's status report. Rendered under the last message, only while that turn is the latest
 * one: sending again moves the last message past the error and hides it.
 *
 * Detail, best first: the live error event; the parent's subagent tool error
 * for a child session; the session's own stored outcome.
 */
export const SessionErrorNotice: React.FC<SessionErrorNoticeProps> = ({ sessionId, directory }) => {
  const { t } = useI18n();
  const latestError = useLatestSessionError(sessionId);
  const status = useSessionStatus(sessionId, directory);
  const statusSnapshotReady = useSessionStatusSnapshotReady(directory, sessionId);
  const lastMessage = useLastMessageState(sessionId, directory);
  const storedFailure = useStoredFailure(sessionId, directory);
  const engine = useSessionEngine(sessionId, directory);
  // A Claude session another process holds (terminal, VS Code, Remote
  // Control) runs its turn THERE: this window only follows the transcript, and
  // a message that never reached that process fails the send itself. Silence
  // here is not a reply that never began.
  const session = useSession(sessionId, directory);
  const claudeHeldElsewhere = engine.id === 'claude' && getClaudeLiveState(session).liveElsewhere !== null;
  const unansweredAfterMs = engine.unansweredAfterMs;

  // An omitted status means idle only after a successful status snapshot:
  // after a reload the last prompt is hydrated before the runtime reports
  // that the session is still busy.
  const isIdle = status?.type === 'idle' || (status === undefined && statusSnapshotReady);
  const reportedError = latestError && isIdle
    && (!lastMessage || latestError.time >= lastMessage.timestamp)
    && !(lastMessage?.role === 'assistant' && lastMessage.hasError)
    ? latestError
    : null;
  // A stored failure only explains a turn that has no reply of its own: once
  // an assistant message follows the prompt, it carries any error itself.
  const storedFailureApplies = !reportedError && isIdle && storedFailure !== null && lastMessage?.role === 'user';
  // A user message that the session is idle on, with nothing after it for a
  // while, is a reply that never began: the send was accepted but OpenCode
  // produced neither a message nor an error for it.
  const unansweredSince = !reportedError && !storedFailureApplies && isIdle && !claudeHeldElsewhere
    && lastMessage?.role === 'user' && lastMessage.timestamp > 0
    ? lastMessage.timestamp
    : null;
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (unansweredSince === null) return undefined;
    const remaining = unansweredAfterMs - (Date.now() - unansweredSince);
    if (remaining <= 0) return undefined;
    const timer = window.setTimeout(() => setNow(Date.now()), remaining + 50);
    return () => window.clearTimeout(timer);
  }, [unansweredSince, unansweredAfterMs]);
  const unansweredDue = unansweredSince !== null && Math.max(now, Date.now()) - unansweredSince >= unansweredAfterMs;
  // Looking unanswered is only a guess: the live stream may have dropped the
  // reply. Re-read the session first and show the notice only once a read has
  // settled with the prompt still last. The key ties that verdict to this
  // session and prompt, so a new send or a session switch starts unverified.
  const unansweredKey = unansweredDue && sessionId ? `${sessionId}:${unansweredSince}` : null;
  const [verifiedKey, setVerifiedKey] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!unansweredKey || !sessionId) return undefined;
    return scheduleUnansweredRechecks(
      () => refetchSessionMessages(sessionId),
      window,
      () => setVerifiedKey(unansweredKey),
    );
  }, [unansweredKey, sessionId]);
  const unanswered = unansweredKey !== null && verifiedKey === unansweredKey;

  if (!reportedError && !storedFailureApplies && !unanswered) return null;

  const copy = { engine: engine.label };
  const noDetails = engine.hasOpenCodeStatus
    ? t('chat.sessionError.noDetails', copy)
    : t('chat.sessionError.noDetailsBare', copy);
  let title: string;
  let detail: string;
  let hasDetails = true;
  let responseBody: string | null = null;
  if (reportedError) {
    title = t('chat.sessionError.title', copy);
    hasDetails = Boolean(reportedError.error?.message);
    const message = reportedError.error?.message ?? noDetails;
    detail = reportedError.error?.name ? `${reportedError.error.name}: ${message}` : message;
    responseBody = reportedError.error?.responseBody ?? null;
  } else if (storedFailureApplies) {
    title = storedFailure.outcome === 'interrupted' ? t('chat.sessionError.interrupted', copy) : t('chat.sessionError.title', copy);
    hasDetails = storedFailure.parentToolError !== null;
    detail = storedFailure.parentToolError ?? noDetails;
  } else {
    title = t('chat.sessionError.noReply', copy);
    hasDetails = false;
    detail = noDetails;
  }

  return (
    <div className="chat-message-column">
      <div
        role="status"
        className="mt-2 max-w-full rounded-lg border border-[var(--status-error-border)] bg-[var(--status-error-background)] px-3 py-2"
      >
        <div className="flex items-center gap-2">
          <Icon name="error-warning" className="size-3.5 shrink-0 text-[var(--status-error)]" />
          <span className="typography-meta font-medium text-foreground">{title}</span>
        </div>
        <LongErrorText text={detail} buttonClassName="ml-[0.875rem]">
          {(visibleText) => (
            <div className="mt-1 pl-[1.375rem] typography-meta text-muted-foreground break-words">{visibleText}</div>
          )}
        </LongErrorText>
        {!hasDetails && engine.hasOpenCodeStatus ? (
          <div className="pl-[1.375rem]">
            <Button
              variant="link"
              size="xs"
              onClick={() => { void showOpenCodeStatus(); }}
              className="-ml-2 normal-case"
            >
              {t('chat.sessionError.showStatus')}
            </Button>
          </div>
        ) : null}
        {responseBody ? <ErrorResponseDetails body={responseBody} className="pl-[1.375rem]" /> : null}
      </div>
    </div>
  );
};

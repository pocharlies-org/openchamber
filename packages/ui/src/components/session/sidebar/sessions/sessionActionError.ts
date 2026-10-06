import type { useI18n } from '@/lib/i18n';
import { OpencodeApiError } from '@/lib/opencode/client';
import { SESSION_ENGINE_INFO, type SessionEngine } from '@/lib/sessionEngine';

type Translate = ReturnType<typeof useI18n>['t'];

/**
 * One sentence a person can act on when a session action fails. An OpenCode
 * failure names the status, the error class and the log ref, because "500"
 * alone sends whoever reads it hunting for a server that is in fact up.
 *
 * `engine` is the engine that owns the session: a Claude Code session's
 * failure is Claude Code's, never "OpenCode answered…". An operation the
 * engine does not have says so in those words, whichever engine refused.
 */
export const describeSessionActionError = (error: Error, t: Translate, engine: SessionEngine = 'opencode'): string => {
  if (error instanceof OpencodeApiError) {
    if (error.unsupported) {
      const refusing = SESSION_ENGINE_INFO[error.unsupported.engine as SessionEngine]?.label ?? error.unsupported.engine;
      return t('sessions.sidebar.session.action.unsupported', { engine: refusing });
    }
    if (error.status !== undefined && error.ref) {
      return t('sessions.sidebar.session.action.upstreamErrorWithRef', {
        status: error.status,
        name: error.tag ?? 'Error',
        ref: error.ref,
      });
    }
    if (error.status !== undefined) {
      return t('sessions.sidebar.session.action.upstreamError', {
        engine: SESSION_ENGINE_INFO[engine].label,
        status: error.status,
        message: error.detail || error.tag || t('sessions.sidebar.session.action.noDetails'),
      });
    }
  }
  return error.message || t('sessions.sidebar.session.action.noDetails');
};

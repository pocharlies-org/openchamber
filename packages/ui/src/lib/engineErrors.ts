import type { useI18n } from '@/lib/i18n';
import { isUnsupportedOperation } from '@/lib/opencode/client';
import { EngineUnsupportedError, isSessionEngine, SESSION_ENGINE_INFO } from '@/lib/sessionEngine';

type Translate = ReturnType<typeof useI18n>['t'];

/**
 * The sentence for an operation the session's engine does not have — refused
 * in the client (`EngineUnsupportedError`) or by the server
 * (`UnsupportedOperationError`) — or null for any other failure. Localized
 * and naming the engine, instead of the English server message.
 */
export const describeEngineRefusal = (error: unknown, t: Translate): string | null => {
  let engine: string | null = null;
  if (error instanceof EngineUnsupportedError) engine = error.engine;
  else if (isUnsupportedOperation(error)) engine = error.unsupported.engine;
  if (!engine) return null;
  const label = isSessionEngine(engine) ? SESSION_ENGINE_INFO[engine].label : engine;
  return t('sessions.sidebar.session.action.unsupported', { engine: label });
};

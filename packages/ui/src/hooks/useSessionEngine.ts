import { resolveSessionEngine, SESSION_ENGINE_INFO, type SessionEngineInfo } from '@/lib/sessionEngine';
import { useSession } from '@/sync/sync-context';

/**
 * The engine that owns a session, read from the synced record when there is
 * one (its declared `metadata.backend`), else from its id. See sessionEngine.ts.
 */
export const useSessionEngine = (sessionId: string | null | undefined, directory?: string): SessionEngineInfo => {
  const session = useSession(sessionId ?? null, directory);
  return SESSION_ENGINE_INFO[resolveSessionEngine(session ?? (sessionId ? { id: sessionId } : null))];
};

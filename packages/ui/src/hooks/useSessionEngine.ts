import React from 'react';

import { getRuntimeKey } from '@/lib/runtime-switch';
import { resolveSessionEngine, type SessionEngineInfo } from '@/lib/sessionEngine';
import { selectEngineTable, useEngineStore } from '@/stores/useEngineStore';
import { useSession } from '@/sync/sync-context';

/**
 * The engine that owns a session — read from the synced record when there is
 * one (its declared `metadata.backend`), else from its id — with what the
 * server declares that engine can do. See lib/sessionEngine.ts.
 */
export const useSessionEngine = (sessionId: string | null | undefined, directory?: string): SessionEngineInfo => {
  const session = useSession(sessionId ?? null, directory);
  const runtimeKey = getRuntimeKey();
  const table = useEngineStore((state) => selectEngineTable(state, runtimeKey));
  const load = useEngineStore((state) => state.load);
  React.useEffect(() => {
    void load(runtimeKey);
  }, [load, runtimeKey]);
  return table[resolveSessionEngine(session ?? (sessionId ? { id: sessionId } : null))];
};

/**
 * The engine of a session known by id alone, without subscribing to its record:
 * for components rendered once per message, where a per-row store subscription
 * would cost more than it tells. A Claude session's public id always carries
 * its prefix, so the id is enough to tell the engine here.
 */
export const useSessionEngineById = (sessionId: string | null | undefined): SessionEngineInfo => {
  const runtimeKey = getRuntimeKey();
  const table = useEngineStore((state) => selectEngineTable(state, runtimeKey));
  const load = useEngineStore((state) => state.load);
  React.useEffect(() => {
    void load(runtimeKey);
  }, [load, runtimeKey]);
  return table[resolveSessionEngine(sessionId ? { id: sessionId } : null)];
};

import { create } from 'zustand';

import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey } from '@/lib/runtime-switch';
import {
  isSessionEngine,
  mergeDeclaredEngine,
  resolveSessionEngine,
  SESSION_ENGINE_INFO,
  type SessionEngine,
  type SessionEngineInfo,
} from '@/lib/sessionEngine';

/**
 * The session engines each runtime serves and what they can do, as the
 * server declares them (`GET /api/engines`). Keyed by runtime: the app can
 * talk to several hosts, and one may run Claude Code while another does not.
 * Until a runtime answers — or when it is an older server without the route —
 * the static table in lib/sessionEngine.ts stands in.
 */
type EngineTable = Record<SessionEngine, SessionEngineInfo>;

const RETRY_AFTER_MS = 60_000;

type EngineStoreState = {
  byRuntime: Record<string, EngineTable>;
  /** Runtimes asked already (in flight or answered), so each is asked once. */
  requested: Record<string, true>;
  load: (runtimeKey?: string) => Promise<void>;
};

export const parseEnginesAnswer = (payload: unknown): EngineTable => {
  const table: EngineTable = { ...SESSION_ENGINE_INFO };
  const engines = (payload as { engines?: unknown } | null)?.engines;
  if (!Array.isArray(engines)) return table;
  for (const declared of engines) {
    const id = (declared as { id?: unknown } | null)?.id;
    if (!isSessionEngine(id)) continue;
    table[id] = mergeDeclaredEngine(SESSION_ENGINE_INFO[id], declared);
  }
  return table;
};

export const useEngineStore = create<EngineStoreState>()((set, get) => ({
  byRuntime: {},
  requested: {},
  load: async (runtimeKey = getRuntimeKey()) => {
    if (get().requested[runtimeKey]) return;
    set((state) => ({ requested: { ...state.requested, [runtimeKey]: true } }));
    try {
      const response = await runtimeFetch('/api/engines');
      if (!response.ok) throw new Error(`GET /api/engines answered ${response.status}`);
      const table = parseEnginesAnswer(await response.json());
      set((state) => ({ byRuntime: { ...state.byRuntime, [runtimeKey]: table } }));
    } catch {
      // An older server has no such route, or the request failed: the fallback
      // table stands, and the runtime may be asked again after a pause — not on
      // every render that reads it.
      setTimeout(() => {
        set((state) => {
          const requested = { ...state.requested };
          delete requested[runtimeKey];
          return { requested };
        });
      }, RETRY_AFTER_MS);
    }
  },
}));

/** The engine table for the current runtime, declared or fallback. */
export const selectEngineTable = (state: EngineStoreState, runtimeKey: string): EngineTable =>
  state.byRuntime[runtimeKey] ?? SESSION_ENGINE_INFO;

/**
 * The engine info for a session outside React (send path, session actions):
 * its declared or id-derived engine, with what the current runtime declared.
 */
export const engineInfoForSession = (session: { id?: string | null; metadata?: unknown } | null | undefined): SessionEngineInfo =>
  selectEngineTable(useEngineStore.getState(), getRuntimeKey())[resolveSessionEngine(session)];

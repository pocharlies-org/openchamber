import { create } from 'zustand';
import type { SessionSourceFilter } from '@/lib/sessionSourceFilter';

/**
 * Which tool's sessions the sidebar list shows (opencode / Codex / Claude Code).
 *
 * The control lives in `SidebarHeader` and the filtering happens deep inside the
 * session collection, so the two never meet through props. This is the same
 * split upstream solved with `useSessionMultiSelectStore`, and the state follows
 * it here.
 *
 * Deliberately not persisted. A filter that survives a reload can leave the
 * sidebar empty on startup with nothing on screen explaining why.
 */
type SessionSourceFilterStore = {
  filter: SessionSourceFilter;
  /** The list holds sessions from more than one tool, so the control is worth showing. */
  available: boolean;
  setFilter: (filter: SessionSourceFilter) => void;
  setAvailable: (available: boolean) => void;
};

export const useSessionSourceFilterStore = create<SessionSourceFilterStore>()((set, get) => ({
  filter: 'all',
  available: false,

  setFilter: (filter) => {
    if (get().filter === filter) return;
    set({ filter });
  },

  setAvailable: (available) => {
    if (get().available === available) return;
    // Losing the control must not strand the list behind a filter the user can
    // no longer see or clear.
    set(available ? { available } : { available, filter: 'all' });
  },
}));

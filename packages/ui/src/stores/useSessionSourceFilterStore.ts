import { create } from 'zustand';
import type { SessionSourceFilter } from '@/lib/sessionSourceFilter';

/**
 * Which tool's sessions the list shows (opencode / Claude Code).
 *
 * The controls are the desktop `SidebarHeader` chip row, the mobile header
 * button, and the chips inside the mobile sessions sheet; the filtering happens
 * deep inside the session collection, so neither control meets it through props.
 * One state for one list — two controls that each held their own copy would
 * disagree the moment either moved. This is the same split upstream solved with
 * `useSessionMultiSelectStore`, and the state follows it here.
 *
 * Deliberately not persisted. A filter that survives a reload can leave the list
 * empty on startup with nothing on screen explaining why.
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

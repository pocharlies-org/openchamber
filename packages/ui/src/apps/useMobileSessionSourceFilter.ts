import React from 'react';
import { filterSessionsBySource, hasMultipleSessionSources, type SessionSourceFilter } from '@/lib/sessionSourceFilter';
import { useSessionSourceFilterStore } from '@/stores/useSessionSourceFilterStore';

type SessionLike = { id?: string | null };

export type MobileSessionSourceFilter<T extends SessionLike> = {
  /** More than one tool is present, so the chips (and the header button) are worth showing. */
  showSourceFilter: boolean;
  sourceFilter: SessionSourceFilter;
  setSourceFilter: (filter: SessionSourceFilter) => void;
  /** The sheet's list with the tool filter applied: the tree, counts and search are built from it. */
  filteredSessions: T[];
};

/**
 * The tool filter of the mobile sessions sheet (opencode / Claude Code).
 *
 * The state is the shared store, not a copy local to the sheet: the header
 * button edits the same list, and two controls holding separate state would
 * disagree the moment either moved. The sheet publishes availability because
 * it is mounted permanently on phone and tablet, so the header button shows
 * without opening the sheet. Availability reads the UNfiltered list, so the
 * control does not vanish the moment it is used. The filter applies at the
 * ORIGIN of the tree: groups, counts and paging are built from this list, and
 * filtering only while searching left other tools' rows in the unsearched view.
 */
export function useMobileSessionSourceFilter<T extends SessionLike>(sessions: T[]): MobileSessionSourceFilter<T> {
  const sourceFilter = useSessionSourceFilterStore((state) => state.filter);
  const setSourceFilter = useSessionSourceFilterStore((state) => state.setFilter);
  const setAvailable = useSessionSourceFilterStore((state) => state.setAvailable);
  const showSourceFilter = React.useMemo(() => hasMultipleSessionSources(sessions), [sessions]);
  React.useEffect(() => {
    setAvailable(showSourceFilter);
  }, [setAvailable, showSourceFilter]);
  const filteredSessions = React.useMemo(() => filterSessionsBySource(sessions, sourceFilter), [sessions, sourceFilter]);
  return { showSourceFilter, sourceFilter, setSourceFilter, filteredSessions };
}

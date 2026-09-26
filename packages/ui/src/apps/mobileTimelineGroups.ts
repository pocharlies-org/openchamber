/** The project fields a timeline run header needs — the same structural subset
    `MobileProjectIcon` takes, so the list keeps owning its entry type. */
type TimelineRunProject = { id: string; label: string };

/** One stretch of the timeline that belongs to a single project. Not exported:
    the list consumes it through the function's return value. */
type TimelineProjectRun<T> = {
  /** React key: the project plus where the run starts, so two runs of the same
      project never share a key. */
  key: string;
  project: TimelineRunProject;
  entries: T[];
};

/**
 * Collapses a recency-ordered timeline into consecutive stretches of the same
 * project, so the list states a project once per stretch instead of on every
 * row. Rows keep their exact lifecycle position: a project that reappears
 * lower down opens a second run rather than pulling its older rows together,
 * because the order IS the timeline.
 */
export const groupTimelineRunsByProject = <T extends { project: TimelineRunProject }>(
  entries: readonly T[],
): TimelineProjectRun<T>[] => {
  const runs: TimelineProjectRun<T>[] = [];
  let currentProjectId: string | null = null;

  entries.forEach((entry, index) => {
    if (entry.project.id !== currentProjectId) {
      currentProjectId = entry.project.id;
      runs.push({ key: `${entry.project.id}::${index}`, project: entry.project, entries: [entry] });
      return;
    }
    runs[runs.length - 1]!.entries.push(entry);
  });

  return runs;
};

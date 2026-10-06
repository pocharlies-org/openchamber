import { describe, expect, test } from 'bun:test';

import { groupTimelineRunsByProject } from './mobileTimelineGroups';

const entry = (id: string, projectId: string) => ({
  project: { id: projectId, label: projectId },
  session: { id },
});

describe('groupTimelineRunsByProject', () => {
  test('states a project once per consecutive stretch', () => {
    const runs = groupTimelineRunsByProject([
      entry('a', 'k8s'),
      entry('b', 'k8s'),
      entry('c', 'dgx'),
    ]);

    expect(runs.map((run) => [run.project.id, run.entries.map((e) => e.session.id)])).toEqual([
      ['k8s', ['a', 'b']],
      ['dgx', ['c']],
    ]);
  });

  test('a project that reappears opens a new run instead of pulling its rows together', () => {
    const runs = groupTimelineRunsByProject([
      entry('a', 'k8s'),
      entry('b', 'dgx'),
      entry('c', 'k8s'),
    ]);

    expect(runs.map((run) => run.project.id)).toEqual(['k8s', 'dgx', 'k8s']);
    expect(runs.flatMap((run) => run.entries).map((e) => e.session.id)).toEqual(['a', 'b', 'c']);
  });

  test('keys stay unique across runs of the same project', () => {
    const runs = groupTimelineRunsByProject([entry('a', 'k8s'), entry('b', 'k8s'), entry('c', 'k8s')]);

    expect(new Set(runs.map((run) => run.key)).size).toBe(runs.length);
  });

  test('nothing to group is nothing to render', () => {
    expect(groupTimelineRunsByProject([])).toEqual([]);
  });
});

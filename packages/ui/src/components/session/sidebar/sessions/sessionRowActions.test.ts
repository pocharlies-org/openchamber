import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';

import { rowOffersRestore } from './sessionRowActions';

const sessionWith = (time: Session['time']): Session => ({
  id: 'ses_row',
  projectID: 'project',
  directory: '/workspace',
  title: 'Row',
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time,
});

const active = sessionWith({ created: 1, updated: 2 });
const archived = sessionWith({ created: 1, updated: 2, archived: 1_700_000_000_000 });
// An explicit unarchive writes the stamp as 0, so it must not read as archived.
const restored = sessionWith({ created: 1, updated: 2, archived: 0 });

describe('rowOffersRestore', () => {
  test('offers archive, not restore, for a live session outside the archive view', () => {
    expect(rowOffersRestore({ archivedBucket: false, session: active })).toBe(false);
  });

  test('offers restore for an archived session sitting in a project group', () => {
    // The bug this guards: the row branched on `archivedBucket` (where it is
    // drawn), so an archived session in the sidebar offered "Archive" again and
    // never offered to come back.
    expect(rowOffersRestore({ archivedBucket: false, session: archived })).toBe(true);
  });

  test('offers restore for every row drawn inside the archive view', () => {
    expect(rowOffersRestore({ archivedBucket: true, session: archived })).toBe(true);
    expect(rowOffersRestore({ archivedBucket: true, session: active })).toBe(true);
  });

  test('treats the zero unarchive stamp as not archived', () => {
    expect(rowOffersRestore({ archivedBucket: false, session: restored })).toBe(false);
  });
});

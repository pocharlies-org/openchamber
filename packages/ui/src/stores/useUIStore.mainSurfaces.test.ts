import { beforeEach, describe, expect, test } from 'bun:test';
import { useUIStore } from './useUIStore';

describe('main surface state', () => {
  beforeEach(() => {
    useUIStore.setState({
      isScheduledTasksDialogOpen: false,
      isArchivePageOpen: false,
      isCompanyOfficePageOpen: false,
      worktreesPageProjectId: null,
      isMultiRunLauncherOpen: false,
    });
  });

  test('opens Company Office exclusively and closes it with the shared surface action', () => {
    useUIStore.getState().setArchivePageOpen(true);
    useUIStore.getState().setCompanyOfficePageOpen(true);
    expect(useUIStore.getState().isArchivePageOpen).toBe(false);
    expect(useUIStore.getState().isCompanyOfficePageOpen).toBe(true);
    useUIStore.getState().closeMainSurfaces();
    expect(useUIStore.getState().isCompanyOfficePageOpen).toBe(false);
  });
});

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, test } from 'bun:test';
import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import { useSessionSourceFilterStore } from '@/stores/useSessionSourceFilterStore';
import { useMobileSessionSourceFilter, type MobileSessionSourceFilter } from './useMobileSessionSourceFilter';

type Row = { id: string };

const mixed: Row[] = [{ id: 'ses_opencode1' }, { id: 'ses_cccclaude1' }, { id: 'ses_opencode2' }];
const onlyOpencode: Row[] = [{ id: 'ses_opencode1' }, { id: 'ses_opencode2' }];

beforeEach(() => useSessionSourceFilterStore.setState({ filter: 'all', available: false }));

const mount = async (initial: Row[]) => {
  const dom = installHookTestDom();
  const root = createRoot(dom.container);
  const captured: { current: MobileSessionSourceFilter<Row> | null } = { current: null };
  const Probe: React.FC<{ sessions: Row[] }> = ({ sessions }) => {
    captured.current = useMobileSessionSourceFilter(sessions);
    return null;
  };
  await act(async () => root.render(<Probe sessions={initial} />));
  return {
    captured,
    rerender: async (sessions: Row[]) => act(async () => root.render(<Probe sessions={sessions} />)),
    cleanup: () => {
      act(() => root.unmount());
      dom.restore();
    },
  };
};

test('publishes availability for the header button and filters the list at its origin', async () => {
  const view = await mount(mixed);
  try {
    expect(view.captured.current?.showSourceFilter).toBe(true);
    expect(useSessionSourceFilterStore.getState().available).toBe(true);
    expect(view.captured.current?.filteredSessions).toBe(mixed);

    // The header button and the chips edit the same state.
    await act(async () => useSessionSourceFilterStore.getState().setFilter('claude'));
    expect(view.captured.current?.filteredSessions.map((row) => row.id)).toEqual(['ses_cccclaude1']);
    // Availability reads the unfiltered list: the control stays after use.
    expect(view.captured.current?.showSourceFilter).toBe(true);

    await act(async () => view.captured.current?.setSourceFilter('opencode'));
    expect(useSessionSourceFilterStore.getState().filter).toBe('opencode');
    expect(view.captured.current?.filteredSessions.map((row) => row.id)).toEqual(['ses_opencode1', 'ses_opencode2']);
  } finally {
    view.cleanup();
  }
});

test('hides the control and clears the filter when only one tool is left', async () => {
  const view = await mount(mixed);
  try {
    await act(async () => useSessionSourceFilterStore.getState().setFilter('claude'));
    await view.rerender(onlyOpencode);
    expect(view.captured.current?.showSourceFilter).toBe(false);
    expect(useSessionSourceFilterStore.getState()).toMatchObject({ available: false, filter: 'all' });
    expect(view.captured.current?.filteredSessions).toBe(onlyOpencode);
  } finally {
    view.cleanup();
  }
});

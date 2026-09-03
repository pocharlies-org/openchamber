import { beforeEach, describe, expect, test } from 'bun:test';
import { useSessionSourceFilterStore } from './useSessionSourceFilterStore';

const reset = () => useSessionSourceFilterStore.setState({ filter: 'all', available: false });

describe('useSessionSourceFilterStore', () => {
  beforeEach(reset);

  test('starts unfiltered with the control hidden', () => {
    const state = useSessionSourceFilterStore.getState();
    expect(state.filter).toBe('all');
    expect(state.available).toBe(false);
  });

  test('losing availability clears the filter', () => {
    const { setAvailable, setFilter } = useSessionSourceFilterStore.getState();
    setAvailable(true);
    setFilter('codex');
    expect(useSessionSourceFilterStore.getState().filter).toBe('codex');

    // The control disappears with the second tool. Keeping 'codex' here would
    // leave the list filtered with nothing on screen able to clear it.
    setAvailable(false);
    expect(useSessionSourceFilterStore.getState().filter).toBe('all');
    expect(useSessionSourceFilterStore.getState().available).toBe(false);
  });

  test('re-reporting the same values does not publish a new state', () => {
    const { setAvailable, setFilter } = useSessionSourceFilterStore.getState();
    setAvailable(true);
    setFilter('claude');

    let publications = 0;
    const unsubscribe = useSessionSourceFilterStore.subscribe(() => { publications += 1; });
    setAvailable(true);
    setFilter('claude');
    unsubscribe();

    expect(publications).toBe(0);
  });
});

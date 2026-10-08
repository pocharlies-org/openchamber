import { describe, expect, it } from 'vitest';

import { mapWithConcurrency } from './concurrency.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A task that records how many run at once and how many ever started. */
const instrumented = (work = async (item) => item) => {
  const state = { active: 0, max: 0, started: 0 };
  const task = async (item, index) => {
    state.started += 1;
    state.active += 1;
    state.max = Math.max(state.max, state.active);
    try {
      await tick();
      return await work(item, index);
    } finally {
      state.active -= 1;
    }
  };
  return { state, task };
};

describe('mapWithConcurrency', () => {
  it('never runs more than the limit at once, over 200 items', async () => {
    const items = Array.from({ length: 200 }, (_, i) => i);
    const { state, task } = instrumented();
    await mapWithConcurrency(items, 8, task);
    expect(state.started).toBe(200);
    expect(state.max).toBe(8);
  });

  it('returns the results in input order and passes the index', async () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    // Later items finish first: order comes from the index, not from completion.
    const results = await mapWithConcurrency(items, 5, async (item, index) => {
      for (let i = 0; i < 50 - item; i += 1) await tick();
      return `${index}:${item * 2}`;
    });
    expect(results).toEqual(items.map((item) => `${item}:${item * 2}`));
  });

  it('treats a limit of 0, a negative one or NaN as 1, never as unlimited', async () => {
    for (const limit of [0, -3, Number.NaN]) {
      const { state, task } = instrumented();
      await mapWithConcurrency([1, 2, 3, 4, 5], limit, task);
      expect(state.max).toBe(1);
    }
  });

  it('answers an empty list without starting anything', async () => {
    const { state, task } = instrumented();
    expect(await mapWithConcurrency([], 8, task)).toEqual([]);
    expect(state.started).toBe(0);
  });

  it('rejects with the first failure and stops handing out work', async () => {
    const items = Array.from({ length: 200 }, (_, i) => i);
    const { state, task } = instrumented(async (item) => {
      if (item === 20) throw new Error('boom 20');
      return item;
    });
    await expect(mapWithConcurrency(items, 4, task)).rejects.toThrow('boom 20');
    // Item 20 plus at most the other `limit - 1` workers' in-flight items and one more each.
    expect(state.started).toBeLessThan(20 + 1 + 2 * 4);
  });
});

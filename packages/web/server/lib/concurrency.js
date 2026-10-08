/**
 * `task(item, index)` over `items` with at most `limit` running at once;
 * results come back in input order. A `limit` that is not a positive integer
 * counts as 1, never as unlimited. On the first rejection no new item is
 * started and the call rejects with that error. Same name and argument order
 * as `packages/ui/src/lib/concurrency.ts` (the UI's copy is not importable here).
 */
export const mapWithConcurrency = async (items, limit, task) => {
  const results = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try { results[index] = await task(items[index], index); }
      catch (error) { failed = true; throw error; }
    }
  };
  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
};

import { describe, expect, it } from 'vitest';

import { mergeActiveSnapshot, mergePendingList } from './claude-merge.js';

describe('mergeActiveSnapshot', () => {
  it('adds busy Claude sessions inside OpenCode 2\'s `data`, where the UI reads', () => {
    const merged = mergeActiveSnapshot(
      { data: { ses_open: { type: 'running' } } },
      { ses_ccc1: { type: 'busy' }, ses_ccc2: { type: 'idle' }, ses_ccc3: { type: 'retry' } },
    );
    expect(merged).toEqual({ data: { ses_open: { type: 'running' }, ses_ccc1: { type: 'running' }, ses_ccc3: { type: 'running' } } });
  });

  it('keeps a bare snapshot bare', () => {
    expect(mergeActiveSnapshot({ ses_open: { type: 'running' } }, { ses_ccc1: { type: 'busy' } }))
      .toEqual({ ses_open: { type: 'running' }, ses_ccc1: { type: 'running' } });
    expect(mergeActiveSnapshot(null, {})).toEqual({});
  });
});

describe('mergePendingList', () => {
  it('appends Claude requests to OpenCode\'s, once each', () => {
    expect(mergePendingList({ data: [{ id: 'per_1' }] }, [{ id: 'per_ccc1' }, { id: 'per_1' }]))
      .toEqual({ data: [{ id: 'per_1' }, { id: 'per_ccc1' }] });
    expect(mergePendingList([{ id: 'a' }], [{ id: 'b' }])).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('answers null for a payload it cannot read, so the proxy forwards it untouched', () => {
    expect(mergePendingList({ error: 'x' }, [{ id: 'b' }])).toBeNull();
  });
});

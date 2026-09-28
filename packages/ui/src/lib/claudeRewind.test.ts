import { describe, expect, test } from 'bun:test';

import { describeRewindFiles } from './claudeRewind';

describe('claude rewind', () => {
  test('names the first files by their base name and counts the rest', () => {
    expect(describeRewindFiles(['/r/a.ts', '/r/b/c.ts'])).toBe('a.ts, c.ts');
    expect(describeRewindFiles(['/1', '/2', '/3', '/4', '/5'])).toBe('1, 2, 3 +2');
    expect(describeRewindFiles([])).toBe('');
  });
});

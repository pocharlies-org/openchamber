import { describe, expect, test } from 'bun:test';
import { parseDeepLink } from './deepLinks';

describe('parseDeepLink scheme', () => {
  test('accepts the base openchamber scheme', () => {
    expect(parseDeepLink('openchamber://session/abc')).toEqual({ type: 'session', sessionId: 'abc', directory: undefined });
  });

  test('accepts a suffixed scheme registered by a build under another bundle id', () => {
    expect(parseDeepLink('openchamber-pocharlies://session/abc')).toEqual({ type: 'session', sessionId: 'abc', directory: undefined });
    expect(parseDeepLink('openchamber-pocharlies://status')).toEqual({ type: 'status' });
  });

  test('rejects unrelated schemes', () => {
    expect(parseDeepLink('https://session/abc')).toBeNull();
    expect(parseDeepLink('openchamberx://session/abc')).toBeNull();
    expect(parseDeepLink('myopenchamber://session/abc')).toBeNull();
  });
});

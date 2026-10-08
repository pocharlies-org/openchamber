import { describe, expect, test } from 'bun:test';
import { BRAND_URL_SCHEME } from '@/lib/brand';
import { parseDeepLink } from './deepLinks';

describe('parseDeepLink scheme', () => {
  test('accepts the brand scheme', () => {
    expect(parseDeepLink(`${BRAND_URL_SCHEME}://session/abc`)).toEqual({ type: 'session', sessionId: 'abc', directory: undefined });
    expect(parseDeepLink(`${BRAND_URL_SCHEME}://status`)).toEqual({ type: 'status' });
  });

  test('still accepts the legacy openchamber scheme', () => {
    expect(parseDeepLink('openchamber://session/abc')).toEqual({ type: 'session', sessionId: 'abc', directory: undefined });
  });

  test('rejects unrelated schemes', () => {
    expect(parseDeepLink('https://session/abc')).toBeNull();
    expect(parseDeepLink('openchamberx://session/abc')).toBeNull();
    expect(parseDeepLink(`${BRAND_URL_SCHEME}x://session/abc`)).toBeNull();
    expect(parseDeepLink('openchamber-pocharlies://session/abc')).toBeNull();
    expect(parseDeepLink('myopenchamber://session/abc')).toBeNull();
  });
});

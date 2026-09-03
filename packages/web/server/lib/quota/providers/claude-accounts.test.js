import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  accountIdFromProviderId,
  buildAccountResult,
  fetchClaudeAccounts,
} from './claude-accounts.js';

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENCODE_CLAUDE_PROXY_URL;
  delete process.env.OPENCODE_CLAUDE_PROXY_PORT;
});

const stubAccounts = (data) => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data }) });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const account = (over = {}) => ({
  id: 'tercera',
  label: 'Work personal',
  default: false,
  identity: { email: 'd@cloudblue.com' },
  sharesLoginWith: [],
  sharesOrganizationWith: ['works-shared'],
  quota: {
    windows: {
      fiveHour: { utilization: 0.03, resetsAt: 1788303600000 },
      sevenDay: { utilization: 0.7, resetsAt: 1788228000000 },
    },
    organizationId: 'org-1',
    source: 'probe',
    fetchedAt: 1788286410837,
  },
  ...over,
});

describe('fetchClaudeAccounts', () => {
  it('reads the account roster from the plugin proxy', async () => {
    const fetchMock = stubAccounts([account()]);
    const accounts = await fetchClaudeAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].id).toBe('tercera');
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:8799/accounts');
  });

  it('honours an explicit proxy url', async () => {
    process.env.OPENCODE_CLAUDE_PROXY_URL = 'http://127.0.0.1:9001/';
    const fetchMock = stubAccounts([]);
    await fetchClaudeAccounts();
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:9001/accounts');
  });

  it('returns null when the plugin is not running', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(fetchClaudeAccounts()).resolves.toBeNull();
  });

  it('returns null on a non-2xx or an unusable body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    await expect(fetchClaudeAccounts()).resolves.toBeNull();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    await expect(fetchClaudeAccounts()).resolves.toBeNull();
  });

  it('returns null rather than throwing on a malformed port', async () => {
    process.env.OPENCODE_CLAUDE_PROXY_PORT = 'not-a-port';
    await expect(fetchClaudeAccounts()).resolves.toBeNull();
  });
});

describe('accountIdFromProviderId', () => {
  it('reads the account out of an account-scoped provider id', () => {
    expect(accountIdFromProviderId('claude-code-tercera')).toBe('tercera');
    expect(accountIdFromProviderId('claude-code-works-shared')).toBe('works-shared');
  });

  it('returns null for the bare provider id', () => {
    // The bare id is the default account; which account that is belongs to the
    // plugin, and guessing from the id would be a different answer.
    expect(accountIdFromProviderId('claude-code')).toBeNull();
    expect(accountIdFromProviderId('claude')).toBeNull();
    expect(accountIdFromProviderId(null)).toBeNull();
  });

  it('is not fooled by a trailing separator', () => {
    expect(accountIdFromProviderId('claude-code-')).toBeNull();
  });
});

describe('buildAccountResult', () => {
  it('converts utilization to percent and names the account', () => {
    const result = buildAccountResult(account());
    expect(result.providerName).toBe('Work personal · d@cloudblue.com');
    expect(result.usage.windows['5h'].usedPercent).toBe(3);
    expect(result.usage.windows['7d'].usedPercent).toBeCloseTo(70);
    expect(result.usage.windows['7d'].remainingPercent).toBeCloseTo(30);
    expect(result.usage.windows['5h'].resetAt).toBe(1788303600000);
  });

  it('reports the real duration of each window, not null', () => {
    // The plugin does not state durations, but the windows are Anthropic's and
    // their length is a property of the window. The roster path used to emit
    // `windowSeconds: null` on every row, which is what made the headline ranker
    // fall back to roster order between two accounts — see usageHeadline.ts.
    const { windows } = buildAccountResult({
      id: 'tercera',
      label: 'Work personal',
      quota: {
        windows: {
          fiveHour: { utilization: 0.44, resetsAt: 1788303600000 },
          sevenDay: { utilization: 0.7, resetsAt: 1788228000000 },
          opus: { utilization: 0.61, resetsAt: 1788228000000 },
        },
      },
    }).usage;

    expect(windows['5h'].windowSeconds).toBe(5 * 3600);
    expect(windows['7d'].windowSeconds).toBe(7 * 86400);
    expect(windows.opus.windowSeconds).toBe(7 * 86400);
  });

  it('carries who shares this subscription, so one pool is not read as two', () => {
    expect(buildAccountResult(account()).sharedWith).toEqual(['works-shared']);
    expect(buildAccountResult(account({ sharesOrganizationWith: [] })).sharedWith).toBeUndefined();
  });

  it('falls back to the id when the account has no label', () => {
    expect(buildAccountResult({ id: 'tercera', quota: {} }).providerName).toBe('tercera');
  });

  it('tolerates an account with no quota sampled yet', () => {
    const result = buildAccountResult({ id: 'x', label: 'X', quota: null });
    expect(result.usage.windows).toEqual({});
    expect(result.ok).toBe(true);
  });
});

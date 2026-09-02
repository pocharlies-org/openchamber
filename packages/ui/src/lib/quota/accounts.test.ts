import { describe, expect, test } from 'bun:test';

import {
  getQuotaAccountEntries,
  getQuotaAccountsOutsideGroups,
  groupQuotaAccountsByBudget,
  type QuotaAccountEntry,
} from './accounts';
import type { ProviderResult, QuotaProviderId, UsageWindow, UsageWindowsWithSharers } from '@/types';

/**
 * Reading the Claude accounts out of one provider result.
 *
 * Pure functions, not the dropdown: `renderToStaticMarkup` reads
 * `useSyncExternalStore`'s server snapshot, so a store `setState` from a test
 * never reaches a rendered hook. The grouping is what carries the correctness —
 * whether two logins on one organization appear as one budget or as two — and
 * the JSX around it is the same markup the model rows already use.
 */

const label = (value: string) => value;

const window = (usedPercent: number, resetAt: number | null = null): UsageWindow => ({
  usedPercent,
  remainingPercent: 100 - usedPercent,
  windowSeconds: null,
  resetAfterSeconds: null,
  resetAt,
  resetAtFormatted: null,
  resetAfterFormatted: null,
});

const result = (
  providerId: QuotaProviderId,
  models?: Record<string, UsageWindowsWithSharers>,
): ProviderResult => ({
  providerId,
  providerName: 'Claude',
  ok: true,
  configured: true,
  usage: { windows: { '5h': window(3) }, ...(models ? { models } : {}) },
  fetchedAt: 0,
});

const account = (id: string, over: Partial<QuotaAccountEntry> = {}): QuotaAccountEntry => ({
  id,
  name: id,
  label: '5-Hour',
  window: window(10),
  ...over,
});

describe('getQuotaAccountEntries', () => {
  test('reads the accounts of a Claude result', () => {
    const entries = getQuotaAccountEntries(
      result('claude', {
        'Work personal · d@cloudblue.com': { windows: { '5h': window(3) } },
        'Works Shared · d.s@cloudblue.com': { windows: { '5h': window(5) } },
      }),
      label,
    );
    expect(entries.map((entry) => entry.id)).toEqual([
      'Work personal · d@cloudblue.com',
      'Works Shared · d.s@cloudblue.com',
    ]);
    // The label the operator chose, not the whole identity line.
    expect(entries[0].name).toBe('Work personal');
  });

  test('reports nothing for a provider that bills per model', () => {
    // Google fills `models` with models. Reading them as accounts would print a
    // model name where a subscription name belongs.
    expect(getQuotaAccountEntries(result('google', { 'gemini/gemini-3': { windows: { daily: window(1) } } }), label))
      .toEqual([]);
    expect(getQuotaAccountEntries(undefined, label)).toEqual([]);
    expect(getQuotaAccountEntries(result('claude'), label)).toEqual([]);
  });

  test('prefers the shortest window, so the row answers the next turn', () => {
    const [entry] = getQuotaAccountEntries(result('claude', {
      'Personal': { windows: { '7d': window(70), '5h': window(25) } },
    }), label);
    expect(entry.window.usedPercent).toBe(25);
  });

  test('skips an account with no window sampled', () => {
    expect(getQuotaAccountEntries(result('claude', { Personal: { windows: {} } }), label)).toEqual([]);
  });

  test('carries sharedWith through', () => {
    const [entry] = getQuotaAccountEntries(result('claude', {
      'Work personal': { windows: { '5h': window(3) }, sharedWith: ['works-shared'] },
    }), label);
    expect(entry.sharedWith).toEqual(['works-shared']);
  });
});

describe('groupQuotaAccountsByBudget', () => {
  test('says nothing when every account is its own budget', () => {
    // Three separate subscriptions need no explanation; a collapsible around
    // rows that each own their budget would hide numbers for no gain.
    expect(groupQuotaAccountsByBudget([account('a'), account('b')])).toEqual([]);
  });

  test('groups accounts that share one budget under the one in use', () => {
    const families = groupQuotaAccountsByBudget([
      account('Work personal', { sharedWith: ['Works Shared'] }),
      account('Works Shared', { sharedWith: ['Work personal'] }),
    ]);
    expect(families).toHaveLength(1);
    expect(families[0].familyLabel).toBe('Work personal');
    expect(families[0].accounts.map((entry) => entry.id)).toEqual(['Work personal', 'Works Shared']);
  });

  test('does not produce two groups for one budget when sharing is asymmetric', () => {
    // The plugin's own roster can be asymmetric mid-refresh. Two groups would
    // put the same pool on screen twice, which is the bug in the first place.
    const families = groupQuotaAccountsByBudget([
      account('a', { sharedWith: ['b'] }),
      account('b'),
      account('c', { sharedWith: ['a'] }),
    ]);
    expect(families).toHaveLength(1);
    expect(families[0].accounts.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
  });

  test('leaves unshared accounts out of the groups', () => {
    const families = groupQuotaAccountsByBudget([
      account('a', { sharedWith: ['b'] }),
      account('b', { sharedWith: ['a'] }),
      account('solo'),
    ]);
    expect(families).toHaveLength(1);
    expect(families[0].accounts.map((entry) => entry.id)).toEqual(['a', 'b']);
  });
});

describe('getQuotaAccountsOutsideGroups', () => {
  test('shows every account as a row when nothing is grouped', () => {
    const accounts = [account('a'), account('b')];
    expect(getQuotaAccountsOutsideGroups(accounts, []).map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  test('shows only the unshared ones once something is grouped', () => {
    const accounts = [
      account('a', { sharedWith: ['b'] }),
      account('b', { sharedWith: ['a'] }),
      account('solo'),
    ];
    const families = groupQuotaAccountsByBudget(accounts);
    expect(getQuotaAccountsOutsideGroups(accounts, families).map((entry) => entry.id)).toEqual(['solo']);
  });

  test('never shows an account twice', () => {
    const accounts = [
      account('a', { sharedWith: ['b'] }),
      account('b', { sharedWith: ['a'] }),
      account('solo'),
    ];
    const families = groupQuotaAccountsByBudget(accounts);
    const rows = getQuotaAccountsOutsideGroups(accounts, families);
    const ids = [...families.flatMap((f) => f.accounts), ...rows].map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(3);
  });
});

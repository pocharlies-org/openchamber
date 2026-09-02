import { describe, expect, it } from 'vitest';

import { buildMultiAccountResult, dedupeSharedAccounts } from './claude-accounts.js';
import { resolveUnattributedQuota } from './claude.js';

/**
 * What the plain `GET /api/quota/claude` says when several Claude subscriptions
 * are connected.
 *
 * The shape is the whole point, so it is asserted directly: one result per
 * providerId, accounts inside `usage.models`. Every consumer reads results
 * keyed by providerId — eight of them do `results.find(r => r.providerId === id)`
 * — so a second `claude` result would be dropped by all of them, silently, and
 * the panel would show one account and call it the machine's quota.
 */

const account = (id, over = {}) => ({
  id,
  label: id,
  sessions: 0,
  identity: { email: `${id}@example.com` },
  sharesLoginWith: [],
  sharesOrganizationWith: [],
  quota: {
    windows: {
      fiveHour: { utilization: 0.1, resetsAt: 1788303600000 },
      sevenDay: { utilization: 0.2, resetsAt: 1788638400000 },
    },
  },
  ...over,
});

const windows = (fiveHour, sevenDay) => ({
  windows: {
    fiveHour: { utilization: fiveHour, resetsAt: 1788303600000 },
    sevenDay: { utilization: sevenDay, resetsAt: 1788638400000 },
  },
});

describe('dedupeSharedAccounts', () => {
  it('keeps accounts that are separate subscriptions', () => {
    const accounts = [account('personal'), account('tercera')];
    expect(dedupeSharedAccounts(accounts).map((a) => a.id)).toEqual(['personal', 'tercera']);
  });

  it('collapses two seats on one organization into one entry', () => {
    // Measured on the live roster: tercera and works-shared are two logins on
    // organization 580bdb5d-…, i.e. two keys to ONE budget.
    const accounts = [
      account('tercera', { sharesOrganizationWith: ['works-shared'] }),
      account('works-shared', { sharesOrganizationWith: ['tercera'] }),
    ];
    expect(dedupeSharedAccounts(accounts).map((a) => a.id)).toEqual(['tercera']);
  });

  it('collapses the same login held twice', () => {
    const accounts = [
      account('personal', { sharesLoginWith: ['work'] }),
      account('work', { sharesLoginWith: ['personal'] }),
    ];
    expect(dedupeSharedAccounts(accounts).map((a) => a.id)).toEqual(['personal']);
  });

  it('represents a shared pool by the account actually in use', () => {
    // The roster order is the plugin's registry order and says nothing about
    // which seat is live; showing the idle one would hide the number that
    // matters.
    const accounts = [
      account('works-shared', { sessions: 4, sharesOrganizationWith: ['tercera'] }),
      account('tercera', { sessions: 29, sharesOrganizationWith: ['works-shared'] }),
    ];
    expect(dedupeSharedAccounts(accounts).map((a) => a.id)).toEqual(['tercera']);
  });

  it('is stable when neither account has been used', () => {
    const accounts = [
      account('tercera', { sharesOrganizationWith: ['works-shared'] }),
      account('works-shared', { sharesOrganizationWith: ['tercera'] }),
    ];
    expect(dedupeSharedAccounts(accounts).map((a) => a.id)).toEqual(['tercera']);
  });

  it('tolerates a roster with no sharing information at all', () => {
    const bare = [{ id: 'a' }, { id: 'b' }];
    expect(dedupeSharedAccounts(bare).map((a) => a.id)).toEqual(['a', 'b']);
    expect(dedupeSharedAccounts(null)).toEqual([]);
  });
});

describe('buildMultiAccountResult', () => {
  it('returns one result for the provider, with the accounts inside models', () => {
    const result = buildMultiAccountResult([account('personal'), account('tercera')]);
    expect(result.providerId).toBe('claude');
    expect(result.providerName).toBe('Claude');
    expect(result.ok).toBe(true);
    expect(Object.keys(result.usage.models)).toEqual([
      'personal · personal@example.com',
      'tercera · tercera@example.com',
    ]);
  });

  it('never emits one result per account', () => {
    // The regression this pins down: N results with providerId 'claude' would
    // make `results.find(r => r.providerId === 'claude')` answer with the first
    // and drop the rest, on every surface, without an error anywhere.
    const result = buildMultiAccountResult([account('a'), account('b'), account('c')]);
    expect(Array.isArray(result)).toBe(false);
    expect(result.providerId).toBe('claude');
  });

  it('carries sharedWith so one budget is not read as two', () => {
    // buildResult picks its fields by name and drops extras, so this is the
    // assertion that catches the field being lost on the way out.
    const result = buildMultiAccountResult([
      account('tercera', { label: 'Work personal', sharesOrganizationWith: ['works-shared'] }),
      account('works-shared', { label: 'Works Shared', sharesOrganizationWith: ['tercera'] }),
    ]);
    const entry = Object.values(result.usage.models)[0];
    // The operator's label, not the plugin's internal id: the field exists to be
    // read at a glance.
    expect(entry.sharedWith).toEqual(['Works Shared']);
  });

  it('does not report an account as sharing with itself', () => {
    const result = buildMultiAccountResult([
      account('tercera', { label: 'Work personal', sharesLoginWith: ['tercera'] }),
    ]);
    expect(Object.values(result.usage.models)[0].sharedWith).toBeUndefined();
  });

  it('falls back to the id when the sharer is not in the roster', () => {
    const result = buildMultiAccountResult([
      account('tercera', { sharesOrganizationWith: ['removed-last-week'] }),
    ]);
    expect(Object.values(result.usage.models)[0].sharedWith).toEqual(['removed-last-week']);
  });

  it('puts the tightest reading of each window at provider level', () => {
    const result = buildMultiAccountResult([
      account('quiet', { quota: windows(0.03, 0) }),
      account('busy', { quota: windows(0.78, 0.9) }),
    ]);
    // Per label, not one label: a 7-day reading must never land on the 5-hour
    // line. And it is only ever a maximum — it answers "can I keep working
    // right now", not "what is left in total".
    expect(result.usage.windows['5h'].usedPercent).toBeCloseTo(78);
    expect(result.usage.windows['7d'].usedPercent).toBeCloseTo(90);
  });

  it('does not mix one account reset time into another window', () => {
    const result = buildMultiAccountResult([
      account('a', { quota: { windows: { fiveHour: { utilization: 0.5, resetsAt: 111 } } } }),
      account('b', { quota: { windows: { sevenDay: { utilization: 0.6, resetsAt: 222 } } } }),
    ]);
    expect(result.usage.windows['5h'].resetAt).toBe(111);
    expect(result.usage.windows['7d'].resetAt).toBe(222);
  });

  it('leaves the provider-level line out when no account reports a percentage', () => {
    const result = buildMultiAccountResult([
      account('a', { quota: { windows: { fiveHour: { utilization: null } } } }),
    ]);
    expect(result.usage.windows).toEqual({});
    expect(result.usage.models['a · a@example.com']).toBeDefined();
  });

  it('returns null rather than an empty panel', () => {
    // null is what tells the caller to keep the auth.json answer.
    expect(buildMultiAccountResult(null)).toBeNull();
    expect(buildMultiAccountResult([])).toBeNull();
    expect(buildMultiAccountResult([{ id: 'a', label: 'A', quota: null }])).toBeNull();
  });

  it('survives an account with no label and no identity', () => {
    const result = buildMultiAccountResult([{ id: 'tercera', quota: windows(0.1, 0.2) }]);
    expect(Object.keys(result.usage.models)).toEqual(['tercera']);
  });
});

describe('resolveUnattributedQuota', () => {
  const authJsonQuota = {
    providerId: 'claude',
    providerName: 'Claude',
    ok: true,
    configured: true,
    usage: { windows: { '5h': { usedPercent: 42 } } },
    fetchedAt: 0,
  };

  it('prefers the roster when the plugin is reachable', () => {
    const result = resolveUnattributedQuota({ accounts: [account('personal')], authJsonQuota });
    expect(result.usage.models).toBeDefined();
  });

  it('keeps the auth.json answer when the plugin is not running', () => {
    // The single-account install is the common case. It must not regress to an
    // empty panel because a plugin it does not use is absent.
    expect(resolveUnattributedQuota({ accounts: null, authJsonQuota })).toBe(authJsonQuota);
  });

  it('keeps the auth.json answer for an empty or unsampled roster', () => {
    expect(resolveUnattributedQuota({ accounts: [], authJsonQuota })).toBe(authJsonQuota);
    expect(resolveUnattributedQuota({ accounts: [{ id: 'a', quota: null }], authJsonQuota }))
      .toBe(authJsonQuota);
  });
});

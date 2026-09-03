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

  it('leaves the provider-level windows out when two budgets report', () => {
    // The defect this pins down. It used to be asserted the other way round —
    // "the tightest reading of each window goes at provider level" — and that
    // assertion was the bug's own justification written as a test. Claude bills
    // per subscription; there is no provider-level budget for the number to
    // describe, and six surfaces print whatever lands here under a heading that
    // says "Claude".
    //
    // Measured live: Personal 5h 44% / 7d 11%, Works Shared 5h 5% / 7d 70%. The
    // field said 5h 44% and 7d 70% — Personal's 5-hour beside Works Shared's
    // 7-day, under one anonymous name, neither of them attributed.
    const result = buildMultiAccountResult([
      account('personal', { quota: windows(0.44, 0.11) }),
      account('works-shared', { quota: windows(0.05, 0.7) }),
    ]);
    expect(result.usage.windows).toEqual({});
    // The accounts are still there, named — that is where the numbers live now.
    expect(Object.keys(result.usage.models)).toEqual([
      'personal · personal@example.com',
      'works-shared · works-shared@example.com',
    ]);
    expect(result.usage.models['personal · personal@example.com'].windows['5h'].usedPercent)
      .toBeCloseTo(44);
    expect(result.usage.models['works-shared · works-shared@example.com'].windows['5h'].usedPercent)
      .toBeCloseTo(5);
  });

  it('reports the account numbers as the provider-level line for one subscription', () => {
    // The single-account machine, and the reason the field is not simply gone:
    // with one subscription, its numbers *are* the provider's. Byte-for-byte the
    // values the auth.json path would have produced.
    const result = buildMultiAccountResult([account('personal', { quota: windows(0.44, 0.7) })]);
    expect(result.usage.windows['5h'].usedPercent).toBeCloseTo(44);
    expect(result.usage.windows['7d'].usedPercent).toBeCloseTo(70);
    expect(result.usage.windows['5h'].resetAt).toBe(1788303600000);
    expect(result.usage.windows['7d'].resetAt).toBe(1788638400000);
    expect(result.usage.models).toBeDefined();
  });

  it('keeps the provider-level line when the second login shares the first budget', () => {
    // Two logins, one subscription: `dedupeSharedAccounts` keeps the seat that
    // reported windows, and the other is named in `sharedWith`. Counting rows
    // would call this a multi-account machine and take away the provider-level
    // number from a machine that has exactly one budget.
    const result = buildMultiAccountResult([
      account('tercera', { label: 'Work personal', sharesOrganizationWith: ['works-shared'], quota: windows(0.03, 0.7) }),
      account('works-shared', { label: 'Works Shared', sharesOrganizationWith: ['tercera'], quota: null }),
    ]);
    expect(Object.keys(result.usage.models)).toEqual(['Work personal · tercera@example.com']);
    expect(result.usage.windows['5h'].usedPercent).toBeCloseTo(3);
    expect(result.usage.windows['7d'].usedPercent).toBeCloseTo(70);
  });

  it('does not mix one account reset time into another window', () => {
    // The assertion that used to prove the per-label maximum was assembled
    // correctly. With two budgets there is no provider-level window to assemble,
    // so the same fixtures now prove the windows stay with the account they
    // belong to — which is where the reset time was always from.
    const result = buildMultiAccountResult([
      account('a', { quota: { windows: { fiveHour: { utilization: 0.5, resetsAt: 111 } } } }),
      account('b', { quota: { windows: { sevenDay: { utilization: 0.6, resetsAt: 222 } } } }),
    ]);
    expect(result.usage.windows).toEqual({});
    expect(result.usage.models['a · a@example.com'].windows['5h'].resetAt).toBe(111);
    expect(result.usage.models['b · b@example.com'].windows['7d'].resetAt).toBe(222);
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

  it('reports one plugin account as the provider, not the auth.json pool', () => {
    // The single-account guarantee, end to end through the source choice: the
    // plugin's account numbers land in `usage.windows`, which is what the six
    // surfaces that never look at `models` read. If the provider-level line were
    // left empty here, a single-subscription machine would show no number at all
    // on those surfaces — a regression dressed up as a correctness fix.
    const result = resolveUnattributedQuota({
      accounts: [account('personal', { label: 'Personal', quota: windows(0.44, 0.7) })],
      authJsonQuota,
    });
    expect(result.providerName).toBe('Claude');
    expect(result.usage.windows['5h'].usedPercent).toBeCloseTo(44);
    expect(result.usage.windows['7d'].usedPercent).toBeCloseTo(70);
  });

  it('leaves the provider-level line empty once a second budget reports', () => {
    // Same entry point, two budgets: the accounts are the readout.
    const result = resolveUnattributedQuota({
      accounts: [account('personal', { quota: windows(0.44, 0.11) }), account('tercera', { quota: windows(0.05, 0.7) })],
      authJsonQuota,
    });
    expect(result.usage.windows).toEqual({});
    expect(Object.keys(result.usage.models)).toHaveLength(2);
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

import { describe, expect, test } from 'bun:test';
import { pickUsageHeadline, resolveUsageHeadlineSummary, resolveQuotaProviderId } from './usageHeadline';
import { buildUsageProviderGroups } from '@/components/usage/usageGroups';
import { formatQuotaValueLabel } from '@/lib/quota';
import type { ProviderResult, QuotaProviderId, UsageWindow } from '@/types';
import type { UsageProviderGroup } from '@/components/usage/usageGroups';

const HOUR = 3600;

const window = (windowSeconds: number | null) => ({
  usedPercent: 10,
  remainingPercent: 90,
  windowSeconds,
  resetAfterSeconds: null,
  resetAt: null,
  resetAtFormatted: null,
  resetAfterFormatted: null,
});

const group = (providerId: string, rows: Array<{ key: string; label: string; subtitle?: string; seconds: number | null }>): UsageProviderGroup => ({
  providerId: providerId as UsageProviderGroup['providerId'],
  providerName: providerId,
  status: null,
  rows: rows.map((row) => ({
    key: row.key,
    label: row.label,
    subtitle: row.subtitle,
    window: window(row.seconds),
  })),
});

describe('resolveQuotaProviderId', () => {
  test('passes through ids that already match a quota provider', () => {
    expect(resolveQuotaProviderId('opencode-go')).toBe('opencode-go');
  });

  test('maps the known divergences', () => {
    expect(resolveQuotaProviderId('openai')).toBe('codex');
    expect(resolveQuotaProviderId('anthropic')).toBe('claude');
  });

  test('is case and whitespace tolerant, and rejects empties', () => {
    expect(resolveQuotaProviderId('  OpenAI ')).toBe('codex');
    expect(resolveQuotaProviderId('')).toBeNull();
    expect(resolveQuotaProviderId(null)).toBeNull();
  });
});

describe('pickUsageHeadline', () => {
  const groups = [
    group('codex', [{ key: 'w', label: 'Weekly Limit', seconds: 7 * 24 * HOUR }]),
    group('opencode-go', [
      { key: 'm', label: 'Monthly Limit', seconds: 30 * 24 * HOUR },
      { key: 'h', label: '5-Hour', seconds: 5 * HOUR },
      { key: 'w', label: 'Weekly Limit', seconds: 7 * 24 * HOUR },
    ]),
  ];

  test('picks the shortest window of the matching provider', () => {
    // The tightest bucket is the one that decides whether the next turn lands.
    expect(pickUsageHeadline(groups, 'opencode-go')?.row.label).toBe('5-Hour');
  });

  test('resolves the provider through the alias table', () => {
    expect(pickUsageHeadline(groups, 'openai')?.group.providerId).toBe('codex');
  });

  test('returns null when no group matches the composer provider', () => {
    // Showing another provider's quota would read as the active one.
    expect(pickUsageHeadline(groups, 'mistral')).toBeNull();
    expect(pickUsageHeadline(groups, null)).toBeNull();
  });

  test('ignores model-scoped rows while any provider-level row exists', () => {
    const scoped = [group('zai-coding-plan', [
      { key: 'model', label: '5-Hour', subtitle: 'GLM-5', seconds: 5 * HOUR },
      { key: 'provider', label: 'Weekly Limit', seconds: 7 * 24 * HOUR },
    ])];
    expect(pickUsageHeadline(scoped, 'zai-coding-plan')?.row.label).toBe('Weekly Limit');
  });

  test('falls back to a durationless row when nothing reports a window', () => {
    const balances = [group('codex', [{ key: 'credits', label: 'Credits Balance', seconds: null }])];
    expect(pickUsageHeadline(balances, 'codex')?.row.label).toBe('Credits Balance');
  });

  test('prefers any real window over a durationless row', () => {
    const mixed = [group('codex', [
      { key: 'credits', label: 'Credits Balance', seconds: null },
      { key: 'w', label: 'Weekly Limit', seconds: 7 * 24 * HOUR },
    ])];
    expect(pickUsageHeadline(mixed, 'codex')?.row.label).toBe('Weekly Limit');
  });

  test('returns null for a matched provider that reported no rows', () => {
    expect(pickUsageHeadline([group('codex', [])], 'codex')).toBeNull();
  });
});

/**
 * What the collapsed Usage header may say.
 *
 * `pickUsageHeadline` chooses the row; `resolveUsageHeadlineSummary` decides
 * whether that row's number may sit under the provider's heading unattributed.
 * They are separate because the row choice was already right — the defect was
 * the summary rendering `label` + percent and dropping the account that makes
 * the number mean something.
 *
 * Fixtures go through `buildUsageProviderGroups`, the grouping the panel itself
 * renders through, so a row that changes shape is caught here and not only in
 * the browser.
 */
describe('resolveUsageHeadlineSummary', () => {
  const window = (usedPercent: number | null): UsageWindow => ({
    usedPercent,
    remainingPercent: usedPercent === null ? null : 100 - usedPercent,
    windowSeconds: null,
    resetAfterSeconds: null,
    resetAt: null,
    resetAtFormatted: null,
    resetAfterFormatted: null,
  });

  /**
   * What `GET /api/quota/claude` answers with several subscriptions connected:
   * one entry per account under `models`, and nothing at provider level. The
   * windows used to carry the max across the accounts there — measured live, 5h
   * 44% from Personal beside 7d 70% from Works Shared, under one anonymous
   * "Claude". The server no longer invents that number, and this fixture is its
   * shape rather than a guess at it.
   */
  const claudeRoster = (): ProviderResult => ({
    providerId: 'claude' as QuotaProviderId,
    providerName: 'Claude',
    ok: true,
    configured: true,
    fetchedAt: 0,
    usage: {
      windows: {},
      models: {
        'Works Shared · d.s@cloudblue.com': { windows: { '5h': window(5), '7d': window(70) }, sharedWith: ['Work personal'] },
        'Personal · me@e-dani.com': { windows: { '5h': window(44), '7d': window(11) }, sharedWith: ['work'] },
      },
    },
  });

  const groupsFrom = (result: ProviderResult): UsageProviderGroup[] => buildUsageProviderGroups({
    results: [result],
    dropdownProviderIds: ['claude' as QuotaProviderId],
    selectedModels: {},
    activeQuotaProviderId: 'claude' as QuotaProviderId,
    noRateLimitsLabel: 'No rate limits reported.',
  });

  /** Exactly what `WorkStatusUsageSection` computes for its collapsed header. */
  const summaryFor = (
    result: ProviderResult,
    options: { modeLabel?: string; hasRoomForAccountLabel?: boolean } = {},
  ) => {
    const headline = pickUsageHeadline(groupsFrom(result), 'anthropic');
    const percent = headline?.row.window.usedPercent ?? null;
    return resolveUsageHeadlineSummary(headline, {
      metric: headline ? (headline.row.window.valueLabel ?? formatQuotaValueLabel(null, percent)) : null,
      modeLabel: options.modeLabel ?? 'Used',
      hasRoomForAccountLabel: options.hasRoomForAccountLabel,
    });
  };

  test('never shows an account number as the provider\'s', () => {
    // The regression, stated as the invariant the panel must hold: with several
    // subscriptions connected the header may show a provider-level number, or no
    // number at all — never a number that belongs to one of them.
    //
    // This assertion used to read `{ kind: 'provider', label: '5-Hour', metric:
    // '44%' }`, because the server then put the cross-account maximum in
    // `usage.windows` and a provider-level row existed to be found. That row was
    // the bug: 44% was Personal's 5-hour and the 7d beside it was Works Shared's,
    // printed under a heading that says "Claude". The server stopped inventing
    // the number, so the header now resolves to an account row instead.
    const summary = summaryFor(claudeRoster());
    expect(summary.kind).not.toBe('provider');
    // Which account, and what for: `pickUsageHeadline` prefers the shortest
    // window, and both subscriptions report a 5-hour, so the first row wins —
    // Works Shared at 5%, now printed with the name that owns it. The headline
    // is no longer the tightest number on the machine; that is the honest cost
    // of the number having never been a provider statistic.
    expect(summary).toEqual({
      kind: 'account',
      label: '5-Hour',
      metric: '5%',
      account: 'Works Shared',
    });
  });

  test('names the account when the number is one account\'s', () => {
    // Same machine, provider-level line gone (an account sampled a window the
    // others did not): the only rows left are per-account.
    const summary = summaryFor({
      ...claudeRoster(),
      usage: {
        windows: {},
        models: {
          'Personal · me@e-dani.com': { windows: { '5h': window(44) }, sharedWith: ['work'] },
          'Works Shared · d.s@cloudblue.com': { windows: { '5h': window(5) }, sharedWith: ['Work personal'] },
        },
      },
    });
    expect(summary).toEqual({
      kind: 'account',
      label: '5-Hour',
      metric: '44%',
      account: 'Personal',
    });
    // The shared-budget note belongs to the expanded list; a header with a few
    // characters for it cannot carry it, and it makes the name unreadable.
    expect('account' in summary ? summary.account : '').not.toContain('budget');
  });

  test('drops the number rather than the attribution where the name cannot fit', () => {
    // The compact surfaces share these rows. An absent number beats a
    // misattributed one.
    const summary = summaryFor(
      {
        ...claudeRoster(),
        usage: { windows: {}, models: { 'Personal · me@e-dani.com': { windows: { '5h': window(44) } } } },
      },
      { modeLabel: 'Used', hasRoomForAccountLabel: false },
    );
    expect(summary).toEqual({ kind: 'mode', label: 'Used' });
  });

  test('leaves a single account reading exactly as before', () => {
    // One subscription, plugin present: the server puts that account's numbers in
    // the provider-level windows, because they *are* the provider's. No spurious
    // account suffix on this surface, and no number missing either.
    const summary = summaryFor({
      ...claudeRoster(),
      usage: { windows: { '5h': window(44), '7d': window(70) } },
    });
    expect(summary).toEqual({ kind: 'provider', label: '5-Hour', metric: '44%' });
  });

  test('leaves a single account reading as the provider when the roster is reported', () => {
    // The same machine through the roster path rather than auth.json: one
    // account, provider-level windows filled, and the `models` entry beside
    // them. The provider row wins over the account row, so the header does not
    // start naming an account on a machine that has only one.
    const summary = summaryFor({
      ...claudeRoster(),
      usage: {
        windows: { '5h': window(44), '7d': window(70) },
        models: { 'Personal · me@e-dani.com': { windows: { '5h': window(44), '7d': window(70) } } },
      },
    });
    expect(summary).toEqual({ kind: 'provider', label: '5-Hour', metric: '44%' });
  });

  test('leaves the auth.json answer untouched when the plugin is absent', () => {
    // No plugin, no roster: `resolveUnattributedQuota` keeps the auth.json
    // result, which has no `models` at all. Same readout as before the change.
    const summary = summaryFor({
      providerId: 'claude' as QuotaProviderId,
      providerName: 'Claude',
      ok: true,
      configured: true,
      fetchedAt: 0,
      usage: { windows: { '5h': window(42) } },
    });
    expect(summary).toEqual({ kind: 'provider', label: '5-Hour', metric: '42%' });
  });

  test('leaves a per-model row of a per-model provider reading as the provider\'s', () => {
    // Google fills `models` with models, not subscriptions. Its subtitle is a
    // model name; the quota is the provider's and must not gain an account tag.
    const groups = buildUsageProviderGroups({
      results: [{
        providerId: 'google' as QuotaProviderId,
        providerName: 'Google',
        ok: true,
        configured: true,
        fetchedAt: 0,
        usage: { windows: {}, models: { 'gemini/gemini-3': { windows: { daily: window(30) } } } },
      }],
      dropdownProviderIds: ['google' as QuotaProviderId],
      selectedModels: {},
      activeQuotaProviderId: 'google' as QuotaProviderId,
      noRateLimitsLabel: 'No rate limits reported.',
    });
    const headline = pickUsageHeadline(groups, 'gemini');
    expect(headline?.row.subtitle).toBe('gemini-3');
    // A per-model row has no account to name, so it can never take the
    // account branch of the summary.
    expect(headline?.row.account).toBe(undefined);
    expect(resolveUsageHeadlineSummary(headline, { metric: '30%', modeLabel: 'Used' }))
      .toEqual({ kind: 'provider', label: headline?.row.label ?? '', metric: '30%' });
  });

  test('drops the number when a provider-level row carries no percentage', () => {
    // The shape the server produces for an unsampled window on a single-account
    // machine: a provider-level row with no number. The header must show the
    // mode word, not a blank where a percentage was.
    const groups = groupsFrom({
      ...claudeRoster(),
      usage: { windows: { '5h': window(null) } },
    });
    const headline = pickUsageHeadline(groups, 'anthropic');
    expect(resolveUsageHeadlineSummary(headline, { metric: '-', modeLabel: 'Remaining' }))
      .toEqual({ kind: 'mode', label: 'Remaining' });
    expect(resolveUsageHeadlineSummary(null, { metric: null, modeLabel: 'Remaining' }))
      .toEqual({ kind: 'mode', label: 'Remaining' });
  });

  test('shows no number, and no provider claim, when a multi-account machine reports nothing', () => {
    // Configured, plugin up, no window sampled for anybody. The section says
    // "nothing reported" and the header shows the display-mode word — it does
    // not invent a figure and does not claim one for the provider.
    const groups = groupsFrom({
      ...claudeRoster(),
      usage: { windows: {}, models: {} },
    });
    expect(groups[0].status).toBe('No rate limits reported.');
    const headline = pickUsageHeadline(groups, 'anthropic');
    expect(headline).toBeNull();
    expect(resolveUsageHeadlineSummary(headline, { metric: null, modeLabel: 'Used' }))
      .toEqual({ kind: 'mode', label: 'Used' });
  });

  test('never resolves an unattributed provider row for a multi-account machine', () => {
    // The invariant, checked over every ordering of the two subscriptions and
    // both display modes, rather than over one fixture. Any of these producing
    // `kind: 'provider'` would put one account's percentage under the heading
    // "Claude", which is the defect the server change removed the source of.
    const personal = { windows: { '5h': window(44), '7d': window(11) }, sharedWith: ['work'] };
    const worksShared = { windows: { '5h': window(5), '7d': window(70) }, sharedWith: ['Work personal'] };
    // A third subscription reporting only a window the others do not — the
    // ordering case where a per-label maximum used to reach the header.
    const opus: { windows: Record<string, UsageWindow>; sharedWith?: string[] } =
      { windows: { opus: window(61) } };

    for (const [a, b] of [[personal, worksShared], [worksShared, personal]]) {
      for (const extra of [undefined, opus]) {
        const models: Record<string, { windows: Record<string, UsageWindow>; sharedWith?: string[] }> = {
          'Personal · me@e-dani.com': a,
          'Works Shared · d.s@cloudblue.com': b,
        };
        if (extra) models['Work personal · d@cloudblue.com'] = extra;
        const result: ProviderResult = {
          ...claudeRoster(),
          usage: { windows: {}, models },
        };
        for (const used of [true, false]) {
          const groups = groupsFrom(result);
          const headline = pickUsageHeadline(groups, 'anthropic');
          const percent = used
            ? headline?.row.window.usedPercent ?? null
            : headline?.row.window.remainingPercent ?? null;
          const summary = resolveUsageHeadlineSummary(headline, {
            metric: headline ? formatQuotaValueLabel(null, percent) : null,
            modeLabel: 'Used',
            hasRoomForAccountLabel: true,
          });
          expect(summary.kind).not.toBe('provider');
          if (summary.kind === 'account') {
            // A named account is the only way a Claude number may appear here.
            expect(summary.account.length).toBeGreaterThan(0);
            expect(summary.account).not.toContain('·');
          }
        }
      }
    }
  });
});

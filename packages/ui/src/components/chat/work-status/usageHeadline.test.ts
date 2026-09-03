import { describe, expect, test } from 'bun:test';
import { pickUsageHeadline, resolveUsageHeadlineSummary, resolveQuotaProviderId } from './usageHeadline';
import { buildUsageProviderGroups } from '@/components/usage/usageGroups';
import { formatQuotaValueLabel } from '@/lib/quota';
import type { ProviderResult, QuotaProviderId, UsageWindow } from '@/types';
import type { UsageProviderGroup } from '@/components/usage/usageGroups';

const HOUR = 3600;

/** The durations Claude reports (`claudeWindowSeconds`), used by the Claude fixtures. */
const FIVE_HOURS = 5 * HOUR;
const SEVEN_DAYS = 7 * 24 * HOUR;

const window = (windowSeconds: number | null, usedPercent: number | null = 10) => ({
  usedPercent,
  remainingPercent: usedPercent === null ? null : 100 - usedPercent,
  windowSeconds,
  resetAfterSeconds: null,
  resetAt: null,
  resetAtFormatted: null,
  resetAfterFormatted: null,
});

const group = (
  providerId: string,
  rows: Array<{
    key: string;
    label: string;
    subtitle?: string;
    seconds: number | null;
    used?: number | null;
    /** Set on a per-subscription row — the `account` the summary prints with it. */
    account?: string;
  }>,
): UsageProviderGroup => ({
  providerId: providerId as UsageProviderGroup['providerId'],
  providerName: providerId,
  status: null,
  rows: rows.map((row) => ({
    key: row.key,
    label: row.label,
    subtitle: row.subtitle,
    account: row.account,
    window: window(row.seconds, row.used),
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

  /**
   * Two subscriptions, one row each, with no window duration anywhere — the
   * shape Claude emitted until the durations were reported, and still the shape
   * of any provider that genuinely does not name its window. The point is the
   * last-resort bucket: with nothing to rank on, the tie must go to usage and
   * never to roster order.
   */
  const claudePair = (
    first: { account: string; used: number | null },
    second: { account: string; used: number | null },
  ) => [group('claude', [
    { key: 'a', label: '5-Hour', seconds: null, used: first.used, account: first.account },
    { key: 'b', label: '5-Hour', seconds: null, used: second.used, account: second.account },
  ])];

  const tightest = { account: 'Personal', used: 86 };
  const loose = { account: 'Works Shared', used: 5 };

  test('ranks durationless Claude rows by usage, not by roster order', () => {
    // The defect: with no window durations anywhere, every Claude row landed in
    // the same bucket and the old `continue` handed the choice to array order —
    // a coin flip between an account at 5% and one at 86%. Both orderings must
    // answer the same question, "can I keep working right now".
    const rows = [claudePair(tightest, loose), claudePair(loose, tightest)];
    for (const [i, groups] of rows.entries()) {
      const picked = pickUsageHeadline(groups, 'anthropic');
      expect(picked?.row.account).toBe('Personal');
      expect(picked?.row.window.usedPercent).toBe(86);
      // Guard against the fixture collapsing: the two orderings are distinct.
      expect(groups[0].rows[i === 0 ? 0 : 1].account).toBe('Personal');
    }
  });

  test('a real window beats a durationless row even at lower usage', () => {
    // Key 1 is unconditional: the tightest last-resort row does not outrank a
    // real bucket, or a credit balance at 99% would headline over a 5-hour.
    const mixed = [group('claude', [
      { key: 'credits', label: 'Credits Balance', seconds: null, used: 99, account: 'Personal' },
      { key: 'h', label: '5-Hour', seconds: 5 * HOUR, used: 5 },
    ])];
    expect(pickUsageHeadline(mixed, 'claude')?.row.label).toBe('5-Hour');
    expect(pickUsageHeadline([...mixed].reverse(), 'claude')?.row.label).toBe('5-Hour');
  });

  test('within one real window, the tightest reading wins', () => {
    // Two subscriptions reporting the same real bucket: same tie, same rule.
    const same = [group('claude', [
      { key: 'loose', label: '5-Hour', seconds: 5 * HOUR, used: 5, account: 'Works Shared' },
      { key: 'tight', label: '5-Hour', seconds: 5 * HOUR, used: 86, account: 'Personal' },
    ])];
    for (const groups of [same, [...same].reverse()]) {
      expect(pickUsageHeadline(groups, 'claude')?.row.account).toBe('Personal');
    }
  });

  test('an unsampled window loses the tie to a numeric one', () => {
    // `usedPercent` is `number | null`, and a window nobody sampled is not a
    // free one — it must not headline over an account that is nearly out.
    const unsampled = [group('claude', [
      { key: 'unsampled', label: '5-Hour', seconds: null, used: null, account: 'Work personal' },
      { key: 'tight', label: '5-Hour', seconds: null, used: 86, account: 'Personal' },
    ])];
    for (const groups of [unsampled, [...unsampled].reverse()]) {
      expect(pickUsageHeadline(groups, 'claude')?.row.account).toBe('Personal');
    }
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
  const window = (usedPercent: number | null, windowSeconds: number | null = null): UsageWindow => ({
    usedPercent,
    remainingPercent: usedPercent === null ? null : 100 - usedPercent,
    windowSeconds,
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
   *
   * The durations are the real ones (`claude.js:121,128` and
   * `claude-accounts.js:51` now emit 18000 and 604800). Until then every Claude
   * row was durationless and this fixture could get the ranking right by
   * accident; with them, the fixture says what the endpoint says.
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
        'Works Shared · d.s@cloudblue.com': { windows: { '5h': window(5, FIVE_HOURS), '7d': window(70, SEVEN_DAYS) }, sharedWith: ['Work personal'] },
        'Personal · me@e-dani.com': { windows: { '5h': window(44, FIVE_HOURS), '7d': window(11, SEVEN_DAYS) }, sharedWith: ['work'] },
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
    // Which account, and what for: the 5-hour is the shortest window either
    // subscription reports, so it is the bucket that decides whether the next
    // turn lands, and within it Personal's 44% beats Works Shared's 5% — printed
    // with the name that owns it. Before the durations were reported every row
    // shared one durationless bucket and this tie fell to usage alone, which
    // happened to name the same account here; the invariant below is what the
    // test exists for and it holds either way.
    expect(summary).toEqual({
      kind: 'account',
      label: '5-Hour',
      metric: '44%',
      account: 'Personal',
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
          'Personal · me@e-dani.com': { windows: { '5h': window(44, FIVE_HOURS) }, sharedWith: ['work'] },
          'Works Shared · d.s@cloudblue.com': { windows: { '5h': window(5, FIVE_HOURS) }, sharedWith: ['Work personal'] },
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
        usage: { windows: {}, models: { 'Personal · me@e-dani.com': { windows: { '5h': window(44, FIVE_HOURS) } } } },
      },
      { modeLabel: 'Used', hasRoomForAccountLabel: false },
    );
    expect(summary).toEqual({ kind: 'mode', label: 'Used' });
  });

  test('leaves a single account reading exactly as before', () => {
    // One subscription, plugin present: the server puts that account's numbers in
    // the provider-level windows, because they *are* the provider's. No spurious
    // account suffix on this surface, and no number missing either.
    //
    // The number is the 5-hour at 44%: the two provider-level windows carry their
    // real durations (`claude.js:121,128`), so the shorter bucket wins and the
    // 7-day at 70% does not outrank it on usage. That is the whole point of
    // reporting the duration — while both were null the tie went to usage and
    // this header read `7-Day Limit / 70%`.
    const summary = summaryFor({
      ...claudeRoster(),
      usage: { windows: { '5h': window(44, FIVE_HOURS), '7d': window(70, SEVEN_DAYS) } },
    });
    expect(summary).toEqual({ kind: 'provider', label: '5-Hour', metric: '44%' });
  });

  test('leaves a single account reading as the provider when the roster is reported', () => {
    // The same machine through the roster path rather than auth.json: one
    // account, provider-level windows filled, and the `models` entry beside
    // them (`claude-accounts.js:320` fills both). The provider row wins over the
    // account row, so the header does not start naming an account on a machine
    // that has only one. Same shortest-window winner as the test above.
    const summary = summaryFor({
      ...claudeRoster(),
      usage: {
        windows: { '5h': window(44, FIVE_HOURS), '7d': window(70, SEVEN_DAYS) },
        models: { 'Personal · me@e-dani.com': { windows: { '5h': window(44, FIVE_HOURS), '7d': window(70, SEVEN_DAYS) } } },
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
      usage: { windows: { '5h': window(42, FIVE_HOURS) } },
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
    const personal = { windows: { '5h': window(44, FIVE_HOURS), '7d': window(11, SEVEN_DAYS) }, sharedWith: ['work'] };
    const worksShared = { windows: { '5h': window(5, FIVE_HOURS), '7d': window(70, SEVEN_DAYS) }, sharedWith: ['Work personal'] };
    // A third subscription reporting only a window the others do not — the
    // ordering case where a per-label maximum used to reach the header.
    const opus: { windows: Record<string, UsageWindow>; sharedWith?: string[] } =
      { windows: { opus: window(61, SEVEN_DAYS) } };

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

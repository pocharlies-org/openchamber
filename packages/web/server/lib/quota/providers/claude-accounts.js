/**
 * Per-account Claude quota, from the opencode-claude plugin's local proxy.
 *
 * Why this exists at all: the `claude` quota provider reads ONE token out of
 * opencode's auth.json, so with several Claude subscriptions it can only ever
 * report one pool, and it cannot say which. The plugin is the component that
 * owns those logins — it holds a credential per account, harvests quota headers
 * from traffic it already sends, and knows which accounts are in fact the same
 * subscription. Asking it is the only way to get an honest per-account number;
 * re-deriving one here would mean duplicating credential reading, token
 * rotation and the single-flight discipline that keeps two rotations of one
 * token from revoking the whole grant.
 *
 * The plugin is optional. Everything here fails closed to null, and the caller
 * keeps the auth.json path as the default.
 */
import { buildResult, toUsageWindow, toNumber } from '../utils/index.js';

export const providerId = 'claude';
export const providerName = 'Claude';

/** Same default the plugin's own panel uses; override for a non-standard port. */
const DEFAULT_PROXY_PORT = 8799;
const REQUEST_TIMEOUT_MS = 2500;

const proxyBaseUrl = () => {
  const configured = (process.env.OPENCODE_CLAUDE_PROXY_URL ?? '').trim();
  if (configured) return configured.replace(/\/+$/, '');
  const port = (process.env.OPENCODE_CLAUDE_PROXY_PORT ?? '').trim() || String(DEFAULT_PROXY_PORT);
  if (!/^\d+$/.test(port)) return null;
  return `http://127.0.0.1:${port}`;
};

const WINDOW_KEYS = [
  ['fiveHour', '5h'],
  ['sevenDay', '7d'],
  ['opus', 'opus'],
];

/**
 * The plugin reports utilization as 0..1; the quota UI speaks percent.
 */
const toWindows = (windows) => {
  const out = {};
  for (const [sourceKey, label] of WINDOW_KEYS) {
    const window = windows?.[sourceKey];
    if (!window) continue;
    const used = toNumber(window.utilization);
    out[label] = toUsageWindow({
      usedPercent: used === null ? null : used * 100,
      windowSeconds: null,
      resetAt: window.resetsAt ?? null,
    });
  }
  return out;
};

/**
 * Accounts from the proxy, or null when the plugin is absent or unhealthy.
 *
 * Deliberately does not throw: a plugin that is not running is the normal case
 * for anyone who does not use it, and an error here would surface in the Usage
 * panel as a fault the user cannot act on.
 */
export const fetchClaudeAccounts = async () => {
  const base = proxyBaseUrl();
  if (!base) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${base}/accounts`, {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => null);
    const accounts = Array.isArray(payload?.data) ? payload.data : null;
    if (!accounts) return null;
    return accounts;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * The account a session runs on, as the host names it.
 *
 * The plugin registers one provider per login — `claude-code` for the default,
 * `claude-code-<account>` for the rest — so the account is in the provider id.
 * Returns null for the bare id: that is the default account, and which one that
 * is is the plugin's answer, not something to infer from the id.
 */
export const accountIdFromProviderId = (modelProviderId) => {
  const normalized = (modelProviderId ?? '').trim().toLowerCase();
  if (!normalized.startsWith('claude-code-')) return null;
  const accountId = normalized.slice('claude-code-'.length);
  return accountId || null;
};

/**
 * One account's quota, shaped as a provider result so the existing UI reads it
 * unchanged.
 *
 * `providerName` carries the account — "Work personal · d@cloudblue.com" — because
 * that is the string the panel already prints as the provider heading. A second
 * field would have to be added to a type every usage surface consumes, for a
 * label only this provider produces.
 *
 * `sharedWith` is the answer to "is this really another subscription". Two
 * accounts on one organization are two keys to ONE pool: separate grants, one
 * budget. Printed without that, a dashboard showing 30% and 30% reads as two
 * thirds of a week remaining when it is one, and the operator rations the wrong
 * account. The plugin already computes it (`sharesLoginWith` for the same login
 * twice, `sharesOrganizationWith` for two seats on one org); this only forwards
 * it, mapped through `labelOf` so the panel prints the name the operator chose
 * rather than the plugin's internal id.
 *
 * Written out rather than spread into buildResult: buildResult picks its fields
 * by name and would silently drop anything extra.
 */
export const buildAccountResult = (account, { labelOf } = {}) => {
  const windows = toWindows(account?.quota?.windows);
  const label = (account?.label ?? '').trim() || account?.id || 'Claude';
  const email = (account?.identity?.email ?? '').trim();

  const sharedWith = [
    ...new Set(
      [
        ...(Array.isArray(account?.sharesLoginWith) ? account.sharesLoginWith : []),
        ...(Array.isArray(account?.sharesOrganizationWith) ? account.sharesOrganizationWith : []),
      ]
        // The account is not sharing with itself, whatever the roster says.
        .filter((id) => id && id !== account?.id)
        .map((id) => (typeof labelOf === 'function' ? labelOf(id) : id)),
    ),
  ];

  return {
    ...buildResult({
      providerId,
      providerName: email ? `${label} · ${email}` : label,
      ok: true,
      configured: true,
      usage: { windows },
    }),
    ...(sharedWith.length > 0 ? { sharedWith } : {}),
  };
};

/** Accounts that are one subscription: same login, or two seats on one organization. */
const sharesSubscription = (a, b) =>
  (Array.isArray(a?.sharesLoginWith) && a.sharesLoginWith.includes(b?.id))
  || (Array.isArray(a?.sharesOrganizationWith) && a.sharesOrganizationWith.includes(b?.id));

/**
 * The accounts worth printing, one entry per subscription rather than per login.
 *
 * Two keys to one organization are two names on ONE budget. Listing both is not
 * detail, it is a false total: 30% and 30% on screen reads as two-thirds of a
 * week remaining when it is one, and the operator rations the wrong account.
 * The duplicate keeps the label the roster gives it, so the name on screen is
 * the name in the plugin's own panel.
 *
 * A shared pool is represented by its most-used account, not by the first in
 * the roster: the roster's order is the plugin's registry order, which says
 * nothing about which of the two the operator actually works on, and a stale
 * seat would otherwise hide the live one. Ties fall back to roster order, so
 * two idle accounts still render the same way on every refresh.
 */
export const dedupeSharedAccounts = (accounts) => {
  const kept = [];
  for (const account of accounts ?? []) {
    const duplicateIndex = kept.findIndex((kept2) => sharesSubscription(kept2, account));
    if (duplicateIndex === -1) {
      kept.push(account);
      continue;
    }
    const incumbent = kept[duplicateIndex];
    if ((account?.sessions ?? 0) > (incumbent?.sessions ?? 0)) {
      kept[duplicateIndex] = account;
    }
  }
  return kept;
};

/**
 * Every connected account as ONE `claude` result.
 *
 * The roster is a fact about the machine, not about this session, so it is
 * reported as such: each account labelled, none of them claimed to be the one
 * the session runs on. Per-session attribution is not available — the session's
 * provider id falls back to a global config value, so it reports whatever was
 * last clicked elsewhere, and the plugin's own per-session table is keyed by a
 * hash of the first message that openchamber never sends. A confident wrong
 * number is worse than none, so the readout stays plural and unattributed.
 *
 * One result per providerId, with the accounts inside `usage.models`, because
 * every consumer reads results keyed by providerId — eight of them do
 * `results.find(r => r.providerId === id)`, which keeps the first match and
 * would silently drop the second account. `models` is the mechanism the UI
 * already has for a per-something breakdown (Google fills it per model), so the
 * accounts arrive labelled on the surfaces that render it, and the surfaces
 * that only read `usage.windows` keep showing the provider-level line they
 * already show.
 *
 * `usage.windows` carries, per window label, the tightest reading across the
 * accounts — the 5-hour line is the tightest 5-hour, the 7-day line the tightest
 * 7-day. That is the pair that answers "can I keep working right now". It is a
 * maximum, and only ever a maximum: it does not claim to be a remaining total,
 * and it belongs to whichever account happens to be tightest, which is why the
 * accounts are named individually right beside it.
 *
 * Returns null when there is nothing to say — no plugin, an empty roster, or
 * accounts with no quota sampled yet — so the caller keeps the auth.json answer
 * rather than replacing a real number with an empty panel.
 */
export const buildMultiAccountResult = (accounts) => {
  if (!Array.isArray(accounts) || accounts.length === 0) return null;

  // The roster speaks of each other by id. The panel speaks the operator's own
  // labels, so "shares with works-shared" would print a slug where a name
  // belongs — and the whole point of the field is to be readable at a glance.
  const labelOf = (id) => {
    const match = accounts.find((candidate) => candidate?.id === id);
    const label = (match?.label ?? '').trim();
    return label || id;
  };

  const models = {};
  const windows = {};
  let reported = 0;

  for (const account of dedupeSharedAccounts(accounts)) {
    const accountResult = buildAccountResult(account, { labelOf });
    const accountWindows = accountResult.usage?.windows ?? {};
    if (Object.keys(accountWindows).length === 0) continue;
    reported += 1;
    models[accountResult.providerName] = {
      windows: accountWindows,
      ...(accountResult.sharedWith ? { sharedWith: accountResult.sharedWith } : {}),
    };
    for (const [label, window] of Object.entries(accountWindows)) {
      const used = window?.usedPercent;
      if (typeof used !== 'number' || !Number.isFinite(used)) continue;
      const current = windows[label];
      if (!current || used > current.usedPercent) windows[label] = window;
    }
  }

  if (reported === 0) return null;

  return buildResult({
    providerId,
    providerName,
    ok: true,
    configured: true,
    usage: { windows, models },
  });
};

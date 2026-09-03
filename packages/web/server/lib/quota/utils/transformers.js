export const asObject = (value) => (value && typeof value === 'object' ? value : null);

export const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

export const toNumber = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

export const toTimestamp = (value) => {
  if (!value) return null;
  if (typeof value === 'number') {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};

export const normalizeTimestamp = (value) => {
  if (typeof value !== 'number') return null;
  return value < 1_000_000_000_000 ? value * 1000 : value;
};

const ZAI_TOKEN_WINDOW_SECONDS = {
  3: 60 * 60,
  6: 7 * 24 * 60 * 60
};

export const resolveWindowSeconds = (limit) => {
  if (!limit || !limit.number) return null;
  const unitSeconds = ZAI_TOKEN_WINDOW_SECONDS[limit.unit];
  if (!unitSeconds) return null;
  return unitSeconds * limit.number;
};

/**
 * How long a Claude quota window is, from the label the window is keyed by.
 *
 * The upstream payload names the duration and we were throwing it away: both
 * Claude providers emitted `windowSeconds: null` on every window, so the field
 * was not merely empty but false — the answer was in the payload all along.
 * Null is what a provider that genuinely does not say is allowed to report
 * (kimi, copilot, deepseek), and the headline ranker has to rank those last
 * precisely because it cannot tell them apart. Once Claude reports nulls too,
 * that last-resort bucket is the only bucket there is, and the ranking between
 * a 5-hour at 44% and a 7-day at 70% silently degenerates to array order.
 *
 * Keyed on the window label rather than derived from `resetAt`, because the
 * label is what both Claude call sites already have and what the UI already
 * renders; the mapping lives here so the two providers cannot drift apart.
 *
 * `opus` is the third key the roster path emits. It is not a duration of its
 * own: the plugin builds it from Anthropic's `seven_day_opus` bucket
 * (opencode-claude `src/quota.ts:313`), so it is a 7-day window under a
 * model-scoped name. It belongs in the table because a missing entry returns
 * null, and a null row ranks last — which would quietly exclude the opus
 * bucket from the headline on the machines that have one.
 *
 * Returns null for an unknown label: an invented duration would be the same
 * class of lie as the nulls this replaces.
 */
const CLAUDE_WINDOW_SECONDS = {
  '5h': 5 * 3600,
  '7d': 7 * 86400,
  '7d-sonnet': 7 * 86400,
  '7d-opus': 7 * 86400,
  opus: 7 * 86400,
};

export const claudeWindowSeconds = (windowKey) => CLAUDE_WINDOW_SECONDS[windowKey] ?? null;

export const resolveWindowLabel = (windowSeconds) => {
  if (!windowSeconds) return 'tokens';
  if (windowSeconds % 86400 === 0) {
    const days = windowSeconds / 86400;
    return days === 7 ? 'weekly' : `${days}d`;
  }
  if (windowSeconds % 3600 === 0) {
    return `${windowSeconds / 3600}h`;
  }
  return `${windowSeconds}s`;
};

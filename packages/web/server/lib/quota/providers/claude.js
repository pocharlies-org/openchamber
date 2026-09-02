import { readAuthFile } from '../../opencode/auth.js';
import {
  accountIdFromProviderId,
  buildAccountResult,
  buildMultiAccountResult,
  fetchClaudeAccounts
} from './claude-accounts.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  toNumber,
  toTimestamp
} from '../utils/index.js';

export const providerId = 'claude';
export const providerName = 'Claude';
const aliases = ['anthropic', 'claude'];

export const isConfigured = () => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return Boolean(entry?.access || entry?.token);
};

/**
 * The answer when the session names an account this provider cannot resolve.
 *
 * Extracted because it is a decision worth testing, and `fetchQuota` is not: it
 * binds readAuthFile at module load, so a test cannot substitute the ambient
 * credential and every assertion about the account branches would be an
 * assertion about whatever token is on the machine.
 *
 * An error rather than the ambient pool. Falling back would print one
 * subscription's remaining quota under another account's name, which is the
 * failure this whole path exists to remove; a broken readout is recoverable, a
 * confident wrong one is what gets acted on.
 */
export const buildAccountMiss = ({ accountId, pluginReachable }) => buildResult({
  providerId,
  providerName: `${providerName} · ${accountId}`,
  ok: false,
  configured: true,
  error: pluginReachable
    ? 'Account not found in the Claude plugin'
    : 'Claude plugin not reachable'
});

/**
 * Which of the two sources answers "what is my Claude quota".
 *
 * Pure and exported for the same reason as buildAccountMiss: the callers around
 * it read credentials and the network, so the ordering is otherwise untestable.
 *
 * The plugin's roster wins when it has something to say, because it is the only
 * source that can name what it is reporting — one entry per subscription, each
 * labelled, accounts that share a login or an organization collapsed into one.
 * auth.json holds one token and therefore reports one pool under the label
 * "Claude"; on a machine with several subscriptions that number is correct for
 * exactly one of them and gives no way to tell the user which.
 *
 * When the roster is null (no plugin), empty, or every account is unsampled,
 * `buildMultiAccountResult` returns null and the auth.json result stands. That is
 * the common case — a single subscription — and it must not regress.
 */
export const resolveUnattributedQuota = ({ accounts, authJsonQuota }) =>
  buildMultiAccountResult(accounts) ?? authJsonQuota;

/**
 * The ambient readout: whatever auth.json can see.
 *
 * One token, one pool, no account named. This is the whole of the pre-existing
 * behaviour and is left exactly as it was, because for the single-subscription
 * machine it is simply correct.
 */
const fetchAuthJsonQuota = async () => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  const accessToken = entry?.access ?? entry?.token;

  if (!accessToken) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  try {
    const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20'
      }
    });

    if (!response.ok) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: `API error: ${response.status}`
      });
    }

    const payload = await response.json();
    const windows = {};
    const fiveHour = payload?.five_hour ?? null;
    const sevenDay = payload?.seven_day ?? null;
    const sevenDaySonnet = payload?.seven_day_sonnet ?? null;
    const sevenDayOpus = payload?.seven_day_opus ?? null;

    if (fiveHour) {
      windows['5h'] = toUsageWindow({
        usedPercent: toNumber(fiveHour.utilization),
        windowSeconds: null,
        resetAt: toTimestamp(fiveHour.resets_at)
      });
    }
    if (sevenDay) {
      windows['7d'] = toUsageWindow({
        usedPercent: toNumber(sevenDay.utilization),
        windowSeconds: null,
        resetAt: toTimestamp(sevenDay.resets_at)
      });
    }
    if (sevenDaySonnet) {
      windows['7d-sonnet'] = toUsageWindow({
        usedPercent: toNumber(sevenDaySonnet.utilization),
        windowSeconds: null,
        resetAt: toTimestamp(sevenDaySonnet.resets_at)
      });
    }
    if (sevenDayOpus) {
      windows['7d-opus'] = toUsageWindow({
        usedPercent: toNumber(sevenDayOpus.utilization),
        windowSeconds: null,
        resetAt: toTimestamp(sevenDayOpus.resets_at)
      });
    }

    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows }
    });
  } catch (error) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed'
    });
  }
};

/**
 * The readout when nobody said which account: the plugin's roster, or auth.json.
 *
 * Asks the plugin first. It answers in about a tenth of a second from headers it
 * already harvested, and it is the only source that knows how many subscriptions
 * this machine has and which names are the same one underneath.
 *
 * The Anthropic usage endpoint is not consulted as well. It reports the pool of
 * the one token in auth.json, and the roster already reports that account by
 * name — so a second call buys a duplicate row, and where the two disagree (the
 * token was refreshed, the plugin's sample is older) the panel shows two numbers
 * for one subscription.
 */
export const fetchUnattributedQuota = async () => resolveUnattributedQuota({
  accounts: await fetchClaudeAccounts(),
  authJsonQuota: await fetchAuthJsonQuota()
});

/**
 * Claude quota.
 *
 * Two sources, and which one is right depends on a question this file cannot
 * answer on its own: which account is this session spending?
 *
 * `?model=claude-code-<account>` names one, and the plugin — which holds that
 * account's credential and knows which accounts are the same subscription — is
 * the honest answer, so this file defers to it.
 *
 * Without it, see fetchUnattributedQuota. Note what is *not* claimed here: the
 * roster is a fact about the machine, not about the session asking. Per-session
 * attribution is not available — the session's provider id falls back to a
 * global config value, so it reports whatever was last clicked in another
 * window, and the plugin's own per-session table is keyed by a hash of the first
 * message that openchamber never sends. So the readout stays plural and
 * unattributed rather than confident and wrong.
 */
export const fetchQuota = async (options = {}) => {
  const accountId = accountIdFromProviderId(options.modelProviderId);
  if (accountId) {
    const accounts = await fetchClaudeAccounts();
    const match = accounts?.find((account) => account?.id === accountId);
    if (match) return buildAccountResult(match);
    return buildAccountMiss({ accountId, pluginReachable: accounts !== null });
  }

  return fetchUnattributedQuota();
};

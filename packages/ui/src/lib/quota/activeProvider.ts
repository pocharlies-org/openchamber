import { QUOTA_PROVIDERS } from './providers';
import type { QuotaProviderId } from '@/types';

/**
 * Which quota provider a model actually bills against.
 *
 * The Usage readouts are per quota provider, and the two id spaces are not the
 * same: OpenCode calls the ChatGPT subscription `openai` while the quota side
 * files it as `codex`, and the opencode-claude integration registers one
 * `claude-code` provider per Claude login — and, since the multi-account
 * roster, one `claude-code-<account>` per login — all of which bill against the
 * single `claude` quota.
 *
 * Deliberately an allow-list, not a normaliser: an id that is not a quota
 * provider resolves to null rather than to a plausible-looking string. A local
 * gateway (`litellm-auto`) fronts several families at once, so its name says
 * nothing about whose quota a turn spends, and guessing there would print one
 * subscription's remaining quota as if it were another's.
 */
const QUOTA_PROVIDER_ALIASES = new Map<string, QuotaProviderId>([
  ['openai', 'codex'],
  ['chatgpt', 'codex'],
  ['anthropic', 'claude'],
  ['claude-code', 'claude'],
  ['gemini', 'google'],
]);

const QUOTA_PROVIDER_IDS = new Set<string>(QUOTA_PROVIDERS.map((provider) => provider.id));

const normalize = (value: string | null | undefined): string => (value ?? '').trim().toLowerCase();

/**
 * The quota provider this model provider spends, or null when nothing answers
 * that question — an unknown id, a local gateway, or no model picked yet.
 */
export const resolveQuotaProviderId = (
  modelProviderId: string | null | undefined,
): QuotaProviderId | null => {
  const normalized = normalize(modelProviderId);
  if (!normalized) return null;

  const aliased = QUOTA_PROVIDER_ALIASES.get(normalized);
  if (aliased) return aliased;

  // The account-scoped providers the same integration registers, one per login
  // so the picker groups by subscription instead of listing every model twice.
  // The account is in the id; the quota it spends is not, so all of them are
  // the `claude` quota. Prefix, not substring: `my-claude-code` is someone
  // else's custom provider.
  if (normalized.startsWith('claude-code-')) return 'claude';

  return QUOTA_PROVIDER_IDS.has(normalized) ? (normalized as QuotaProviderId) : null;
};

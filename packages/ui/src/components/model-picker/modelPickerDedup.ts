import { getModelDisplayName } from '@/lib/modelDisplay';

// Structural copy of ModelPickerProvider (ModelPickerList.tsx) kept local so
// the list can import this helper without a module cycle.
type ProviderModel = Record<string, unknown> & { id?: string; name?: string };
export type ModelPickerProviderLike = {
  id: string;
  name?: string;
  models?: ProviderModel[];
};

/**
 * Collapse mirrored model rows.
 *
 * The Claude account plugin publishes the DEFAULT account twice: once on the
 * bare `claude-code` provider (its models are the default account's catalog,
 * names and all) and once on `claude-code-<account>` (opencode2.ts registers
 * every account as its own provider). The two groups carry byte-identical
 * rows — same id, same decorated name with the same account icon and quota —
 * so the picker paints "🏠 Opus 5.5" twice and the second one reads as
 * another model, not as another address for the same account.
 *
 * Dropping the duplicate provider on the plugin side is not free: sessions
 * pin `{providerID, id}` and some of them point at the mirrored provider
 * today, so removing it from the catalog would strand them (the host resolves
 * the pin against the catalog and answers `Model unavailable`). This collapses
 * the DISPLAY only: the first provider in list order keeps each row, later
 * family providers lose rows that are identical in id AND name, and a pin on
 * a hidden row still resolves server-side.
 *
 * Identity is (modelID, display name) within the `claude-code` family only.
 * Two providers outside a family can show the same name for genuinely
 * different backends (litellm groups do); inside this family the plugin
 * decorates every name with the account icon, so an identical pair cannot be
 * two different accounts.
 */
const isClaudeFamily = (providerId: string): boolean =>
  providerId === 'claude-code' || providerId.startsWith('claude-code-');

export function collapseFamilyDuplicates<T extends ModelPickerProviderLike>(
  providers: T[],
): T[] {
  const seen = new Map<string, Set<string>>();
  return providers
    .map((provider) => {
      if (!isClaudeFamily(provider.id) || !Array.isArray(provider.models)) return provider;
      const claimed = seen.get('claude-code') ?? new Set<string>();
      seen.set('claude-code', claimed);
      const models = provider.models.filter((model) => {
        const modelID = typeof model.id === 'string' ? model.id : '';
        if (!modelID) return true;
        const key = `${modelID}\u0000${getModelDisplayName(model, undefined, { maxLength: 40 })}`;
        if (claimed.has(key)) return false;
        claimed.add(key);
        return true;
      });
      return { ...provider, models };
    })
    .filter((provider) => !Array.isArray(provider.models) || provider.models.length > 0);
}

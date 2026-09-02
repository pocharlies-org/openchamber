import { formatMessage, useI18nStore } from '@/lib/i18n/store';
import type { ProviderResult, UsageWindow } from '@/types';

/**
 * The Claude accounts inside one provider result, as plain data.
 *
 * Why the accounts live in `usage.models` rather than in N results: every
 * consumer reads `useQuotaStore.results` keyed by providerId — eight of them do
 * `results.find(r => r.providerId === id)` — so a second result with
 * providerId `claude` is not a second row, it is a row that never renders. The
 * `models` map is the mechanism the quota UI already has for a per-something
 * breakdown (Google fills it per model), so the accounts arrive labelled on the
 * surfaces that render it and invisible on the ones that do not.
 *
 * Kept free of React and of the i18n store so the two header dropdowns can share
 * one grouping — they are the same list on two layouts, and two implementations
 * of it drift. The caller passes the label for "Other", as it already does for
 * every other label it renders.
 */

export interface QuotaAccountEntry {
  /** Stable key: the account name as the plugin's own panel prints it. */
  id: string;
  /** The account, without the email — the name the operator chose. */
  name: string;
  /** The window label, already run through `formatWindowLabel`. */
  label: string;
  window: UsageWindow;
  /** Other accounts drawing on this same budget. */
  sharedWith?: string[];
}

export interface QuotaAccountFamily {
  /** Stable key for the collapsible; `null` never occurs, every group is named. */
  familyId: string | null;
  /** The account whose name stands for the budget — the one in use. */
  familyLabel: string;
  accounts: QuotaAccountEntry[];
}

/** Providers whose quota is billed per login rather than per model. */
const MULTI_ACCOUNT_PROVIDERS = new Set(['claude']);

/**
 * "shares one budget with X, Y", for the surfaces that have no room for a
 * second line.
 *
 * The i18n store is read through the same helper `formatWindowLabel` uses, so a
 * pure grouping function can still produce a translated string without a hook —
 * and so this text is not duplicated in each surface that needs it.
 */
export const formatQuotaSharedWith = (sharedWith: readonly string[]): string =>
  formatMessage(useI18nStore.getState().dictionary, 'header.services.modelFamily.sharedBudget', {
    accounts: sharedWith.join(', '),
  });

const WINDOW_ORDER = ['5h', '7d', '7d-sonnet', '7d-opus', 'opus'];

const windowOrder = (label: string): number => {
  const index = WINDOW_ORDER.indexOf(label);
  return index === -1 ? WINDOW_ORDER.length : index;
};

/**
 * The accounts this result reports, one entry per subscription.
 *
 * Returns [] for any other provider: a provider that reports per model has
 * nothing to say about accounts, and reading its model rows as accounts would
 * print a model name where a subscription name belongs.
 */
export const getQuotaAccountEntries = (
  result: ProviderResult | undefined,
  formatWindowLabel: (label: string) => string,
): QuotaAccountEntry[] => {
  if (!result || !MULTI_ACCOUNT_PROVIDERS.has(result.providerId)) return [];

  const models = result.usage?.models;
  if (!models) return [];

  const entries: QuotaAccountEntry[] = [];
  for (const [name, modelUsage] of Object.entries(models)) {
    const windows = Object.entries(modelUsage.windows ?? {});
    if (windows.length === 0) continue;
    const [label, window] = [...windows]
      .sort((a, b) => windowOrder(a[0]) - windowOrder(b[0]))[0];
    const sharedWith = (modelUsage as { sharedWith?: string[] }).sharedWith;
    entries.push({
      id: name,
      name: name.split(' · ')[0],
      label: formatWindowLabel(label),
      window,
      ...(sharedWith && sharedWith.length > 0 ? { sharedWith } : {}),
    });
  }
  return entries;
};

/**
 * Accounts grouped by the budget they draw from.
 *
 * Two accounts sharing an organization or a login are two names on ONE pool, so
 * they are shown together under the name of the one that is in use. Printed as
 * separate rows, 30% and 30% reads as two-thirds of a week left when it is one,
 * and the operator rations the wrong account.
 *
 * Sharing is treated as symmetric, because it *is* one: two seats on an
 * organization share it whether or not the roster says so from both sides, and
 * the roster is assembled per account, so it can be asymmetric mid-refresh.
 * Trusting the direction it happens to be stated in drops an account whose own
 * entry does not name the other — it belongs to no group and is printed as a
 * separate budget, which is the exact error this grouping exists to prevent.
 *
 * Accounts that share with nothing are left out — they are their own budget and
 * belong as plain rows, not behind a click.
 */
export const groupQuotaAccountsByBudget = (
  accounts: readonly QuotaAccountEntry[],
): QuotaAccountFamily[] => {
  const byAccount = new Map<string, QuotaAccountFamily>();
  const families: QuotaAccountFamily[] = [];

  const familyFor = (name: string): QuotaAccountFamily | undefined => byAccount.get(name);
  const register = (family: QuotaAccountFamily, names: readonly string[]) => {
    for (const name of names) byAccount.set(name, family);
  };

  for (const account of accounts) {
    const shared = account.sharedWith ?? [];
    // The budget this account belongs to: its own group, the group of anything
    // it shares with, or anything that already took it in as a sharer.
    const related = [account.id, ...shared];
    const existing = related
      .map(familyFor)
      .filter((family): family is QuotaAccountFamily => family !== undefined);
    const home = existing[0];

    if (!home) {
      const family: QuotaAccountFamily = {
        familyId: account.id,
        familyLabel: account.name,
        accounts: [account],
      };
      families.push(family);
      register(family, related);
      continue;
    }

    if (!home.accounts.some((entry) => entry.id === account.id)) {
      home.accounts.push(account);
    }
    // Absorb any other group this account links to, so one budget never ends up
    // as two groups because its members arrived in an unlucky order.
    for (const other of existing.slice(1)) {
      if (other === home) continue;
      for (const entry of other.accounts) {
        if (!home.accounts.some((existing2) => existing2.id === entry.id)) {
          home.accounts.push(entry);
        }
      }
      families.splice(families.indexOf(other), 1);
    }
    register(home, [account.id, ...shared, ...home.accounts.map((entry) => entry.id)]);
  }

  return families.filter((family) => family.accounts.length > 1);
};

/**
 * The accounts that are not inside any budget group, so a surface can print them
 * as plain rows beside the groups.
 *
 * `groupQuotaAccountsByBudget` drops the unshared accounts, and which of the two
 * kinds a surface should show depends on whether anything was filtered out —
 * with nothing filtered, all of them are unshared and all of them are rows.
 * Deciding that in each caller's JSX is how the two header dropdowns would end
 * up showing different subsets of the same roster.
 */
export const getQuotaAccountsOutsideGroups = (
  accounts: readonly QuotaAccountEntry[],
  families: readonly QuotaAccountFamily[],
): QuotaAccountEntry[] => {
  if (families.length === 0) return [...accounts];
  const grouped = new Set(families.flatMap((family) => family.accounts.map((account) => account.id)));
  return accounts.filter((account) => !grouped.has(account.id));
};

/**
 * Whether a surface should read this result's accounts as accounts at all.
 *
 * `usage.models` is the map the quota UI has for a per-something breakdown, and
 * what that something is depends on the provider: Google fills it with models,
 * Claude with subscriptions. A surface that labels the section "Model Quotas"
 * and shows "Personal · me@e-dani.com" there is not showing a breakdown — it is
 * calling a subscription a model, and `getDisplayModelName` then hands back the
 * identity line as if it were a model id.
 *
 * The set is the same one `getQuotaAccountEntries` gates on; keeping it here
 * rather than re-deriving it per surface is what stops the header labelling the
 * rows as accounts while the settings page labels the same rows as models.
 */
export const isPerAccountQuotaProvider = (providerId: string | null | undefined): boolean =>
  providerId !== null && providerId !== undefined && MULTI_ACCOUNT_PROVIDERS.has(providerId);

/** What the settings page has to say when a configured provider reports nothing. */
export type QuotaEmptyState = 'not-configured' | 'no-quotas';

/**
 * Whether "no quota windows" is the truth or an artefact of the surface.
 *
 * The page decides from `usage.windows` alone, and for Claude that field is
 * empty by design whenever more than one subscription is connected — there is no
 * provider-level budget for it to carry. Printed from that field alone, a
 * machine reporting three named subscriptions would say "This provider does not
 * currently report any rate limits or usage quotas", which is the opposite of
 * what happened: the data arrived, it just belongs to somebody.
 *
 * So the sentence is only allowed when there is genuinely nothing, accounts
 * included. Returns false when the provider is not configured — that case has
 * its own banner and must not be doubled by this one.
 */
export const shouldReportNoQuotaWindows = (
  result: Pick<ProviderResult, 'providerId' | 'configured'> | null | undefined,
  providerHasQuotaRows: boolean,
): boolean => {
  if (!result || result.configured !== true) return false;
  return !providerHasQuotaRows;
};

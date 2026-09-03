import type { IconName } from '@/components/icon/icons';

export type SessionModelBadgeKind = 'codex' | 'claude' | 'local' | 'unknown' | 'none';

export type SessionModelBadgeModel = {
  id: string;
  providerID: string;
  variant?: string;
};

export type SessionModelBadge = {
  kind: SessionModelBadgeKind;
  icon: IconName | null;
  label: string;
};

// Model-id markers for each family. Gateway providers (`litellm-auto` and
// friends) front several families at once, so the family is only visible in the
// model id: `gpt-5.3-codex-spark` and `codex-auto-review` are Codex models
// served by a local router, and provider alone would file them as local.
const CODEX_MODEL_MARKERS = ['codex'] as const;
const CLAUDE_MODEL_MARKERS = ['claude'] as const;

// Provider markers that identify a session running on a local LLM runtime.
// "localhost" is redundant with "local" but listed explicitly so the intent
// stays visible in the classification table. Deliberately provider-only: a
// model id says which family runs, never where it runs, so a gateway serving a
// remote model must not be promoted to local on the strength of its name.
const LOCAL_PROVIDER_MARKERS = ['litellm-auto', 'ollama', 'lmstudio', 'local', 'localhost'] as const;

const includesAny = (haystack: string, markers: readonly string[]): boolean =>
  markers.some((marker) => haystack.includes(marker));

/**
 * Classifies a session's model into a small badge family (Codex / Claude /
 * local) so the sidebar can show which LLM family a session runs.
 *
 * Both `providerID` and `id` are consulted, case-insensitively, and family
 * wins over runtime: a Codex model reached through a local gateway is badged
 * Codex, not local. The most specific family is therefore checked first.
 *
 * The two icon-less outcomes are distinct and must stay distinct. `none` means
 * there is nothing to classify yet — no model record, as on a session that has
 * never taken a turn. `unknown` means an authoritative model record exists and
 * this table does not cover it. Collapsing them would let an unsynced session
 * read as a real classification verdict. The returned `icon` is always a valid
 * sprite name or `null`.
 */
export function resolveSessionModelBadge(
  model: SessionModelBadgeModel | undefined | null,
): SessionModelBadge {
  const providerID = model?.providerID?.toLowerCase() ?? '';
  const modelID = model?.id?.toLowerCase() ?? '';

  if (!providerID && !modelID) {
    return { kind: 'none', icon: null, label: '' };
  }
  if (providerID.includes('codex') || includesAny(modelID, CODEX_MODEL_MARKERS)) {
    return { kind: 'codex', icon: 'terminal-window', label: 'Codex' };
  }
  if (
    providerID.includes('claude')
    || providerID.includes('anthropic')
    || includesAny(modelID, CLAUDE_MODEL_MARKERS)
  ) {
    return { kind: 'claude', icon: 'sparkling', label: 'Claude' };
  }
  if (includesAny(providerID, LOCAL_PROVIDER_MARKERS)) {
    return { kind: 'local', icon: 'server', label: 'Local' };
  }
  return { kind: 'unknown', icon: null, label: '' };
}

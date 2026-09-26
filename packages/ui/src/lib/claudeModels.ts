import { runtimeFetch } from '@/lib/runtime-fetch';

/**
 * The models a Claude Code session can run on, as Claude Code's own picker
 * lists them (`modelPicker.options` in ~/.claude/settings.json, served by
 * GET /api/claude/models). OpenCode's provider list means nothing to a Claude
 * session: the server drops any model from it (routes.js `/model`).
 */
export type ClaudeModelOption = { id: string; label: string; description?: string };
export type ClaudeEffortOption = { id: string; label: string };
export type ClaudeModelCatalog = {
  models: ClaudeModelOption[];
  defaultModelId: string | null;
  efforts: ClaudeEffortOption[];
  defaultEffort: string | null;
};

/** `providerID` the server keeps a Claude pick under. */
export const CLAUDE_PROVIDER_ID = 'claude';

let catalogRequest: Promise<ClaudeModelCatalog | null> | null = null;

/** Read once per page; a failed read is retried by the next caller. */
export const fetchClaudeModelCatalog = (): Promise<ClaudeModelCatalog | null> => {
  catalogRequest ??= runtimeFetch('/api/claude/models')
    .then((response) => (response.ok ? response.json() as Promise<ClaudeModelCatalog> : null))
    .catch(() => null)
    .then((catalog) => {
      if (!catalog) catalogRequest = null;
      return catalog;
    });
  return catalogRequest;
};

/** Put a Claude session on a model and thinking effort for its next turn. */
export const selectClaudeModel = async (sessionId: string, pick: { id: string; variant?: string }): Promise<boolean> => {
  try {
    const response = await runtimeFetch(`/api/session/${encodeURIComponent(sessionId)}/model`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: { providerID: CLAUDE_PROVIDER_ID, id: pick.id, variant: pick.variant } }),
    });
    return response.ok;
  } catch {
    return false;
  }
};

// `claude-opus-5-5`, `claude-haiku-4-5-20251001`: family, major, optional minor, optional date.
const ANTHROPIC_MODEL_ID = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/;

const familyOf = (modelId: string): string | null => ANTHROPIC_MODEL_ID.exec(modelId)?.[1] ?? null;

/**
 * Whether a catalog entry names the model a transcript recorded: the same id,
 * or the alias of its family (`opus[1m]` for `claude-opus-5-5`).
 */
export const catalogEntryMatches = (entryId: string, modelId: string): boolean => {
  if (entryId === modelId) return true;
  const family = familyOf(modelId);
  return family !== null && entryId.replace(/\[[^\]]*\]$/, '') === family;
};

/**
 * What to call the model a transcript recorded. An Anthropic id reads as its
 * family and version (`Opus 5.5`), never as an alias's label, which could name
 * another version; anything else takes its catalog label when it has one.
 */
export const claudeModelLabel = (modelId: string, catalog: ClaudeModelCatalog | null): string => {
  const match = ANTHROPIC_MODEL_ID.exec(modelId);
  if (match) {
    const [, family, major, minor] = match;
    return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${minor ? `${major}.${minor}` : major}`;
  }
  return catalog?.models.find((entry) => entry.id === modelId)?.label ?? modelId;
};

type AnsweringMessage = { id?: string; role?: string; modelID?: string };

/**
 * `id\nmodel` of the newest answer that names its model, or null before the
 * first. A string, so a store selector notifies only when it changes.
 */
export const findClaudeAnswerKey = (messages: readonly AnsweringMessage[]): string | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant' || !message.modelID) continue;
    return `${message.id ?? ''}\n${message.modelID}`;
  }
  return null;
};

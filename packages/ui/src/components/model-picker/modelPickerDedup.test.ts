import { describe, expect, test } from 'bun:test';

import { collapseFamilyDuplicates, type ModelPickerProviderLike } from './modelPickerDedup';

const claudeModel = (id: string, name: string) => ({ id, name });

// The shape the runtime serves today: the bare provider carries the DEFAULT
// account's catalog (same ids, same decorated names) and that account also
// has its own provider — the mirror the plugin publishes.
const providers: ModelPickerProviderLike[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    models: [claudeModel('opus', '🏠 Opus 5.5 · 🟢 ? · 🔵 15% 2d 14h'), claudeModel('sonnet', '🏠 Sonnet 5 · 🟢 ?')],
  },
  {
    id: 'claude-code-personal',
    name: '🏠 Claude Code · Personal · me@e-dani.com',
    models: [claudeModel('opus', '🏠 Opus 5.5 · 🟢 ? · 🔵 15% 2d 14h'), claudeModel('sonnet', '🏠 Sonnet 5 · 🟢 ?')],
  },
  {
    id: 'claude-code-works-shared',
    name: '👥 Claude Code · Works Shared · daniel.speedo@cloudblue.com',
    models: [claudeModel('opus', '👥 Opus 5.5 · 🟢 99% 3h 46m · 🔵 11% 38h 6m')],
  },
];

describe('collapseFamilyDuplicates', () => {
  test('drops the mirrored default-account rows and the group they empty', () => {
    const result = collapseFamilyDuplicates(providers);
    expect(result.map((provider) => provider.id)).toEqual(['claude-code', 'claude-code-works-shared']);
    expect(result[1]?.models?.map((model) => model.id)).toEqual(['opus']);
  });

  test('keeps rows whose decorated name differs (another account)', () => {
    const result = collapseFamilyDuplicates(providers);
    const works = result.find((provider) => provider.id === 'claude-code-works-shared');
    expect(works?.models?.[0]?.name).toContain('👥');
  });

  test('leaves providers outside the claude family untouched', () => {
    const litellm: ModelPickerProviderLike[] = [
      { id: 'litellm-local', name: 'LiteLLM', models: [claudeModel('qwen38', 'Qwen3.8')] },
      { id: 'litellm-codex', name: 'LiteLLM Codex', models: [claudeModel('qwen38', 'Qwen3.8')] },
    ];
    expect(collapseFamilyDuplicates(litellm)).toEqual(litellm);
  });

  test('a provider whose rows all survive keeps its order and identity', () => {
    const result = collapseFamilyDuplicates([
      { id: 'anthropic', name: 'Anthropic', models: [claudeModel('claude-opus-5', 'Opus 5')] },
      ...providers,
    ]);
    expect(result.map((provider) => provider.id)).toEqual(['anthropic', 'claude-code', 'claude-code-works-shared']);
  });

  test('tolerates providers without a models array', () => {
    const result = collapseFamilyDuplicates([
      { id: 'claude-code-personal', name: '🏠 Personal', models: [claudeModel('opus', '🏠 Opus 5.5')] },
      { id: 'litellm-local', name: 'LiteLLM' },
    ]);
    expect(result.map((provider) => provider.id)).toEqual(['claude-code-personal', 'litellm-local']);
  });
});

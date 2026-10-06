import { describe, expect, test } from 'bun:test';

import { catalogEntryMatches, claudeModelLabel, findClaudeAnswerKey, type ClaudeModelCatalog } from './claudeModels';

const catalog: ClaudeModelCatalog = {
  models: [
    { id: 'opus[1m]', label: 'Opus 5.5 (Anthropic)' },
    { id: 'qwen38-flash-next', label: 'qwen38 residente (local)' },
  ],
  defaultModelId: 'opus[1m]',
  efforts: [{ id: 'high', label: 'High' }],
  defaultEffort: 'high',
};

describe('Claude session models', () => {
  test('names the model a transcript recorded by family and version', () => {
    expect(claudeModelLabel('claude-opus-5-5', catalog)).toBe('Opus 5.5');
    expect(claudeModelLabel('claude-sonnet-5', catalog)).toBe('Sonnet 5');
    expect(claudeModelLabel('claude-haiku-4-5-20251001', catalog)).toBe('Haiku 4.5');
    expect(claudeModelLabel('qwen38-flash-next', catalog)).toBe('qwen38 residente (local)');
    expect(claudeModelLabel('something-else', catalog)).toBe('something-else');
  });

  test('matches a recorded model to its catalog alias', () => {
    expect(catalogEntryMatches('opus[1m]', 'claude-opus-5-5')).toBe(true);
    expect(catalogEntryMatches('sonnet[1m]', 'claude-opus-5-5')).toBe(false);
    expect(catalogEntryMatches('qwen38-flash-next', 'qwen38-flash-next')).toBe(true);
    expect(catalogEntryMatches('qwen38-off', 'qwen38-flash-next')).toBe(false);
  });

  test('keys the newest answer that names its model', () => {
    expect(findClaudeAnswerKey([])).toBeNull();
    expect(findClaudeAnswerKey([
      { id: 'a1', role: 'assistant', modelID: 'claude-opus-5-5' },
      { id: 'u1', role: 'user' },
      { id: 'a2', role: 'assistant', modelID: '' },
    ])).toBe('a1\nclaude-opus-5-5');
  });
});

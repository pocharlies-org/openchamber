import { describe, expect, test } from 'bun:test';

import { resolveSessionModelBadge } from './sessionModelBadge';

describe('resolveSessionModelBadge', () => {
  test('classifies a Codex provider as codex', () => {
    expect(resolveSessionModelBadge({ id: 'codex', providerID: 'openai/codex' })).toEqual({
      kind: 'codex',
      icon: 'terminal-window',
      label: 'Codex',
    });
  });

  test('classifies a claude-code provider as claude', () => {
    expect(resolveSessionModelBadge({ id: 'claude-opus-4', providerID: 'claude-code' })).toEqual({
      kind: 'claude',
      icon: 'sparkling',
      label: 'Claude',
    });
  });

  test('classifies an anthropic provider as claude', () => {
    expect(resolveSessionModelBadge({ id: 'claude-opus-4', providerID: 'anthropic' })).toEqual({
      kind: 'claude',
      icon: 'sparkling',
      label: 'Claude',
    });
  });

  test('classifies a litellm-auto provider as local', () => {
    expect(resolveSessionModelBadge({ id: 'deepseek-v4-flash', providerID: 'litellm-auto' })).toEqual({
      kind: 'local',
      icon: 'server',
      label: 'Local',
    });
  });

  test('classifies local provider markers as local', () => {
    for (const providerID of ['ollama', 'lmstudio', 'localhost']) {
      expect(resolveSessionModelBadge({ id: 'local-model', providerID }).kind).toBe('local');
    }
  });

  test('classification is case-insensitive on providerID', () => {
    expect(resolveSessionModelBadge({ id: 'claude-opus-4', providerID: 'Anthropic' }).kind).toBe('claude');
    expect(resolveSessionModelBadge({ id: 'codex', providerID: 'OpenAI/Codex' }).kind).toBe('codex');
  });

  // Family wins over runtime: a gateway provider fronts several families at
  // once, so provider alone would misfile these as local.
  test('detects codex from the model id behind a gateway provider', () => {
    for (const id of [
      'gpt-5.3-codex-spark',
      'cloudblue/gpt-5.3-codex-spark',
      'e-dani/gpt-5.3-codex-spark',
      'gpt-5.3-codex-spark-edani',
      'codex-auto-review',
      'codex-auto-review-edani',
    ]) {
      expect(resolveSessionModelBadge({ id, providerID: 'litellm-auto' })).toEqual({
        kind: 'codex',
        icon: 'terminal-window',
        label: 'Codex',
      });
    }
  });

  test('detects claude from the model id on an unrecognised provider', () => {
    expect(resolveSessionModelBadge({ id: 'anthropic.claude-opus-4', providerID: 'bedrock' })).toEqual({
      kind: 'claude',
      icon: 'sparkling',
      label: 'Claude',
    });
  });

  test('model-id classification is case-insensitive', () => {
    expect(resolveSessionModelBadge({ id: 'GPT-5.3-Codex-Spark', providerID: 'litellm-auto' }).kind).toBe('codex');
    expect(resolveSessionModelBadge({ id: 'Claude-Opus-4', providerID: 'bedrock' }).kind).toBe('claude');
  });

  test('keeps genuinely local gateway models as local', () => {
    for (const id of ['deepseek-v4-flash-0731', 'qwen38-27b', 'qwen3.5-4b', 'tooling']) {
      expect(resolveSessionModelBadge({ id, providerID: 'litellm-auto' }).kind).toBe('local');
    }
  });

  // A missing model record and an unrecognised one are different states: the
  // first has nothing to classify yet, the second is an authoritative verdict.
  test('classifies a missing model as none, not unknown', () => {
    expect(resolveSessionModelBadge(null)).toEqual({ kind: 'none', icon: null, label: '' });
    expect(resolveSessionModelBadge(undefined)).toEqual({ kind: 'none', icon: null, label: '' });
    expect(resolveSessionModelBadge({ id: '', providerID: '' })).toEqual({
      kind: 'none',
      icon: null,
      label: '',
    });
  });

  test('classifies an unrecognised provider as unknown, not none', () => {
    expect(resolveSessionModelBadge({ id: 'some-model', providerID: 'acme' })).toEqual({
      kind: 'unknown',
      icon: null,
      label: '',
    });
  });

  test('none and unknown both render without an icon', () => {
    expect(resolveSessionModelBadge(null).icon).toBeNull();
    expect(resolveSessionModelBadge({ id: 'some-model', providerID: 'acme' }).icon).toBeNull();
  });
});

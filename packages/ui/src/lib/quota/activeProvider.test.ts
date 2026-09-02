import { describe, expect, test } from 'bun:test';

import { resolveQuotaProviderId } from './activeProvider';

describe('resolveQuotaProviderId', () => {
  test('passes an id that already names a quota provider', () => {
    expect(resolveQuotaProviderId('opencode-go')).toBe('opencode-go');
    expect(resolveQuotaProviderId('claude')).toBe('claude');
  });

  test('maps the ids that bill under another quota provider', () => {
    expect(resolveQuotaProviderId('openai')).toBe('codex');
    expect(resolveQuotaProviderId('chatgpt')).toBe('codex');
    expect(resolveQuotaProviderId('anthropic')).toBe('claude');
    expect(resolveQuotaProviderId('gemini')).toBe('google');
  });

  test('maps every opencode-claude account provider onto the Claude quota', () => {
    // One provider per Claude login; the account is in the id, the quota is not.
    expect(resolveQuotaProviderId('claude-code')).toBe('claude');
    expect(resolveQuotaProviderId('claude-code-tercera')).toBe('claude');
    expect(resolveQuotaProviderId('claude-code-works-shared')).toBe('claude');
  });

  test('resolves nothing for a model whose quota is not ours to report', () => {
    // A gateway fronts several families at once: naming one of them would print
    // someone else's remaining quota as if this session were spending it.
    expect(resolveQuotaProviderId('litellm-auto')).toBeNull();
    expect(resolveQuotaProviderId('ollama')).toBeNull();
    expect(resolveQuotaProviderId('mistral')).toBeNull();
  });

  test('is whitespace and case tolerant, and resolves empties to nothing', () => {
    expect(resolveQuotaProviderId('  Claude-Code-Tercera ')).toBe('claude');
    expect(resolveQuotaProviderId('')).toBeNull();
    expect(resolveQuotaProviderId('   ')).toBeNull();
    expect(resolveQuotaProviderId(null)).toBeNull();
    expect(resolveQuotaProviderId(undefined)).toBeNull();
  });

  test('does not treat a claude-code prefix match as a claude provider', () => {
    // Guard against a substring rule: only the exact ids the plugin registers.
    expect(resolveQuotaProviderId('claude-codeish')).toBeNull();
    expect(resolveQuotaProviderId('my-claude-code')).toBeNull();
  });
});

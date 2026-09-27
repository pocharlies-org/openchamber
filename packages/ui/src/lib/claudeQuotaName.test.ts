import { describe, expect, test } from 'bun:test';

import { compactClaudeQuotaName } from './claudeQuotaName';

describe('compactClaudeQuotaName', () => {
  test('drops the second unit of each window countdown', () => {
    expect(compactClaudeQuotaName('\u{1F3E0} Opus 5.5 \u00B7 \u{1F7E2} 93% 54m \u00B7 \u{1F535} 15% 2d 18h'))
      .toBe('\u{1F3E0} Opus 5.5 \u00B7 \u{1F7E2} 93% 54m \u00B7 \u{1F535} 15% 2d');
    expect(compactClaudeQuotaName('\u{1F7E2} 96% 2h 20m \u00B7 \u{1F535} 4% 5d 3h'))
      .toBe('\u{1F7E2} 96% 2h \u00B7 \u{1F535} 4% 5d');
  });

  test('leaves single-unit countdowns, unknowns and the blocked marker untouched', () => {
    expect(compactClaudeQuotaName('\u{1F7E0} Sonnet 4.5 \u00B7 \u{1F7E2} 93% 54m \u00B7 \u{1F535} 15% 2d'))
      .toBe('\u{1F7E0} Sonnet 4.5 \u00B7 \u{1F7E2} 93% 54m \u00B7 \u{1F535} 15% 2d');
    expect(compactClaudeQuotaName('\u{1F3E0} Opus 5.5 \u00B7 \u{1F7E2} ? \u00B7 \u{1F535} ?'))
      .toBe('\u{1F3E0} Opus 5.5 \u00B7 \u{1F7E2} ? \u00B7 \u{1F535} ?');
    expect(compactClaudeQuotaName('\u{1F3E0} Opus 5.5 \u00B7 \u{1F534} bloqueada 2h 20m'))
      .toBe('\u{1F3E0} Opus 5.5 \u00B7 \u{1F534} bloqueada 2h');
    expect(compactClaudeQuotaName('\u{1F534} bloqueada 54m'))
      .toBe('\u{1F534} bloqueada 54m');
  });

  test('returns names without quota marks unchanged', () => {
    expect(compactClaudeQuotaName('gpt-5.2 codex')).toBe('gpt-5.2 codex');
    expect(compactClaudeQuotaName('Opus 5.5')).toBe('Opus 5.5');
    expect(compactClaudeQuotaName('')).toBe('');
  });

  test('keeps non-quota segments that merely contain a countdown', () => {
    // The base name is never a quota segment: only marked ones are rewritten.
    expect(compactClaudeQuotaName('Qwen 3 2d 18h'))
      .toBe('Qwen 3 2d 18h');
  });
});

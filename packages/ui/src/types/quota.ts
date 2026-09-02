export type QuotaProviderId =
  | 'openai'
  | 'codex'
  | 'cursor'
  | 'claude'
  | 'github-copilot'
  | 'github-copilot-addon'
  | 'google'
  | 'kimi-for-coding'
  | 'nano-gpt'
  | 'openrouter'
  | 'zai-coding-plan'
  | 'zhipuai-coding-plan'
  | 'minimax-coding-plan'
  | 'minimax-cn-coding-plan'
  | 'ollama-cloud'
  | 'wafer'
  | 'opencode-go'
  | 'crof'
  | 'deepseek'
  | 'neuralwatt'
  | 'xai';

export interface UsageWindow {
  usedPercent: number | null;
  remainingPercent: number | null;
  windowSeconds: number | null;
  resetAfterSeconds: number | null;
  resetAt: number | null;
  resetAtFormatted: string | null;
  resetAfterFormatted: string | null;
  valueLabel?: string | null;
}

export interface UsageWindows {
  windows: Record<string, UsageWindow>;
}

export interface UsageWindowsWithSharers extends UsageWindows {
  /**
   * Accounts that draw on this same budget.
   *
   * Two Claude logins on one organization, or the same login held twice, are two
   * names on ONE pool. Without this the panel prints 30% and 30% and reads as
   * two-thirds of a week left when it is one. Only the Claude provider fills it.
   */
  sharedWith?: string[];
}

interface ProviderUsage extends UsageWindows {
  models?: Record<string, UsageWindowsWithSharers>;
}

export interface ProviderResult {
  providerId: QuotaProviderId;
  providerName: string;
  ok: boolean;
  configured: boolean;
  error?: string;
  usage: ProviderUsage | null;
  fetchedAt: number;
}

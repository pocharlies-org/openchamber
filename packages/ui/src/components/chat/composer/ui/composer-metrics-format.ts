import type { StreamMetricSnapshot } from '@/sync/stream-metrics';

export const compactMetricNumber = (value: number | null): string => {
  if (value === null || !Number.isFinite(value)) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return Math.round(value).toLocaleString();
};

export const formatMetricDuration = (value: number | null): string => {
  if (value === null || !Number.isFinite(value)) return '—';
  if (value < 1_000) return `${Math.round(value)} ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} s`;
};

export const formatComposerMetricIndicator = (snapshot: StreamMetricSnapshot, compact: boolean): string => {
  const speed = snapshot.speedTokensPerSecond === null ? '—' : snapshot.speedTokensPerSecond.toFixed(0);
  return compact
    ? `⚡ ${speed} · ${formatMetricDuration(snapshot.ttftMs)}`
    : `⚡ ${speed} tok/s · TTFT ${formatMetricDuration(snapshot.ttftMs)} · ↑ ${compactMetricNumber(snapshot.tokens.input)} · ↓ ${compactMetricNumber(snapshot.tokens.output)}`;
};

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
  // Build the indicator only from parts this client actually measured. A turn
  // this client did not accept (observed or loaded from history) has no TTFT
  // and no accepted-at duration; painting those as em dashes makes the footer
  // look broken, and unreported usage must not show as a real `0`. An empty
  // result means the surface renders nothing at all.
  const timing: string[] = [];
  if (snapshot.speedTokensPerSecond !== null) {
    timing.push(compact
      ? `⚡ ${snapshot.speedTokensPerSecond.toFixed(0)}`
      : `⚡ ${snapshot.speedTokensPerSecond.toFixed(0)} tok/s`);
  }
  if (snapshot.ttftMs !== null) {
    timing.push(compact
      ? formatMetricDuration(snapshot.ttftMs)
      : `TTFT ${formatMetricDuration(snapshot.ttftMs)}`);
  }
  const counters: string[] = [];
  if (snapshot.tokens.input !== null && snapshot.tokens.input > 0) {
    counters.push(`↑ ${compactMetricNumber(snapshot.tokens.input)}`);
  }
  if (snapshot.tokens.output > 0) {
    counters.push(`↓ ${compactMetricNumber(snapshot.tokens.output)}`);
  }
  return (compact ? (timing.length > 0 ? timing : counters) : [...timing, ...counters]).join(' · ');
};

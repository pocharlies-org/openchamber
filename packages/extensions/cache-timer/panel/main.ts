// Cache Timer guest: the prompt-cache countdown of the last turn, painted in
// the composer-footer slot the host opens for `contributes.composerStatus`.
// The host computes the snapshot from its own sync; this iframe only paints it
// and re-renders on its own clock. The logic lives in timer.ts.
import { connectHost, type ComposerStatusSnapshot, type HostReadyContext } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import { computeCacheTimer, formatCacheDuration } from './timer.ts';

const CONTRIBUTION_ID = 'openchamber-builtin-cache-timer';
const TICK_MS = 10_000;

// The iframe cannot use the host's React i18n, so the package carries the two
// host locales it translates; everything else falls back to English. The
// strings mirror `chat.cacheTimer.*` in the host messages.
const DICTS: Record<string, { expired: string; tooltip: string; tooltipExpired: string }> = {
  en: {
    expired: 'expired',
    tooltip: 'Last response {ago} ago · prompt cache ({ttl}) expires in {left}',
    tooltipExpired: 'Last response {ago} ago · prompt cache ({ttl}) expired: the next turn re-writes the whole context',
  },
  es: {
    expired: 'caducada',
    tooltip: 'Última respuesta hace {ago} · la cache del prompt ({ttl}) caduca en {left}',
    tooltipExpired: 'Última respuesta hace {ago} · la cache del prompt ({ttl}) ha caducado: el próximo turno reescribe todo el contexto',
  },
};

const pickDictionary = (locale: string | null | undefined) =>
  DICTS[(locale || '').trim()] ?? DICTS[(locale || '').split('-')[0]?.toLowerCase() ?? ''] ?? DICTS.en;

const format = (template: string, values: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? values[name] : match));

const host = connectHost();
const root = document.querySelector('#root');
if (!root) throw new Error('Missing root');

let dict = DICTS.en;
let snapshot: ComposerStatusSnapshot | null = null;

const style = document.createElement('style');
style.textContent = `
  html, body { margin: 0; background: transparent; overflow: hidden; }
  .ct-timer {
    display: inline-flex; align-items: center; gap: 4px;
    color: var(--oc-muted); font: 12px/1 var(--oc-font);
    padding: 0 4px; border-radius: var(--oc-radius); white-space: nowrap;
  }
  .ct-timer[data-tone="warning"] { color: var(--oc-warning-text); }
  .ct-timer[data-tone="error"] { color: var(--oc-error-text); }
  .ct-timer svg { flex-shrink: 0; }
`;
document.head.append(style);

const render = (): void => {
  root.replaceChildren();
  if (!snapshot) return;
  const timer = computeCacheTimer({
    providerId: snapshot.providerId,
    lastAssistantAt: snapshot.lastAssistantAt,
    now: Date.now(),
    cacheTtlMs: snapshot.cacheTtlMs ?? null,
    compacted: snapshot.compacted ?? false,
  });
  if (!timer) return;

  const ago = formatCacheDuration(timer.elapsed);
  const ttl = formatCacheDuration(timer.ttl);
  const span = document.createElement('span');
  span.className = 'ct-timer';
  span.dataset.composerCacheTimer = 'true';
  span.dataset.tone = timer.tone;
  span.title = timer.expired
    ? format(dict.tooltipExpired, { ago, ttl })
    : format(dict.tooltip, { ago, ttl, left: formatCacheDuration(timer.left) });
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('width', '14');
  icon.setAttribute('height', '14');
  icon.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('d', 'M12 22C7.03 22 3 17.97 3 13S7.03 4 12 4c2.13 0 4.08.74 5.62 1.97l-1.46 1.45A7.96 7.96 0 0 0 12 6a7 7 0 1 0 7 7c0-1.62-.56-3.1-1.5-4.28l1.46-1.45A9.95 9.95 0 0 1 21 13c0 4.97-4.03 9-9 9Zm-1-8V8h2v6h-2Zm-3-9h8v2H8V5Z');
  icon.append(path);
  span.append(icon, document.createTextNode(timer.expired ? dict.expired : timer.label));
  root.append(span);
};

host.onReady((context: HostReadyContext) => {
  applyHostReady(context, document.documentElement);
  dict = pickDictionary(context.locale);
  render();
  window.setInterval(render, TICK_MS);
});

host.onComposerStatus((next: ComposerStatusSnapshot | null, contributionId: string) => {
  if (contributionId !== CONTRIBUTION_ID) return;
  snapshot = next;
  render();
});

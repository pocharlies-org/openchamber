// Footer panels run everywhere the composer does; VS Code has no host footer.
const FOOTER_SUPPORT = Object.freeze({
  web: 'supported',
  desktop: 'supported',
  vscode: 'unsupported',
  hostedMobile: 'supported',
  capacitorMobile: 'supported',
});

const STREAM_METRICS_MANIFEST = Object.freeze({
  schemaVersion: 1,
  id: '@pocharlies/openchamber-stream-metrics',
  version: '0.1.0',
  displayName: { default: 'Stream Metrics', es: 'Métricas de streaming' },
  description: {
    default: 'Show live and final response metrics in the composer footer.',
    es: 'Muestra métricas en vivo y finales de la respuesta en el pie del compositor.',
  },
  engines: { openchamber: '>=1.18.2' },
  contributes: {
    composerMetrics: [{
      id: 'stream-metrics',
      placement: 'footer',
      mobile: 'compact',
      updateIntervalMs: 250,
      support: FOOTER_SUPPORT,
    }],
  },
});

const CACHE_TIMER_MANIFEST = Object.freeze({
  schemaVersion: 1,
  id: '@pocharlies/openchamber-cache-timer',
  version: '0.1.0',
  displayName: { default: 'Cache Timer', es: 'Temporizador de caché' },
  description: {
    default: 'Count down the prompt cache of the last turn in the composer footer.',
    es: 'Cuenta atrás de la caché del prompt del último turno en el pie del compositor.',
  },
  engines: { openchamber: '>=1.18.2' },
  contributes: {
    composerStatus: [{
      id: 'openchamber-builtin-cache-timer',
      placement: 'footer',
      support: FOOTER_SUPPORT,
    }],
  },
});

const getBuiltInUIPluginCatalog = () => [STREAM_METRICS_MANIFEST, CACHE_TIMER_MANIFEST];

export const registerUIPluginRoutes = (app) => {
  app.get('/api/ui-plugins/catalog', (_req, res) => {
    res.json({ schemaVersion: 1, plugins: getBuiltInUIPluginCatalog() });
  });
};

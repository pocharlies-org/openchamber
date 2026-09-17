const SIDE_CHAT_MANIFEST = Object.freeze({
  schemaVersion: 1,
  id: '@pocharlies/openchamber-side-chat',
  version: '0.1.0',
  displayName: { default: 'Side Chat', es: 'Chat lateral' },
  description: {
    default: 'Open an ephemeral child conversation while the parent keeps running.',
    es: 'Abre una conversación hija efímera mientras la principal sigue ejecutándose.',
  },
  engines: { openchamber: '>=1.18.2' },
  contributes: {
    sideConversations: [{
      id: 'side-chat',
      aliases: ['btw', 'side'],
      composerAction: {
        icon: 'chat-new',
        label: { default: 'Open side chat', es: 'Abrir chat lateral' },
      },
      ephemeral: true,
      nesting: 'forbid',
      activeTurnBoundary: 'last-completed',
      closePolicy: 'confirm-if-nonempty',
    }],
  },
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
      support: {
        web: 'supported',
        desktop: 'supported',
        vscode: 'unsupported',
        hostedMobile: 'supported',
        capacitorMobile: 'supported',
      },
    }],
  },
});

const COMPANY_OFFICE_MANIFEST = Object.freeze({
  schemaVersion: 1,
  id: '@pocharlies/openchamber-company-office',
  version: '0.1.0',
  displayName: { default: 'Company Office', es: 'Oficina de la empresa' },
  description: {
    default: 'Browse the configured company roster, live sessions, and Jira work.',
    es: 'Consulta el equipo configurado, las sesiones activas y el trabajo de Jira.',
  },
  engines: { openchamber: '>=1.18.2' },
  contributes: {
    workspaceViews: [{
      id: 'company-office',
      icon: 'home-office',
      label: { default: 'Company Office', es: 'Oficina de la empresa' },
      endpoint: '/api/company-office/snapshot',
      support: {
        web: 'supported',
        desktop: 'supported',
        vscode: 'unsupported',
        hostedMobile: 'supported',
        capacitorMobile: 'supported',
      },
    }],
  },
});

const getBuiltInUIPluginCatalog = ({ companyOfficeEnabled = false } = {}) => [
  ...(companyOfficeEnabled ? [COMPANY_OFFICE_MANIFEST] : []),
  SIDE_CHAT_MANIFEST,
  STREAM_METRICS_MANIFEST,
];

export const registerUIPluginRoutes = (app, options = {}) => {
  app.get('/api/ui-plugins/catalog', (_req, res) => {
    res.json({ schemaVersion: 1, plugins: getBuiltInUIPluginCatalog(options) });
  });
};

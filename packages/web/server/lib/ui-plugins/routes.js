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

const getBuiltInUIPluginCatalog = () => [SIDE_CHAT_MANIFEST];

export const registerUIPluginRoutes = (app) => {
  app.get('/api/ui-plugins/catalog', (_req, res) => {
    res.json({ schemaVersion: 1, plugins: getBuiltInUIPluginCatalog() });
  });
};

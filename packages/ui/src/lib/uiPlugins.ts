export type LocalizedText = { default: string; [locale: string]: string };

export type SideConversationContribution = {
  id: string;
  aliases: string[];
  composerAction: { icon: string; label: LocalizedText };
  ephemeral: true;
  nesting: 'forbid';
  activeTurnBoundary: 'last-completed';
  closePolicy: 'confirm-if-nonempty';
};

export type OpenChamberUIPluginManifestV1 = {
  schemaVersion: 1;
  id: string;
  version: string;
  displayName: LocalizedText;
  description: LocalizedText;
  engines: { openchamber: string };
  contributes: { sideConversations?: SideConversationContribution[] };
};

export const BUILTIN_SIDE_CHAT_UI_PLUGIN: OpenChamberUIPluginManifestV1 = {
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
      composerAction: { icon: 'chat-new', label: { default: 'Open side chat', es: 'Abrir chat lateral' } },
      ephemeral: true,
      nesting: 'forbid',
      activeTurnBoundary: 'last-completed',
      closePolicy: 'confirm-if-nonempty',
    }],
  },
};

const manifests = new Map<string, OpenChamberUIPluginManifestV1>([
  [BUILTIN_SIDE_CHAT_UI_PLUGIN.id, BUILTIN_SIDE_CHAT_UI_PLUGIN],
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

export const parseUIPluginManifest = (value: unknown): OpenChamberUIPluginManifestV1 => {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.id !== 'string' || typeof value.version !== 'string') {
    throw new Error('Invalid OpenChamber UI plugin manifest');
  }
  if (!isRecord(value.displayName) || typeof value.displayName.default !== 'string'
    || !isRecord(value.description) || typeof value.description.default !== 'string'
    || !isRecord(value.engines) || typeof value.engines.openchamber !== 'string' || !isRecord(value.contributes)) {
    throw new Error(`Invalid OpenChamber UI plugin manifest: ${value.id}`);
  }
  const sideConversations = value.contributes.sideConversations;
  if (sideConversations !== undefined && !Array.isArray(sideConversations)) {
    throw new Error(`Invalid side-conversation contributions: ${value.id}`);
  }
  for (const contribution of sideConversations ?? []) {
    if (!isRecord(contribution)
      || typeof contribution.id !== 'string'
      || !Array.isArray(contribution.aliases)
      || !contribution.aliases.every((alias) => typeof alias === 'string' && /^[a-z][a-z0-9-]*$/.test(alias))
      || !isRecord(contribution.composerAction)
      || typeof contribution.composerAction.icon !== 'string'
      || !isRecord(contribution.composerAction.label)
      || typeof contribution.composerAction.label.default !== 'string'
      || contribution.ephemeral !== true
      || contribution.nesting !== 'forbid'
      || contribution.activeTurnBoundary !== 'last-completed'
      || contribution.closePolicy !== 'confirm-if-nonempty') {
      throw new Error(`Invalid side-conversation contribution: ${value.id}`);
    }
  }
  return value as OpenChamberUIPluginManifestV1;
};

export const registerUIPluginManifest = (value: unknown): (() => void) => {
  const manifest = parseUIPluginManifest(value);
  if (manifests.has(manifest.id)) throw new Error(`UI plugin already registered: ${manifest.id}`);
  manifests.set(manifest.id, manifest);
  return () => { manifests.delete(manifest.id); };
};

export const getRegisteredUIPluginManifests = (): readonly OpenChamberUIPluginManifestV1[] =>
  Array.from(manifests.values());

export const getSideConversationContribution = (
  alias?: string,
  pluginManifests: readonly OpenChamberUIPluginManifestV1[] = getRegisteredUIPluginManifests(),
): SideConversationContribution | null => {
  const normalizedAlias = alias?.trim().toLowerCase();
  for (const plugin of pluginManifests) {
    for (const contribution of plugin.contributes.sideConversations ?? []) {
      if (!normalizedAlias || contribution.aliases.includes(normalizedAlias)) return contribution;
    }
  }
  return null;
};

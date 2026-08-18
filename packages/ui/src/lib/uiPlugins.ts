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

export type UIPluginSupportStatus = 'supported' | 'unsupported';
export type UIPluginRuntime = 'web' | 'desktop' | 'vscode' | 'hostedMobile' | 'capacitorMobile';

export type ComposerMetricsContribution = {
  id: string;
  placement: 'footer';
  mobile: 'compact';
  updateIntervalMs: number;
  support: {
    web: UIPluginSupportStatus;
    desktop: UIPluginSupportStatus;
    vscode: UIPluginSupportStatus;
    hostedMobile: UIPluginSupportStatus;
    capacitorMobile: UIPluginSupportStatus;
  };
};

export type WorkspaceViewContribution = {
  id: 'company-office';
  icon: 'home-office';
  label: LocalizedText;
  endpoint: '/api/company-office/snapshot';
  support: {
    web: UIPluginSupportStatus;
    desktop: UIPluginSupportStatus;
    vscode: UIPluginSupportStatus;
    hostedMobile: UIPluginSupportStatus;
    capacitorMobile: UIPluginSupportStatus;
  };
};

export type OpenChamberUIPluginManifestV1 = {
  schemaVersion: 1;
  id: string;
  version: string;
  displayName: LocalizedText;
  description: LocalizedText;
  engines: { openchamber: string };
  contributes: {
    sideConversations?: SideConversationContribution[];
    composerMetrics?: ComposerMetricsContribution[];
    workspaceViews?: WorkspaceViewContribution[];
  };
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

export const BUILTIN_STREAM_METRICS_UI_PLUGIN: OpenChamberUIPluginManifestV1 = {
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
};

const manifests = new Map<string, OpenChamberUIPluginManifestV1>([
  [BUILTIN_SIDE_CHAT_UI_PLUGIN.id, BUILTIN_SIDE_CHAT_UI_PLUGIN],
  [BUILTIN_STREAM_METRICS_UI_PLUGIN.id, BUILTIN_STREAM_METRICS_UI_PLUGIN],
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
  const composerMetrics = value.contributes.composerMetrics;
  if (composerMetrics !== undefined && !Array.isArray(composerMetrics)) {
    throw new Error(`Invalid composer-metrics contributions: ${value.id}`);
  }
  for (const contribution of composerMetrics ?? []) {
    const support = isRecord(contribution) ? contribution.support : null;
    const supportKeys = support ? Object.keys(support) : [];
    const supportValues = support ? Object.values(support) : [];
    if (!isRecord(contribution)
      || typeof contribution.id !== 'string'
      || !/^[a-z][a-z0-9-]*$/.test(contribution.id)
      || contribution.placement !== 'footer'
      || contribution.mobile !== 'compact'
      || typeof contribution.updateIntervalMs !== 'number'
      || !Number.isInteger(contribution.updateIntervalMs)
      || contribution.updateIntervalMs < 100
      || contribution.updateIntervalMs > 2_000
      || !support
      || supportKeys.length !== 5
      || !['web', 'desktop', 'vscode', 'hostedMobile', 'capacitorMobile'].every((key) => supportKeys.includes(key))
      || !supportValues.every((status) => status === 'supported' || status === 'unsupported')) {
      throw new Error(`Invalid composer-metrics contribution: ${value.id}`);
    }
  }
  const workspaceViews = value.contributes.workspaceViews;
  if (workspaceViews !== undefined && !Array.isArray(workspaceViews)) {
    throw new Error(`Invalid workspace-view contributions: ${value.id}`);
  }
  for (const contribution of workspaceViews ?? []) {
    const support = isRecord(contribution) ? contribution.support : null;
    const supportKeys = support ? Object.keys(support) : [];
    const supportValues = support ? Object.values(support) : [];
    if (!isRecord(contribution)
      || contribution.id !== 'company-office'
      || contribution.icon !== 'home-office'
      || !isRecord(contribution.label)
      || typeof contribution.label.default !== 'string'
      || contribution.endpoint !== '/api/company-office/snapshot'
      || !support
      || supportKeys.length !== 5
      || !['web', 'desktop', 'vscode', 'hostedMobile', 'capacitorMobile'].every((key) => supportKeys.includes(key))
      || !supportValues.every((status) => status === 'supported' || status === 'unsupported')) {
      throw new Error(`Invalid workspace-view contribution: ${value.id}`);
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

export const getComposerMetricsContributions = (
  pluginManifests: readonly OpenChamberUIPluginManifestV1[] = getRegisteredUIPluginManifests(),
): ComposerMetricsContribution[] => pluginManifests.flatMap(
  (plugin) => plugin.contributes.composerMetrics ?? [],
);

export const isComposerMetricsContributionSupported = (
  contribution: ComposerMetricsContribution,
  runtime: UIPluginRuntime,
): boolean => contribution.support[runtime] === 'supported';

export const getWorkspaceViewContributions = (
  pluginManifests: readonly OpenChamberUIPluginManifestV1[] = getRegisteredUIPluginManifests(),
): WorkspaceViewContribution[] => pluginManifests.flatMap(
  (plugin) => plugin.contributes.workspaceViews ?? [],
);

export const isWorkspaceViewContributionSupported = (
  contribution: WorkspaceViewContribution,
  runtime: UIPluginRuntime,
): boolean => contribution.support[runtime] === 'supported';

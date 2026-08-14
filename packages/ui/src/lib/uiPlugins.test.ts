import { describe, expect, test } from 'bun:test';
import {
  BUILTIN_SIDE_CHAT_UI_PLUGIN,
  BUILTIN_STREAM_METRICS_UI_PLUGIN,
  getComposerMetricsContributions,
  getRegisteredUIPluginManifests,
  getSideConversationContribution,
  isComposerMetricsContributionSupported,
  parseUIPluginManifest,
  registerUIPluginManifest,
} from './uiPlugins';

describe('declarative UI plugin registry', () => {
  test('publishes the side-chat aliases with safe host-owned policies', () => {
    expect(BUILTIN_SIDE_CHAT_UI_PLUGIN.schemaVersion).toBe(1);
    expect(BUILTIN_SIDE_CHAT_UI_PLUGIN.displayName.default).toBe('Side Chat');
    expect(getSideConversationContribution('btw')?.activeTurnBoundary).toBe('last-completed');
    expect(getSideConversationContribution('side')?.nesting).toBe('forbid');
    expect(getSideConversationContribution('unknown')).toBeNull();
  });

  test('publishes side chat and stream metrics without duplicate plugin or contribution IDs', () => {
    const manifests = getRegisteredUIPluginManifests();
    expect(manifests.map((plugin) => plugin.id)).toEqual([
      BUILTIN_SIDE_CHAT_UI_PLUGIN.id,
      BUILTIN_STREAM_METRICS_UI_PLUGIN.id,
    ]);
    expect(new Set(manifests.map((plugin) => plugin.id)).size).toBe(manifests.length);
    const contributions = getComposerMetricsContributions(manifests);
    expect(contributions).toHaveLength(1);
    expect(contributions[0]?.id).toBe('stream-metrics');
    expect(contributions[0]?.placement).toBe('footer');
    expect(contributions[0]?.updateIntervalMs).toBe(250);
    expect(new Set(contributions.map((contribution) => contribution.id)).size).toBe(contributions.length);
    expect(isComposerMetricsContributionSupported(contributions[0]!, 'web')).toBe(true);
    expect(isComposerMetricsContributionSupported(contributions[0]!, 'desktop')).toBe(true);
    expect(isComposerMetricsContributionSupported(contributions[0]!, 'hostedMobile')).toBe(true);
    expect(isComposerMetricsContributionSupported(contributions[0]!, 'capacitorMobile')).toBe(true);
    expect(isComposerMetricsContributionSupported(contributions[0]!, 'vscode')).toBe(false);
  });

  test('registers and unregisters a validated data-only contribution', () => {
    const manifest = structuredClone(BUILTIN_SIDE_CHAT_UI_PLUGIN);
    manifest.id = '@example/alternate-side-chat';
    manifest.contributes.sideConversations![0]!.aliases = ['aside'];
    const unregister = registerUIPluginManifest(manifest);
    expect(getSideConversationContribution('aside')?.id).toBe('side-chat');
    expect(getRegisteredUIPluginManifests().some((plugin) => plugin.id === manifest.id)).toBe(true);
    unregister();
    expect(getSideConversationContribution('aside')).toBeNull();
  });

  test('registers and unregisters composer metrics contributions', () => {
    const manifest = structuredClone(BUILTIN_STREAM_METRICS_UI_PLUGIN);
    manifest.id = '@example/alternate-stream-metrics';
    manifest.contributes.composerMetrics![0]!.id = 'alternate-metrics';
    const unregister = registerUIPluginManifest(manifest);
    expect(getComposerMetricsContributions().some((entry) => entry.id === 'alternate-metrics')).toBe(true);
    unregister();
    expect(getComposerMetricsContributions().some((entry) => entry.id === 'alternate-metrics')).toBe(false);
  });

  test('rejects executable or unsupported policy shapes', () => {
    const manifest = structuredClone(BUILTIN_SIDE_CHAT_UI_PLUGIN) as unknown as Record<string, unknown>;
    const contributes = manifest.contributes as { sideConversations: Array<Record<string, unknown>> };
    contributes.sideConversations[0]!.closePolicy = 'run-plugin-code';
    expect(() => parseUIPluginManifest(manifest)).toThrow('Invalid side-conversation contribution');
  });

  test('rejects unsafe composer metrics policies', () => {
    const manifest = structuredClone(BUILTIN_STREAM_METRICS_UI_PLUGIN) as unknown as Record<string, unknown>;
    const contributes = manifest.contributes as { composerMetrics: Array<Record<string, unknown>> };
    contributes.composerMetrics[0]!.updateIntervalMs = 1;
    expect(() => parseUIPluginManifest(manifest)).toThrow('Invalid composer-metrics contribution');
  });

  test('rejects composer metrics support maps that omit or invent runtimes', () => {
    const missing = structuredClone(BUILTIN_STREAM_METRICS_UI_PLUGIN) as unknown as Record<string, unknown>;
    const missingContribution = (missing.contributes as { composerMetrics: Array<Record<string, unknown>> }).composerMetrics[0]!;
    delete (missingContribution.support as Record<string, unknown>).vscode;
    (missingContribution.support as Record<string, unknown>).futureRuntime = 'unsupported';
    expect(() => parseUIPluginManifest(missing)).toThrow('Invalid composer-metrics contribution');
  });
});

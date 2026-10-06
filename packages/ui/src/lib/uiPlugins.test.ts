import { describe, expect, test } from 'bun:test';
import {
  BUILTIN_STREAM_METRICS_UI_PLUGIN,
  getComposerMetricsContributions,
  getComposerStatusContributions,
  getRegisteredUIPluginManifests,
  isComposerMetricsContributionSupported,
  isComposerStatusContributionSupported,
  parseUIPluginManifest,
  registerUIPluginManifest,
} from './uiPlugins';

const composerStatusManifest = (mutate?: (contribution: Record<string, unknown>) => void) => {
  const manifest = structuredClone(BUILTIN_STREAM_METRICS_UI_PLUGIN) as unknown as Record<string, unknown>;
  manifest.id = '@example/session-status';
  const contributes = manifest.contributes as Record<string, unknown>;
  delete contributes.composerMetrics;
  contributes.composerStatus = [{
    id: 'session-status',
    placement: 'footer',
    support: {
      web: 'supported',
      desktop: 'supported',
      vscode: 'unsupported',
      hostedMobile: 'supported',
      capacitorMobile: 'supported',
    },
  }];
  mutate?.((contributes.composerStatus as Array<Record<string, unknown>>)[0]!);
  return manifest;
};

describe('declarative UI plugin registry', () => {
  test('publishes stream metrics without duplicate plugin or contribution IDs', () => {
    const manifests = getRegisteredUIPluginManifests();
    expect(manifests.map((plugin) => plugin.id)).toEqual([BUILTIN_STREAM_METRICS_UI_PLUGIN.id]);
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

  test('registers and unregisters composer metrics contributions', () => {
    const manifest = structuredClone(BUILTIN_STREAM_METRICS_UI_PLUGIN);
    manifest.id = '@example/alternate-stream-metrics';
    manifest.contributes.composerMetrics![0]!.id = 'alternate-metrics';
    const unregister = registerUIPluginManifest(manifest);
    expect(getComposerMetricsContributions().some((entry) => entry.id === 'alternate-metrics')).toBe(true);
    unregister();
    expect(getComposerMetricsContributions().some((entry) => entry.id === 'alternate-metrics')).toBe(false);
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

  test('the builtin publishes no composer status contributions', () => {
    expect(getComposerStatusContributions(getRegisteredUIPluginManifests())).toEqual([]);
  });

  test('registers and unregisters composer status contributions', () => {
    const unregister = registerUIPluginManifest(composerStatusManifest());
    const contributions = getComposerStatusContributions().filter((entry) => entry.id === 'session-status');
    expect(contributions).toHaveLength(1);
    expect(contributions[0]?.placement).toBe('footer');
    expect(isComposerStatusContributionSupported(contributions[0]!, 'web')).toBe(true);
    expect(isComposerStatusContributionSupported(contributions[0]!, 'vscode')).toBe(false);
    unregister();
    expect(getComposerStatusContributions().some((entry) => entry.id === 'session-status')).toBe(false);
  });

  test('rejects duplicate composer status contribution ids inside one manifest', () => {
    expect(parseUIPluginManifest(composerStatusManifest()).contributes.composerStatus?.[0]?.id).toBe('session-status');
    const manifest = composerStatusManifest();
    const contributes = manifest.contributes as { composerStatus: Array<Record<string, unknown>> };
    contributes.composerStatus.push({ ...contributes.composerStatus[0]! });
    expect(() => parseUIPluginManifest(manifest)).toThrow('Invalid composer-status contribution');
  });

  test('rejects invalid composer status placements', () => {
    expect(() => parseUIPluginManifest(composerStatusManifest((contribution) => {
      contribution.placement = 'header';
    }))).toThrow('Invalid composer-status contribution');
    const manifest = composerStatusManifest();
    (manifest.contributes as { composerStatus: unknown }).composerStatus = { id: 'session-status' };
    expect(() => parseUIPluginManifest(manifest)).toThrow('Invalid composer-status contributions');
  });

  test('rejects composer status support maps that omit or invent runtimes', () => {
    expect(() => parseUIPluginManifest(composerStatusManifest((contribution) => {
      delete (contribution.support as Record<string, unknown>).vscode;
    }))).toThrow('Invalid composer-status contribution');
    expect(() => parseUIPluginManifest(composerStatusManifest((contribution) => {
      (contribution.support as Record<string, unknown>).futureRuntime = 'unsupported';
    }))).toThrow('Invalid composer-status contribution');
    expect(() => parseUIPluginManifest(composerStatusManifest((contribution) => {
      (contribution.support as Record<string, unknown>).web = 'sometimes';
    }))).toThrow('Invalid composer-status contribution');
  });

  test('rejects composer status ids that are not lowercase slugs', () => {
    expect(() => parseUIPluginManifest(composerStatusManifest((contribution) => {
      contribution.id = 'Session_Status';
    }))).toThrow('Invalid composer-status contribution');
  });
});

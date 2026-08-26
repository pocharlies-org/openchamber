import { describe, expect, test } from 'bun:test';
import {
  BUILTIN_SIDE_CHAT_UI_PLUGIN,
  getRegisteredUIPluginManifests,
  getSideConversationContribution,
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

  test('rejects executable or unsupported policy shapes', () => {
    const manifest = structuredClone(BUILTIN_SIDE_CHAT_UI_PLUGIN) as unknown as Record<string, unknown>;
    const contributes = manifest.contributes as { sideConversations: Array<Record<string, unknown>> };
    contributes.sideConversations[0]!.closePolicy = 'run-plugin-code';
    expect(() => parseUIPluginManifest(manifest)).toThrow('Invalid side-conversation contribution');
  });
});

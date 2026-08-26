import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { BUILTIN_SIDE_CHAT_UI_PLUGIN } from '@/lib/uiPlugins';

const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;
mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));

const {
  findEnabledSideConversationContribution,
  isUIPluginEnabled,
  useUIPluginsStore,
} = await import('./useUIPluginsStore');

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

describe('useUIPluginsStore', () => {
  beforeEach(() => {
    console.error = mock(() => undefined);
    useUIPluginsStore.setState({
      catalog: [BUILTIN_SIDE_CHAT_UI_PLUGIN],
      disabledPluginIds: [],
      isLoading: false,
      loadError: false,
    });
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  });

  test('loads and validates the server catalog', async () => {
    globalThis.fetch = mock(async () => response({ plugins: [BUILTIN_SIDE_CHAT_UI_PLUGIN] })) as unknown as typeof fetch;
    expect(await useUIPluginsStore.getState().loadCatalog()).toBe(true);
    expect(useUIPluginsStore.getState().catalog[0]?.id).toBe(BUILTIN_SIDE_CHAT_UI_PLUGIN.id);
    expect(useUIPluginsStore.getState().loadError).toBe(false);
  });

  test('preserves the last valid catalog when the authoritative fetch fails', async () => {
    const previousCatalog = useUIPluginsStore.getState().catalog;
    globalThis.fetch = mock(async () => response({ error: 'offline' }, 503)) as unknown as typeof fetch;
    expect(await useUIPluginsStore.getState().loadCatalog()).toBe(false);
    expect(useUIPluginsStore.getState().catalog).toBe(previousCatalog);
    expect(useUIPluginsStore.getState().loadError).toBe(true);
  });

  test('rejects malformed catalogs without partially replacing valid entries', async () => {
    const previousCatalog = useUIPluginsStore.getState().catalog;
    globalThis.fetch = mock(async () => response({ plugins: [BUILTIN_SIDE_CHAT_UI_PLUGIN, { schemaVersion: 1 }] })) as unknown as typeof fetch;
    expect(await useUIPluginsStore.getState().loadCatalog()).toBe(false);
    expect(useUIPluginsStore.getState().catalog).toBe(previousCatalog);
  });

  test('enablement controls contribution lookup without mutating the catalog', () => {
    useUIPluginsStore.getState().setPluginEnabled(BUILTIN_SIDE_CHAT_UI_PLUGIN.id, false);
    const state = useUIPluginsStore.getState();
    expect(isUIPluginEnabled(state, BUILTIN_SIDE_CHAT_UI_PLUGIN.id)).toBe(false);
    expect(findEnabledSideConversationContribution(state, 'btw')).toBeNull();
    expect(state.catalog).toHaveLength(1);
    useUIPluginsStore.getState().setPluginEnabled(BUILTIN_SIDE_CHAT_UI_PLUGIN.id, true);
    expect(findEnabledSideConversationContribution(useUIPluginsStore.getState(), 'side')).not.toBeNull();
  });

  test('a stale catalog response cannot overwrite a newer runtime response', async () => {
    let resolveFirst: ((response: Response) => void) | undefined;
    const alternate = structuredClone(BUILTIN_SIDE_CHAT_UI_PLUGIN);
    alternate.id = '@example/new-runtime';
    globalThis.fetch = mock(() => {
      if (!resolveFirst) {
        return new Promise<Response>((resolve) => { resolveFirst = resolve; });
      }
      return Promise.resolve(response({ plugins: [alternate] }));
    }) as unknown as typeof fetch;

    const staleRequest = useUIPluginsStore.getState().loadCatalog();
    const currentRequest = useUIPluginsStore.getState().loadCatalog();
    expect(await currentRequest).toBe(true);
    resolveFirst?.(response({ plugins: [BUILTIN_SIDE_CHAT_UI_PLUGIN] }));
    expect(await staleRequest).toBe(false);
    expect(useUIPluginsStore.getState().catalog[0]?.id).toBe(alternate.id);
  });

  test('malformed persisted enablement fails open instead of breaking contribution lookup', () => {
    const malformed = { ...useUIPluginsStore.getState(), disabledPluginIds: null } as unknown as Parameters<typeof isUIPluginEnabled>[0];
    expect(isUIPluginEnabled(malformed, BUILTIN_SIDE_CHAT_UI_PLUGIN.id)).toBe(true);
  });
});

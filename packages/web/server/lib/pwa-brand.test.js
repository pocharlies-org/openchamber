import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APP_NAME, PWA_DESCRIPTION, PWA_THEME_COLOR } from './brand.js';
import { registerPwaManifestRoute } from './opencode/pwa-manifest-routes.js';

const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');

const serveManifest = async () => {
  const routes = new Map();
  registerPwaManifestRoute({ get: (route, handler) => routes.set(route, handler) }, {
    process: { env: {} },
    resolveProjectDirectory: async () => ({ directory: null }),
    buildOpenCodeUrl: () => 'http://127.0.0.1:1',
    getOpenCodeAuthHeaders: () => ({}),
    readSettingsFromDiskMigrated: async () => ({}),
    normalizePwaAppName: (value, fallback) => (typeof value === 'string' && value.trim() ? value.trim() : fallback),
    normalizePwaOrientation: () => '',
    isRequestAuthorized: async () => true,
  });
  let body = '';
  await routes.get('/manifest.webmanifest')(
    { query: {}, headers: {}, protocol: 'http', get: () => 'localhost' },
    { setHeader() { return this; }, type() { return this; }, send(value) { body = value; return this; }, status() { return this; }, json(value) { body = JSON.stringify(value); return this; } },
  );
  return JSON.parse(body);
};

describe('PWA brand', () => {
  it('the endpoint, site.webmanifest and index.html carry the same name, description and theme colour', async () => {
    const endpoint = await serveManifest();
    const stat = JSON.parse(read('../../public/site.webmanifest'));
    const html = read('../../index.html');

    expect(endpoint.name).toBe(APP_NAME);
    expect(endpoint.short_name).toBe(APP_NAME);
    expect(endpoint.description).toBe(PWA_DESCRIPTION);
    expect(endpoint.theme_color).toBe(PWA_THEME_COLOR);

    for (const key of ['name', 'short_name', 'description', 'theme_color']) {
      expect(stat[key]).toBe(endpoint[key]);
    }
    expect(html).toContain(`const defaultAppName = '${APP_NAME}'`);
    expect(html).toContain(`description: '${PWA_DESCRIPTION}'`);
    expect(html).toContain(`theme_color: '${PWA_THEME_COLOR}'`);
  });
});

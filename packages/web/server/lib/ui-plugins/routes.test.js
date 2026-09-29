import express from 'express';
import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { registerUIPluginRoutes } from './routes.js';

describe('UI plugin catalog routes', () => {
  test('publishes the declarative stream-metrics and cache-timer contracts', async () => {
    const app = express();
    registerUIPluginRoutes(app);
    const response = await request(app).get('/api/ui-plugins/catalog').expect(200);
    expect(response.body.schemaVersion).toBe(1);
    expect(response.body.plugins).toHaveLength(2);
    expect(response.body.plugins[0]).toMatchObject({
      id: '@pocharlies/openchamber-stream-metrics',
      contributes: { composerMetrics: [{ placement: 'footer', mobile: 'compact', updateIntervalMs: 250 }] },
    });
    expect(new Set(response.body.plugins.map((plugin) => plugin.id))).toEqual(
      new Set(['@pocharlies/openchamber-stream-metrics', '@pocharlies/openchamber-cache-timer']),
    );
    expect(JSON.stringify(response.body)).not.toContain('javascript');
    expect(JSON.stringify(response.body)).not.toContain('bundle');
  });

  test('matches the packaged plugin manifest', async () => {
    const app = express();
    registerUIPluginRoutes(app);
    const response = await request(app).get('/api/ui-plugins/catalog').expect(200);
    // Only stream-metrics lives in plugins/; the cache-timer manifest is
    // server-side only, its guest ships as a built-in extension.
    const packaged = await Promise.all([
      'openchamber-stream-metrics',
    ].map(async (name) => JSON.parse(await readFile(
      new URL(`../../../../../plugins/${name}/openchamber.ui-plugin.json`, import.meta.url),
      'utf8',
    ))));
    expect(response.body.plugins.filter((plugin) => plugin.id === '@pocharlies/openchamber-stream-metrics')).toEqual(packaged);
    const cacheTimer = response.body.plugins.find((plugin) => plugin.id === '@pocharlies/openchamber-cache-timer');
    expect(cacheTimer).toMatchObject({
      contributes: {
        composerStatus: [{
          id: 'openchamber-builtin-cache-timer',
          placement: 'footer',
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
  });
});

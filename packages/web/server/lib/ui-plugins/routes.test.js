import express from 'express';
import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { registerUIPluginRoutes } from './routes.js';

describe('UI plugin catalog routes', () => {
  test('publishes the declarative side-chat and stream-metrics contracts', async () => {
    const app = express();
    registerUIPluginRoutes(app);
    const response = await request(app).get('/api/ui-plugins/catalog').expect(200);
    expect(response.body.schemaVersion).toBe(1);
    expect(response.body.plugins).toHaveLength(2);
    expect(response.body.plugins[0]).toMatchObject({
      id: '@pocharlies/openchamber-side-chat',
      contributes: { sideConversations: [{ aliases: ['btw', 'side'], nesting: 'forbid' }] },
    });
    expect(response.body.plugins[1]).toMatchObject({
      id: '@pocharlies/openchamber-stream-metrics',
      contributes: { composerMetrics: [{ placement: 'footer', mobile: 'compact', updateIntervalMs: 250 }] },
    });
    expect(new Set(response.body.plugins.map((plugin) => plugin.id)).size).toBe(2);
    expect(JSON.stringify(response.body)).not.toContain('javascript');
    expect(JSON.stringify(response.body)).not.toContain('bundle');
  });

  test('matches the packaged plugin manifest', async () => {
    const app = express();
    registerUIPluginRoutes(app);
    const response = await request(app).get('/api/ui-plugins/catalog').expect(200);
    const packaged = await Promise.all([
      'openchamber-side-chat',
      'openchamber-stream-metrics',
    ].map(async (name) => JSON.parse(await readFile(
      new URL(`../../../../../plugins/${name}/openchamber.ui-plugin.json`, import.meta.url),
      'utf8',
    ))));
    expect(response.body.plugins).toEqual(packaged);
  });
});

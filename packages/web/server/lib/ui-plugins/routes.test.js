import express from 'express';
import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { registerUIPluginRoutes } from './routes.js';

describe('UI plugin catalog routes', () => {
  test('publishes only the declarative built-in side-chat contract', async () => {
    const app = express();
    registerUIPluginRoutes(app);
    const response = await request(app).get('/api/ui-plugins/catalog').expect(200);
    expect(response.body.schemaVersion).toBe(1);
    expect(response.body.plugins).toHaveLength(1);
    expect(response.body.plugins[0]).toMatchObject({
      id: '@pocharlies/openchamber-side-chat',
      contributes: { sideConversations: [{ aliases: ['btw', 'side'], nesting: 'forbid' }] },
    });
    expect(JSON.stringify(response.body)).not.toContain('javascript');
    expect(JSON.stringify(response.body)).not.toContain('bundle');
  });

  test('matches the packaged plugin manifest', async () => {
    const app = express();
    registerUIPluginRoutes(app);
    const response = await request(app).get('/api/ui-plugins/catalog').expect(200);
    const packaged = JSON.parse(await readFile(
      new URL('../../../../../plugins/openchamber-side-chat/openchamber.ui-plugin.json', import.meta.url),
      'utf8',
    ));
    expect(response.body.plugins[0]).toEqual(packaged);
  });
});

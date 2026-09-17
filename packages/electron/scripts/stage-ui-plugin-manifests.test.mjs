import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { BUILT_IN_UI_PLUGIN_NAMES, stageUIPluginManifests } from './stage-ui-plugin-manifests.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');

test('stages declarative UI plugin manifests for packaged Desktop', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-ui-plugins-'));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const destinationDir = path.join(tempDir, 'ui-plugins');

  await stageUIPluginManifests({
    pluginsDir: path.join(repoRoot, 'plugins'),
    destinationDir,
  });

  const manifests = await Promise.all(BUILT_IN_UI_PLUGIN_NAMES.map(async (pluginName) => {
    const staged = JSON.parse(await fs.readFile(
      path.join(destinationDir, pluginName, 'openchamber.ui-plugin.json'),
      'utf8',
    ));
    const source = JSON.parse(await fs.readFile(
      path.join(repoRoot, 'plugins', pluginName, 'openchamber.ui-plugin.json'),
      'utf8',
    ));
    assert.deepEqual(staged, source);
    return staged;
  }));

  assert.deepEqual(manifests.map((manifest) => manifest.id), [
    '@pocharlies/openchamber-company-office',
    '@pocharlies/openchamber-side-chat',
    '@pocharlies/openchamber-stream-metrics',
  ]);
  assert.equal(manifests[0].contributes.workspaceViews.length, 1);
  assert.equal(manifests[1].contributes.sideConversations.length, 1);
  assert.equal(manifests[2].contributes.composerMetrics.length, 1);

  const packageManifest = JSON.parse(await fs.readFile(path.join(repoRoot, 'packages', 'electron', 'package.json'), 'utf8'));
  assert.ok(packageManifest.build.extraResources.some((resource) => (
    resource.from === 'resources/ui-plugins' && resource.to === 'ui-plugins'
  )));
});

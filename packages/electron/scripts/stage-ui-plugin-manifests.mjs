import fs from 'node:fs/promises';
import path from 'node:path';

export const BUILT_IN_UI_PLUGIN_NAMES = Object.freeze([
  'openchamber-side-chat',
  'openchamber-stream-metrics',
]);

export async function stageUIPluginManifests({ pluginsDir, destinationDir }) {
  const stagingDir = await fs.mkdtemp(`${destinationDir}-staging-`);
  try {
    for (const pluginName of BUILT_IN_UI_PLUGIN_NAMES) {
      const pluginDestinationDir = path.join(stagingDir, pluginName);
      await fs.mkdir(pluginDestinationDir, { recursive: true });
      await fs.copyFile(
        path.join(pluginsDir, pluginName, 'openchamber.ui-plugin.json'),
        path.join(pluginDestinationDir, 'openchamber.ui-plugin.json'),
      );
    }
    await fs.rm(destinationDir, { recursive: true, force: true });
    await fs.rename(stagingDir, destinationDir);
  } catch (error) {
    await fs.rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

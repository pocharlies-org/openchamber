import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEngineSessionMetadata, ENGINE_METADATA_FILE_NAME } from './engine-metadata-store.js';
import { createSessionMetadataStore } from './session-metadata-store.js';

const dirs = [];
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-engine-metadata-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const owns = (id) => id.startsWith('ses_ccc');

describe('engine session metadata', () => {
  it('owns only the engine\'s ids, and a session without metadata reads as {}', async () => {
    const store = createEngineSessionMetadata({ dataDir: tempDir(), owns });
    expect(store.owns('ses_ccc1')).toBe(true);
    expect(store.owns('ses_native')).toBe(false);
    await expect(store.read('ses_ccc1')).resolves.toEqual({});
  });

  it('persists across a restart and forgets an emptied record', async () => {
    const dataDir = tempDir();
    const first = createEngineSessionMetadata({ dataDir, owns });
    await first.write('ses_ccc1', { openchamber: { pins: ['m1'] } });
    const reread = createEngineSessionMetadata({ dataDir, owns });
    await expect(reread.read('ses_ccc1')).resolves.toEqual({ openchamber: { pins: ['m1'] } });
    expect(reread.peek('ses_ccc1')).toEqual({ openchamber: { pins: ['m1'] } });

    await reread.write('ses_ccc1', {});
    const afterEmpty = JSON.parse(fs.readFileSync(path.join(dataDir, ENGINE_METADATA_FILE_NAME), 'utf8'));
    expect(afterEmpty).toEqual({});
  });

  it('moves an unreadable file aside instead of overwriting it', async () => {
    const dataDir = tempDir();
    fs.writeFileSync(path.join(dataDir, ENGINE_METADATA_FILE_NAME), '{not json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createEngineSessionMetadata({ dataDir, owns });
    await expect(store.read('ses_ccc1')).resolves.toEqual({});
    warn.mockRestore();
    expect(fs.readdirSync(dataDir).some((name) => name.startsWith(`${ENGINE_METADATA_FILE_NAME}.corrupt-`))).toBe(true);
  });
});

describe('engine session metadata write failures', () => {
  it('rolls a failed write back, so memory never claims what the disk does not hold', async () => {
    const dataDir = tempDir();
    const failing = {
      ...fs.promises,
      writeFile: vi.fn(async () => { throw new Error('disk full'); }),
    };
    const store = createEngineSessionMetadata({ dataDir, owns, fsPromises: failing });
    await expect(store.write('ses_ccc1', { openchamber: { pins: ['m1'] } })).rejects.toThrow('disk full');
    await expect(store.read('ses_ccc1')).resolves.toEqual({});
    expect(store.peek('ses_ccc1')).toBeUndefined();
  });

  it('serializes writes: the last one wins on disk', async () => {
    const dataDir = tempDir();
    const store = createEngineSessionMetadata({ dataDir, owns });
    await Promise.all([
      store.write('ses_ccc1', { n: 1 }),
      store.write('ses_ccc1', { n: 2 }),
      store.write('ses_ccc1', { n: 3 }),
    ]);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, ENGINE_METADATA_FILE_NAME), 'utf8'));
    expect(onDisk).toEqual({ ses_ccc1: { n: 3 } });
  });
});

describe('session metadata store with an engine of its own', () => {
  const openCode = () => ({
    read: vi.fn(async () => ({ opencode: true })),
    write: vi.fn(async () => {}),
  });

  it('keeps a Claude session\'s metadata in the engine store and never asks OpenCode', async () => {
    const dataDir = tempDir();
    const upstream = openCode();
    const engineMetadata = createEngineSessionMetadata({ dataDir, owns });
    const store = createSessionMetadataStore({ dataDir, openCode: upstream, engineMetadata });

    const merged = await store.setSessionMetadata('ses_ccc1', { openchamber: { btwSessionID: 'ses_ccc2' } });
    expect(merged).toEqual({ openchamber: { btwSessionID: 'ses_ccc2' } });
    await store.setSessionMetadata('ses_ccc1', { openchamber: { knowledge: 'sig-1' } });
    await expect(store.get('ses_ccc1')).resolves.toEqual({ openchamber: { btwSessionID: 'ses_ccc2', knowledge: 'sig-1' } });
    expect(upstream.read).not.toHaveBeenCalled();
    expect(upstream.write).not.toHaveBeenCalled();
  });

  it('still writes an OpenCode session\'s metadata on OpenCode', async () => {
    const dataDir = tempDir();
    const upstream = openCode();
    const store = createSessionMetadataStore({ dataDir, openCode: upstream, engineMetadata: createEngineSessionMetadata({ dataDir, owns }) });
    await store.setSessionMetadata('ses_native', { openchamber: { pinned: true } });
    expect(upstream.write).toHaveBeenCalledWith('ses_native', { opencode: true, openchamber: { pinned: true } }, { directory: '' });
  });
});

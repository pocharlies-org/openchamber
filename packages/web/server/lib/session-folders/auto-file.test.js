import { describe, expect, it } from 'vitest';
import path from 'path';

import { createCompanyFolderAutoFile, COMPANY_FOLDER_NAME } from './auto-file.js';

/** A fs.promises backed by an in-memory map, so the test needs no real disk. */
const createMemoryFs = (initial = {}) => {
  const files = new Map(Object.entries(initial));
  return {
    files,
    readFile: async (file) => {
      if (!files.has(file)) {
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      }
      return files.get(file);
    },
    writeFile: async (file, contents) => { files.set(file, contents); },
    rename: async (from, to) => { files.set(to, files.get(from)); files.delete(from); },
    unlink: async (file) => { files.delete(file); },
    mkdir: async () => {},
  };
};

const FILE = path.join('/data', 'sessions-directories.json');
const companyFolder = (snapshot) => (snapshot.foldersMap['/home/dibanez/k8s'] ?? [])
  .find((folder) => folder.name === COMPANY_FOLDER_NAME);

const readSnapshot = (fs) => JSON.parse(fs.files.get(FILE));

describe('createCompanyFolderAutoFile', () => {
  it('creates the Compañía folder and files a session under its project scope', async () => {
    const fs = createMemoryFs();
    const autoFile = createCompanyFolderAutoFile({ fsPromises: fs, path, foldersFilePath: FILE });

    await autoFile.fileMany([{ sessionId: 'ses_ccc1', scopeKey: '/home/dibanez/k8s' }]);

    const snapshot = readSnapshot(fs);
    expect(snapshot.version).toBe(1);
    expect(companyFolder(snapshot).sessionIds).toEqual(['ses_ccc1']);
  });

  it('is idempotent: filing the same session twice adds it once', async () => {
    const fs = createMemoryFs();
    const autoFile = createCompanyFolderAutoFile({ fsPromises: fs, path, foldersFilePath: FILE });

    await autoFile.fileMany([{ sessionId: 'ses_ccc1', scopeKey: '/home/dibanez/k8s' }]);
    await autoFile.fileMany([{ sessionId: 'ses_ccc1', scopeKey: '/home/dibanez/k8s' }]);

    expect(companyFolder(readSnapshot(fs)).sessionIds).toEqual(['ses_ccc1']);
  });

  it('reuses an existing Compañía folder and leaves other folders untouched', async () => {
    const existing = {
      version: 1,
      updatedAt: 100,
      collapsedFolderIds: ['f-personal'],
      foldersMap: {
        '/home/dibanez/k8s': [
          { id: 'f-personal', name: 'Personal', sessionIds: ['ses_a'], createdAt: 1, parentId: null },
          { id: 'f-comp', name: COMPANY_FOLDER_NAME, sessionIds: ['ses_old'], createdAt: 2, parentId: null },
        ],
      },
    };
    const fs = createMemoryFs({ [FILE]: JSON.stringify(existing) });
    const autoFile = createCompanyFolderAutoFile({ fsPromises: fs, path, foldersFilePath: FILE });

    await autoFile.fileMany([{ sessionId: 'ses_ccc9', scopeKey: '/home/dibanez/k8s' }]);

    const snapshot = readSnapshot(fs);
    expect(snapshot.foldersMap['/home/dibanez/k8s']).toHaveLength(2);
    expect(companyFolder(snapshot).id).toBe('f-comp');
    expect(companyFolder(snapshot).sessionIds).toEqual(['ses_old', 'ses_ccc9']);
    expect(snapshot.foldersMap['/home/dibanez/k8s'][0].sessionIds).toEqual(['ses_a']);
    expect(snapshot.collapsedFolderIds).toEqual(['f-personal']);
    expect(snapshot.updatedAt).toBeGreaterThan(100);
  });

  it('skips sessions with no project scope and empty ids', async () => {
    const fs = createMemoryFs();
    const autoFile = createCompanyFolderAutoFile({ fsPromises: fs, path, foldersFilePath: FILE });

    await autoFile.fileMany([
      { sessionId: 'ses_ccc1', scopeKey: null },
      { sessionId: '', scopeKey: '/home/dibanez/k8s' },
    ]);

    expect(fs.files.has(FILE)).toBe(false);
  });

  it('never overwrites a snapshot it cannot understand', async () => {
    const corrupt = '{ not json';
    const fs = createMemoryFs({ [FILE]: corrupt });
    const autoFile = createCompanyFolderAutoFile({ fsPromises: fs, path, foldersFilePath: FILE });

    await autoFile.fileMany([{ sessionId: 'ses_ccc1', scopeKey: '/home/dibanez/k8s' }]);

    // The write is fire-and-forget and swallowed; the corrupt file is left alone.
    expect(fs.files.get(FILE)).toBe(corrupt);
  });

  it('bumps updatedAt above a future-dated snapshot so the write is not ignored', async () => {
    const future = {
      version: 1, updatedAt: Date.now() + 10_000, collapsedFolderIds: [], foldersMap: {},
    };
    const fs = createMemoryFs({ [FILE]: JSON.stringify(future) });
    const autoFile = createCompanyFolderAutoFile({ fsPromises: fs, path, foldersFilePath: FILE });

    await autoFile.fileMany([{ sessionId: 'ses_ccc1', scopeKey: '/home/dibanez/k8s' }]);

    expect(readSnapshot(fs).updatedAt).toBeGreaterThan(future.updatedAt);
  });
});

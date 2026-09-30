/**
 * Server-side filing of company sessions into the "Compañía" folder.
 *
 * The folder used to be filled by a browser hook (`useCompanyAutoFolders.ts`)
 * that only saw the sessions the one tab had loaded and remembered what it had
 * filed in that tab's `localStorage`. The result, measured 2026-09-30: with a
 * few hundred company sessions in the store the folder held 7 — a session only
 * landed if some client happened to load it and run the hook, and a client that
 * marked it filed but whose debounced write never landed lost it for good. Each
 * client (Claude Desktop, VS Code, the web) has its own `localStorage`, so the
 * grouping never agreed across them.
 *
 * This makes the server the single source of truth: the Claude backend already
 * stamps `metadata.company` on a session it recognizes as a bot dispatch
 * (`lib/claude/company-sessions.js`), so on the list read it also drops the
 * session into the folder in `sessions-directories.json`. Every client reads the
 * same folder, so the grouping is identical everywhere and survives a reload.
 *
 * The write goes through the same snapshot the client POSTs (`routes.js`), so it
 * respects the `updatedAt` last-writer-wins discipline: a client that loaded the
 * folder after a filing carries those ids back and keeps them.
 */

const isObjectRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isValidSnapshot = (snapshot) => (
  isObjectRecord(snapshot)
  && snapshot.version === 1
  && isObjectRecord(snapshot.foldersMap)
);

export const COMPANY_FOLDER_NAME = 'Compañía';

/**
 * @param {{
 *   fsPromises: import('fs').promises,
 *   path: typeof import('path'),
 *   foldersFilePath: string,
 *   folderName?: string,
 *   createFolderId?: () => string,
 *   now?: () => number,
 * }} deps
 */
export const createCompanyFolderAutoFile = (deps) => {
  const {
    fsPromises,
    path,
    foldersFilePath,
    folderName = COMPANY_FOLDER_NAME,
    createFolderId = () => `company-${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`,
    now = () => Date.now(),
  } = deps;

  /** Session ids already ensured this process, so a repeat list is a no-op. */
  const filed = new Set();
  /** One write at a time; the file is a whole-snapshot replace, not a patch. */
  let queue = Promise.resolve();

  const readSnapshot = async () => {
    const raw = await fsPromises.readFile(foldersFilePath, 'utf8').catch((error) => {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    });
    if (!raw) {
      return { version: 1, foldersMap: {}, collapsedFolderIds: [], updatedAt: 1 };
    }
    const parsed = JSON.parse(raw);
    if (!isValidSnapshot(parsed)) {
      // Never overwrite a file we cannot understand: the client's GET would 500
      // on it too, and repairing it is the client's call, not a side effect of
      // a background filing.
      throw new Error('session folders snapshot has an unexpected shape');
    }
    if (!Array.isArray(parsed.collapsedFolderIds)) parsed.collapsedFolderIds = [];
    return parsed;
  };

  const writeSnapshot = async (snapshot) => {
    const serialized = JSON.stringify(snapshot, null, 2);
    const tmp = `${foldersFilePath}.tmp-${process.pid}-${now()}-${Math.random().toString(16).slice(2)}`;
    await fsPromises.mkdir(path.dirname(foldersFilePath), { recursive: true });
    try {
      await fsPromises.writeFile(tmp, serialized, 'utf8');
      await fsPromises.rename(tmp, foldersFilePath);
    } catch (error) {
      await fsPromises.unlink(tmp).catch(() => {});
      throw error;
    }
  };

  /**
   * File a batch of company sessions. `entries` are `{ sessionId, scopeKey }`,
   * where `scopeKey` is the normalized project path the folder is keyed by (the
   * same key the UI's `foldersMap` uses). Sessions with no scope (their cwd is
   * not under a registered project) are skipped — there is no folder for them to
   * live in, exactly as the client hook only files per loaded project.
   *
   * Resolves once the write is queued; never rejects, so a caller can fire it
   * without holding up the list response.
   *
   * @param {{ sessionId: string, scopeKey: string | null }[]} entries
   * @returns {Promise<void>}
   */
  const fileMany = (entries) => {
    const pending = (entries || []).filter(
      (entry) => entry && typeof entry.sessionId === 'string' && entry.sessionId
        && typeof entry.scopeKey === 'string' && entry.scopeKey
        && !filed.has(entry.sessionId),
    );
    if (pending.length === 0) return Promise.resolve();
    pending.forEach((entry) => filed.add(entry.sessionId));

    const run = async () => {
      const snapshot = await readSnapshot();
      let changed = false;
      pending.forEach(({ sessionId, scopeKey }) => {
        const folders = Array.isArray(snapshot.foldersMap[scopeKey])
          ? snapshot.foldersMap[scopeKey]
          : (snapshot.foldersMap[scopeKey] = []);
        let folder = folders.find(
          (candidate) => typeof candidate?.name === 'string'
            && candidate.name.toLowerCase() === folderName.toLowerCase(),
        );
        if (!folder) {
          folder = { id: createFolderId(), name: folderName, sessionIds: [], createdAt: now(), parentId: null };
          folders.push(folder);
        }
        if (!folder.sessionIds.includes(sessionId)) {
          folder.sessionIds.push(sessionId);
          changed = true;
        }
      });
      if (!changed) return;
      snapshot.updatedAt = Math.max(now(), (typeof snapshot.updatedAt === 'number' ? snapshot.updatedAt : 0) + 1);
      await writeSnapshot(snapshot);
    };

    queue = queue.then(run, run).catch((error) => {
      // A failed filing is retried on the next list: forget the ids we claimed.
      pending.forEach((entry) => filed.delete(entry.sessionId));
      console.warn('[claude-backend] company auto-file failed:', error?.message ?? error);
    });
    return queue;
  };

  return { fileMany };
};

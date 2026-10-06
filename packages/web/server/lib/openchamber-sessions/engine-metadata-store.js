import fsDefault from 'fs';
import pathDefault from 'path';

/**
 * OpenChamber's per-session metadata (pins, the delivered-knowledge cursor,
 * `/btw` links, linked issues and PRs) for sessions of an engine that has no
 * metadata of its own: a Claude Code transcript cannot hold it. OpenCode
 * sessions keep theirs in OpenCode's session record
 * (session-metadata-store.js); a session this store `owns` keeps it here, in
 * OpenChamber's data directory, keyed by the public session id the UI uses.
 *
 * Same contract as the OpenCode side of the metadata store: `read` resolves
 * the full record (`{}` for a session with none yet — the engine owns the id,
 * so it exists), `write` replaces it. Writes are serialized and atomic
 * (temp file + rename), so a crash never leaves half a file behind.
 */

export const ENGINE_METADATA_FILE_NAME = 'engine-session-metadata.json';

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * @param {object} options
 * @param {string} options.dataDir OpenChamber data directory
 * @param {(sessionID: string) => boolean} options.owns which session ids live here
 * @param {typeof fsDefault.promises} [options.fsPromises]
 * @param {typeof pathDefault} [options.path]
 */
export const createEngineSessionMetadata = ({
  dataDir,
  owns,
  fsPromises = fsDefault.promises,
  path = pathDefault,
}) => {
  const filePath = path.join(dataDir, ENGINE_METADATA_FILE_NAME);
  /** sessionID → metadata */
  const records = new Map();
  let loadPromise = null;
  let writeChain = Promise.resolve();

  const readStored = async () => {
    let raw;
    try {
      raw = await fsPromises.readFile(filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw new Error(`engine session metadata is unavailable: ${error?.message ?? error}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      // Unreadable bytes are kept aside for the user, never overwritten.
      const backup = `${filePath}.corrupt-${Date.now()}`;
      await fsPromises.rename(filePath, backup).catch(() => undefined);
      console.warn(`[openchamber-sessions] engine session metadata was unreadable and was moved to ${backup}: ${error?.message ?? error}`);
      return;
    }
    if (!isPlainObject(parsed)) return;
    for (const [id, metadata] of Object.entries(parsed)) {
      if (typeof id === 'string' && id && isPlainObject(metadata)) records.set(id, metadata);
    }
  };

  // One read per process; a failed read is not remembered, so the next call retries.
  const load = () => {
    loadPromise ??= readStored().catch((error) => {
      loadPromise = null;
      throw error;
    });
    return loadPromise;
  };

  const persist = () => {
    const next = writeChain.then(async () => {
      await fsPromises.mkdir(dataDir, { recursive: true });
      const tmpPath = `${filePath}.${process.pid}.tmp`;
      await fsPromises.writeFile(tmpPath, JSON.stringify(Object.fromEntries(records)), 'utf8');
      await fsPromises.rename(tmpPath, filePath);
    });
    writeChain = next.then(() => undefined, () => undefined);
    return next;
  };

  return {
    owns: (sessionID) => typeof sessionID === 'string' && owns(sessionID),
    load,
    read: async (sessionID) => {
      await load();
      return records.get(sessionID) ?? {};
    },
    write: async (sessionID, metadata) => {
      await load();
      const previous = records.get(sessionID);
      if (isPlainObject(metadata) && Object.keys(metadata).length > 0) records.set(sessionID, metadata);
      else records.delete(sessionID);
      try {
        await persist();
      } catch (error) {
        // A write that did not reach the disk must not linger in memory as if
        // it had: the next read, and the file after a restart, disagree.
        if (previous === undefined) records.delete(sessionID);
        else records.set(sessionID, previous);
        throw error;
      }
    },
    /** The last loaded record, synchronously, for a stream that cannot wait; undefined before load. */
    peek: (sessionID) => records.get(sessionID),
    /** Forget a deleted session's metadata. */
    remove: async (sessionID) => {
      await load();
      if (!records.delete(sessionID)) return;
      await persist();
    },
    filePath,
  };
};

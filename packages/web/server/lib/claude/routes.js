/**
 * Claude Code sessions on the OpenCode 2 HTTP surface.
 *
 * OpenChamber's UI only knows one session shape: OpenCode's. Rather than teach
 * the UI a second backend, these routes answer the same `/api/session*` calls
 * the OpenCode 2 SDK makes, for ids that belong to Claude Code, and
 * `listClaudeSessions` gives the proxy the sessions it folds into the list the
 * sidebar already renders. A Claude session therefore opens, streams, aborts,
 * renames and deletes without the front end knowing where it came from.
 * Shapes cross from the runtime's records to OpenCode 2's in v2-wire.js.
 *
 * Routing is decided by the session id alone, never by a lookup that could be
 * cold. Session ids use `ses_ccc`, the prefix the front end already reserves
 * for Claude Code sessions: `resolveSessionSource` (lib/sessionSourceFilter.ts)
 * classifies a session by its id, and the sidebar's source filter — and whether
 * that filter shows up at all — follows from it. Message ids are the runtime's
 * own `msg_…` ids: they only mean something inside their session, and OpenCode
 * 2 requires that prefix.
 */

import { createClaudeBackendRuntime } from './runtime.js';
import { operationOfPath, sendUnsupportedOperation } from '../engines/engines.js';
import { createClaudeV2EventTranslator, pageOf, toV2Message, toV2Session } from './v2-wire.js';

/** The contract the UI's source filter keys on: `ses_ccc` is a Claude Code session. */
export const CLAUDE_SESSION_ID_PREFIX = 'ses_ccc';

const toPublicId = (sessionId) => `${CLAUDE_SESSION_ID_PREFIX}${sessionId}`;

const fromPublicId = (publicId) =>
  typeof publicId === 'string' && publicId.startsWith(CLAUDE_SESSION_ID_PREFIX)
    ? publicId.slice(CLAUDE_SESSION_ID_PREFIX.length)
    : null;

export const isClaudeSessionId = (value) => fromPublicId(value) !== null;

/** `providerID` of a model picked from the Claude catalog (the composer sends it back on `/model`). */
const CLAUDE_PROVIDER_ID = 'claude';

/** `OPENCHAMBER_CLAUDE_LIST_DISABLED=1` turns the whole surface off: no routes, no sessions in the list. */
const claudeSurfaceDisabled = () => process.env.OPENCHAMBER_CLAUDE_LIST_DISABLED === '1';

/**
 * The OpenCode proxy forwards raw request streams and no JSON body parser is
 * mounted globally, so these routes read their own body.
 *
 * Reading it consumes the stream, and a route that declines the request falls
 * through to the OpenCode proxy, which can only replay a consumed body from
 * `req.body` (see `serializeParsedBody` in lib/opencode/proxy.js). What is read
 * here is therefore published on the request: without it the proxy forwards the
 * original content-length with no payload and OpenCode waits for bytes that
 * never arrive.
 */
const readJsonBody = (req) =>
  new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') {
      resolve(req.body);
      return;
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      if (!raw.length) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw.toString('utf8'));
        req.body = parsed;
        resolve(parsed);
      } catch {
        // Not JSON for these routes: keep the raw bytes so the proxy replays
        // them verbatim instead of an empty object.
        req.body = raw;
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });

/**
 * Longest-worktree match against the directories the front end treats as
 * projects. A transcript under one of them belongs to that project; anything
 * else keeps its own directory and is filtered out of the sidebar, exactly as
 * an OpenCode session in an unregistered directory would be.
 */
export const createProjectResolver = (projects) => {
  const sorted = (projects || [])
    .filter((p) => p && typeof p.worktree === 'string' && typeof p.id === 'string' && p.worktree !== '/')
    .sort((a, b) => b.worktree.length - a.worktree.length);
  return (directory) => {
    if (!directory) return null;
    return sorted.find((p) => directory === p.worktree || directory.startsWith(`${p.worktree}/`)) || null;
  };
};


/**
 * OpenCode 2 answers errors as tagged bodies; the SDK turns a declared status
 * into an error carrying `message`, so the UI shows what went wrong.
 */
const sendTagged = (res, status, tag, message, extra = {}) => {
  res.status(status).json({ _tag: tag, message, ...extra });
};

const sendNotFound = (res) => sendTagged(res, 404, 'SessionNotFoundError', 'Session not found');

/**
 * A prompt refused because another process holds the session is a conflict
 * the user can resolve (take it over), not a server failure.
 */
const sendPromptError = (res, error) => {
  if (error?.code === 'CLAUDE_SESSION_LIVE_ELSEWHERE') {
    const { entrypoint, name, status, pid } = error.owner || {};
    sendTagged(res, 409, 'ConflictError', error.message, { code: error.code, owner: { entrypoint, name, status, pid } });
    return;
  }
  if (error?.code === 'CLAUDE_REMOTE_ATTACH_FAILED') {
    sendTagged(res, 502, 'UnknownError', error.message, { code: error.code });
    return;
  }
  sendTagged(res, 500, 'UnknownError', error?.message || 'Failed to prompt');
};

/** `?type=a,b` or `?type=a&type=b`: the message kinds a page is limited to. */
const requestedTypes = (value) => {
  const raw = Array.isArray(value) ? value : (typeof value === 'string' ? [value] : []);
  const types = raw.flatMap((entry) => String(entry).split(',')).map((entry) => entry.trim()).filter(Boolean);
  return types.length > 0 ? new Set(types) : null;
};

const positiveInteger = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
};

/**
 * @param {object} dependencies runtime dependencies (runtime.js), plus:
 * @param {(event: object) => void} [dependencies.publishEvent] receives `{ payload, directory, eventId }`
 * @param {() => Promise<Array<{ id: string, worktree: string }>>} [dependencies.readProjects]
 *   the directories the sidebar treats as projects (settings.json `projects`)
 * @param {() => Promise<Record<string, number>>} [dependencies.getArchivedSessions]
 *   OpenChamber's archive store (sessions-archive.json), keyed by public id
 */
export const createClaudeSurface = (dependencies = {}) => {
  const { publishEvent, readProjects, getArchivedSessions, getStoredMetadata, peekStoredMetadata, ...rest } = dependencies;
  const crypto = rest.crypto;

  /**
   * The last project list read, reused by the live stream so a session it
   * announces lands in the same project the list put it in.
   */
  let resolveProject = createProjectResolver([]);
  const refreshProjects = async () => {
    if (typeof readProjects !== 'function') return resolveProject;
    try {
      resolveProject = createProjectResolver(await readProjects());
    } catch (error) {
      console.warn('[claude-backend] project list unavailable:', error?.message ?? error);
    }
    return resolveProject;
  };

  /**
   * The UI archives a Claude session in OpenChamber's archive store, as it does
   * an OpenCode one. The proxy lays that store over the list, but a single
   * session is answered here, so the same overlay goes on every record this
   * surface serves — otherwise the detail read and the live stream hand the UI
   * the session un-archived and it comes back to the sidebar. The last snapshot
   * read is reused by the stream, which cannot wait for the store.
   */
  let archivedSessions = {};
  const refreshArchived = async () => {
    if (typeof getArchivedSessions !== 'function') return archivedSessions;
    try {
      const archived = await getArchivedSessions();
      if (archived && typeof archived === 'object') archivedSessions = archived;
    } catch (error) {
      console.warn('[claude-backend] archive state unavailable:', error?.message ?? error);
    }
    return archivedSessions;
  };

  /**
   * OpenChamber's own metadata for Claude sessions (pins, `/btw` links, the
   * knowledge cursor), kept by the server's engine metadata store: a
   * transcript has nowhere to hold it. Loaded before a read is answered; the
   * live stream uses the last loaded copy.
   */
  const loadStoredMetadata = async () => {
    if (typeof getStoredMetadata !== 'function') return;
    await getStoredMetadata('').catch((error) => {
      console.warn('[claude-backend] stored session metadata unavailable:', error?.message ?? error);
    });
  };

  const toSession = (session) => {
    const id = toPublicId(session.id);
    const archivedAt = archivedSessions[id];
    const stored = typeof peekStoredMetadata === 'function' ? peekStoredMetadata(id) : undefined;
    const wire = toV2Session(
      {
        ...session,
        id,
        parentID: session.parentID ? toPublicId(session.parentID) : undefined,
        time: typeof archivedAt === 'number' ? { ...session.time, archived: archivedAt } : session.time,
        metadata: stored ? { ...(session.metadata || {}), ...stored } : session.metadata,
      },
      resolveProject,
    );
    // The engine is this server's to declare: stored metadata never overrides it.
    return { ...wire, metadata: { ...wire.metadata, backend: 'claude' } };
  };

  const translator = createClaudeV2EventTranslator({
    publish: (event) => publishEvent?.({ payload: event, directory: event.location?.directory, eventId: event.id }),
    toPublicId,
    toSession,
    createEventId: () => `evt_claude${typeof crypto?.randomUUID === 'function' ? crypto.randomUUID().replace(/-/g, '') : Date.now().toString(36)}`,
  });

  const runtime = createClaudeBackendRuntime({
    ...rest,
    publishEvent: publishEvent ? ({ payload }) => translator.translate(payload) : undefined,
  });

  /**
   * The working directory each session runs in. The UI addresses a session by
   * its project root, but the CLI must start where the transcript was written,
   * and a session created here has no transcript to read that from yet.
   */
  const workingDirectories = new Map();

  /** Per-session model/agent the composer switched to (v2 selects them per session, not per prompt). */
  const selections = new Map();
  /** Context the composer admitted ahead of the next prompt (`session.synthetic`). */
  const pendingContext = new Map();

  const workingDirectoryOf = async (sessionId, fallback) => {
    const known = workingDirectories.get(sessionId);
    if (known) return known;
    const session = await runtime.getSession({ sessionID: sessionId }).catch(() => null);
    const directory = session?.directory || fallback || '';
    if (directory) workingDirectories.set(sessionId, directory);
    return directory;
  };

  /**
   * Claude sessions for the list route, as `Session.Info`. `directory` keeps
   * those whose real working directory is at or under it.
   */
  const listClaudeSessions = async (options = {}) => {
    // Kill switch (25-09-2026): listing reads every transcript under
    // ~/.claude/projects (GBs); production runs with it on until listing stops
    // reading them whole.
    if (claudeSurfaceDisabled()) return [];
    const { directory = null, search = null } = options || {};
    await Promise.all([refreshProjects(), refreshArchived(), loadStoredMetadata()]);
    const [active, archived] = await Promise.all([
      runtime.listSessions({ archived: false }),
      runtime.listSessions({ archived: true }),
    ]);
    const root = typeof directory === 'string' && directory ? directory.replace(/\/$/, '') : null;
    const needle = typeof search === 'string' && search.trim() ? search.trim().toLowerCase() : null;
    return [...active, ...archived]
      .filter((session) => !root || session.directory === root || String(session.directory || '').startsWith(`${root}/`))
      .filter((session) => !needle || String(session.title || '').toLowerCase().includes(needle))
      .map(toSession);
  };

  /**
   * Which Claude sessions are running right now, as `{ [id]: { type } }`.
   * `GET /api/session/active` is OpenCode's and OpenCode knows nothing of a
   * Claude session, so the proxy folds this map into the answer: without it
   * the sidebar's polled snapshot — where absence means idle — clears the
   * busy state the runtime's own events just set. In-memory only (the live
   * processes and the foreign-owner registry), so the list kill switch,
   * which guards whole-transcript reads, does not apply here.
   */
  const listClaudeActive = async (options = {}) => {
    const snapshot = await runtime.getStatusSnapshot({
      directory: typeof options.directory === 'string' && options.directory ? options.directory : null,
    });
    return Object.fromEntries(
      Object.entries(snapshot).map(([sessionId, status]) => [toPublicId(sessionId), status]),
    );
  };

  const directoryOf = (req) => {
    if (typeof req.query?.directory === 'string' && req.query.directory) return req.query.directory;
    const header = req.get?.('x-opencode-directory');
    return typeof header === 'string' && header ? decodeURIComponent(header) : undefined;
  };

  /**
   * A page of messages is cut from the whole transcript, which the SDK parses
   * in full (tens of MB for a long session). The UI walks pages back to back
   * and opens several sessions at once, so one parse is shared by every page
   * read within a few seconds, and only two transcripts are parsed at a time:
   * parallel parses are what pushed the server past V8's heap on 25-09.
   */
  const RECORDS_TTL_MS = 10_000;
  const MAX_CACHED_TRANSCRIPTS = 4;
  const MAX_CONCURRENT_PARSES = 2;
  const recordCache = new Map();
  const parseWaiters = [];
  let activeParses = 0;
  const withParseSlot = async (task) => {
    while (activeParses >= MAX_CONCURRENT_PARSES) await new Promise((resolve) => parseWaiters.push(resolve));
    activeParses += 1;
    try {
      return await task();
    } finally {
      activeParses -= 1;
      parseWaiters.shift()?.();
    }
  };
  const readRecords = (sessionId) => {
    const hit = recordCache.get(sessionId);
    if (hit && Date.now() - hit.at < RECORDS_TTL_MS) return hit.promise;
    const promise = withParseSlot(() => runtime.getMessages({ sessionID: sessionId }))
      .then((records) => records.map(toV2Message));
    recordCache.delete(sessionId);
    recordCache.set(sessionId, { at: Date.now(), promise });
    while (recordCache.size > MAX_CACHED_TRANSCRIPTS) recordCache.delete(recordCache.keys().next().value);
    // Released when it expires, not when it is next asked for: a parsed
    // transcript is large and nothing else frees it.
    setTimeout(() => {
      if (recordCache.get(sessionId)?.promise === promise) recordCache.delete(sessionId);
    }, RECORDS_TTL_MS).unref?.();
    promise.catch(() => {
      if (recordCache.get(sessionId)?.promise === promise) recordCache.delete(sessionId);
    });
    return promise;
  };

  /**
   * Start a turn and resolve once the runtime accepts it, as OpenCode's
   * prompt does: the turn itself streams over the event channel, and only a
   * refusal before acceptance (the session held by another process, the
   * backend unavailable, nothing to send) rejects. Shared by the HTTP routes
   * and by the server's message queue (`queueTransport`).
   *
   * `withContext: false` is a command: it must reach the CLI as its own
   * message, so context admitted for the next prompt stays pending for it.
   */
  const beginTurn = async (sessionId, { text, files = [], withContext = true, directoryHint, clientMessageId }) => {
    const context = withContext ? pendingContext.get(sessionId) || [] : [];
    const parts = [
      ...context.map((entry) => ({ type: 'text', text: entry })),
      ...(text ? [{ type: 'text', text }] : []),
      ...files
        .filter((file) => file && typeof file.uri === 'string')
        .map((file) => ({ type: 'file', url: file.uri, filename: file.name })),
    ];
    if (parts.length === 0) {
      throw Object.assign(new Error('No text or attachment in prompt'), { code: 'EMPTY_PROMPT' });
    }
    if (withContext) pendingContext.delete(sessionId);
    // The turn changes the transcript: the next read must not be the old parse.
    recordCache.delete(sessionId);
    const selection = selections.get(sessionId) || {};
    // Only a model picked from the Claude catalog is held (see /model);
    // without one the runtime keeps its own.
    const modelId = typeof selection.model?.id === 'string' ? selection.model.id.trim() : '';
    const directory = await workingDirectoryOf(sessionId, directoryHint);
    const now = Date.now();
    const messageID = typeof clientMessageId === 'string' && clientMessageId.startsWith('msg_')
      ? clientMessageId
      : `msg_${String(now).padStart(14, '0')}_000000_local`;
    await new Promise((resolve, reject) => {
      let settled = false;
      const accept = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      runtime
        .promptAsync({
          sessionID: sessionId,
          directory,
          parts,
          model: modelId ? { modelID: modelId } : undefined,
          agent: selection.agent,
          variant: selection.model?.variant,
          messageID,
          onStarted: accept,
        })
        .then(accept)
        .catch((error) => {
          // After acceptance a failure is the turn's own, reported as a
          // `session.error` event; only a refusal before it rejects here.
          if (settled) return;
          settled = true;
          reject(error);
        });
    });
    return { messageID, created: now };
  };

  /** A turn from an HTTP route: answer `res` once it is accepted, as OpenCode does. */
  const startTurn = async (req, res, sessionId, { text, files = [], body = {}, answer: answerAs = 'item', withContext = true }) => {
    let turn;
    try {
      turn = await beginTurn(sessionId, {
        text,
        files,
        withContext,
        directoryHint: directoryOf(req),
        clientMessageId: body.id,
      });
    } catch (error) {
      if (error?.code === 'EMPTY_PROMPT') return sendTagged(res, 400, 'InvalidRequestError', error.message);
      return sendPromptError(res, error);
    }
    if (answerAs === 'empty') return res.status(204).end();
    return res.json({
      data: {
        id: turn.messageID,
        sessionID: req.params.id,
        time: { created: turn.created },
        type: 'user',
        payload: { text, ...(files.length > 0 ? { files } : {}) },
        delivery: body.delivery || 'queue',
      },
    });
  };

  /**
   * How the server's message queue (lib/message-queue) delivers to a Claude
   * session: through this engine, never OpenCode's port, which does not know
   * the id. Same path as the composer: context is admitted ahead of the
   * prompt, and a `/name args` message is Claude Code's own command.
   */
  const queueTransport = {
    owns: (publicId) => fromPublicId(publicId) !== null,
    /** Idle unless a turn runs here or another process holding it is busy. */
    isIdle: async (publicId) => {
      const sessionId = fromPublicId(publicId);
      if (!sessionId) return null;
      const snapshot = await runtime.getStatusSnapshot({});
      return !snapshot[sessionId];
    },
    send: async (publicId, directory, { text = '', files = [], context = [] } = {}) => {
      const sessionId = fromPublicId(publicId);
      if (!sessionId) throw new Error('Not a Claude Code session');
      for (const entry of context) {
        if (typeof entry === 'string' && entry.trim()) {
          pendingContext.set(sessionId, [...(pendingContext.get(sessionId) || []), entry]);
        }
      }
      const command = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
      if (command && !/\n/.test(command[1])) {
        const args = (command[2] || '').trim();
        return beginTurn(sessionId, {
          text: args ? `/${command[1]} ${args}` : `/${command[1]}`,
          files,
          withContext: false,
          directoryHint: directory,
        });
      }
      return beginTurn(sessionId, { text, files, directoryHint: directory });
    },
  };

  /**
   * Re-announce a session with its full metadata after OpenChamber's own part
   * of it changed (a pin, a `/btw` link). The UI replaces a session's metadata
   * with what an update carries, so a Claude session must get its whole record
   * — the engine's fields (`backend`, `liveElsewhere`, `remoteControl`) with
   * the stored ones — never the stored part alone.
   */
  const announceSession = async (publicId) => {
    const sessionId = fromPublicId(publicId);
    if (!sessionId || !publishEvent) return;
    await loadStoredMetadata();
    const session = await runtime.getSession({ sessionID: sessionId }).catch(() => null);
    if (!session) return;
    translator.translate({ type: 'session.updated', directory: session.directory, properties: { info: session } });
  };

  const register = (app) => {
    // Kill switch (25-09-2026): the Claude routes parse whole transcripts per request.
    if (claudeSurfaceDisabled()) return runtime;
    app.get('/api/session/:id', (req, res, next) => {
      const sessionId = fromPublicId(req.params.id);
      if (!sessionId) return next();
      return runtime
        .getSession({ sessionID: sessionId })
        .then(async (session) => {
          if (!session) return sendNotFound(res);
          await Promise.all([refreshProjects(), refreshArchived(), loadStoredMetadata()]);
          res.json({ data: toSession(session) });
        })
        .catch((error) => sendTagged(res, 500, 'UnknownError', error?.message || 'Failed'));
    });

    app.get('/api/session/:id/message', (req, res, next) => {
      const sessionId = fromPublicId(req.params.id);
      if (!sessionId) return next();
      return readRecords(sessionId)
        .then((messages) => {
          const types = requestedTypes(req.query?.type);
          const page = pageOf(types ? messages.filter((message) => types.has(message.type)) : messages, {
            limit: positiveInteger(req.query?.limit),
            order: req.query?.order,
            cursor: typeof req.query?.cursor === 'string' ? req.query.cursor : undefined,
          });
          if (!page) return sendTagged(res, 400, 'InvalidCursorError', 'Invalid cursor');
          res.json(page);
        })
        .catch((error) => sendTagged(res, 500, 'UnknownError', error?.message || 'Failed'));
    });

    app.get('/api/session/:id/message/:messageID', (req, res, next) => {
      const sessionId = fromPublicId(req.params.id);
      if (!sessionId) return next();
      return readRecords(sessionId)
        .then((messages) => {
          const message = messages.find((entry) => entry.id === req.params.messageID);
          if (!message) return sendTagged(res, 404, 'MessageNotFoundError', 'Message not found');
          res.json({ data: message });
        })
        .catch((error) => sendTagged(res, 500, 'UnknownError', error?.message || 'Failed'));
    });

    app.post('/api/session', async (req, res, next) => {
      const body = await readJsonBody(req);
      const isClaude = body.metadata?.backend === 'claude' || body.agent === 'claude';
      if (!isClaude) return next();
      const directory = body.location?.directory || body.directory || directoryOf(req);
      return runtime
        .createSession({ directory, title: body.title })
        .then(async (session) => {
          if (session.directory) workingDirectories.set(session.id, session.directory);
          await refreshProjects();
          res.json({ data: toSession(session) });
        })
        .catch((error) => sendTagged(res, 500, 'UnknownError', error?.message || 'Failed to create session'));
    });

    // The Claude catalog (settings.json `modelPicker`) the composer offers a
    // Claude session instead of OpenCode's provider list.
    app.get('/api/claude/models', (_req, res) => runtime
      .getControlSurface()
      .then(({ modelSelector, effortSelector }) => res.json({
        models: modelSelector.options,
        defaultModelId: modelSelector.defaultOptionId,
        efforts: effortSelector.options,
        defaultEffort: effortSelector.defaultOptionId,
      }))
      .catch((error) => sendTagged(res, 500, 'UnknownError', error?.message || 'Failed')));

    // Claude Code's slash commands for the composer's `/` menu in a Claude
    // session (OpenCode's command list means nothing to it).
    app.get('/api/claude/commands', (req, res) => runtime
      .listCommands({ directory: directoryOf(req) })
      .then((commands) => res.json({ commands }))
      .catch((error) => sendTagged(res, 500, 'UnknownError', error?.message || 'Failed')));

    // The composer puts a session on a model/agent before prompting; for
    // Claude that choice rides the next prompt (model, effort, mode). Only a
    // pick from the Claude catalog counts: the send path also switches every
    // session to OpenCode's current model, which would overwrite it.
    app.post('/api/session/:id/model', async (req, res, next) => {
      const sessionId = fromPublicId(req.params.id);
      if (!sessionId) return next();
      const body = await readJsonBody(req);
      if (body.model?.providerID === CLAUDE_PROVIDER_ID) {
        selections.set(sessionId, { ...selections.get(sessionId), model: body.model });
      }
      res.status(204).end();
    });

    app.post('/api/session/:id/agent', async (req, res, next) => {
      const sessionId = fromPublicId(req.params.id);
      if (!sessionId) return next();
      const body = await readJsonBody(req);
      selections.set(sessionId, { ...selections.get(sessionId), agent: typeof body.agent === 'string' ? body.agent : undefined });
      res.status(204).end();
    });

    // Attached context (inline comments, terminal output) arrives as synthetic
    // messages right before the prompt; Claude reads it as the prompt's lead.
    app.post('/api/session/:id/synthetic', async (req, res, next) => {
      const sessionId = fromPublicId(req.params.id);
      if (!sessionId) return next();
      const body = await readJsonBody(req);
      const text = typeof body.text === 'string' ? body.text : '';
      if (text.trim()) pendingContext.set(sessionId, [...(pendingContext.get(sessionId) || []), text]);
      const now = Date.now();
      res.json({
        data: {
          id: typeof body.id === 'string' && body.id ? body.id : `msg_${String(now).padStart(14, '0')}_context`,
          sessionID: req.params.id,
          time: { created: now },
          type: 'synthetic',
          payload: { text, ...(body.description ? { description: body.description } : {}) },
          delivery: body.delivery || 'queue',
        },
      });
    });

    /**
     * Start a turn with `text` (+ `files`) and answer `res` once the runtime
     * accepts it, as OpenCode's prompt does. Shared by prompt, command and
     * compact: a Claude Code command is a prompt that starts with `/name`.
     */
    app.post('/api/session/:id/prompt', async (req, res, next) => {
      const sessionId = fromPublicId(req.params.id);
      if (!sessionId) return next();
      const body = await readJsonBody(req);
      return startTurn(req, res, sessionId, {
        text: typeof body.text === 'string' ? body.text : '',
        files: Array.isArray(body.files) ? body.files : [],
        body,
      });
    });

    // A command is Claude Code's own slash command: `/name args` as the
    // prompt, which the CLI expands (built-ins, ~/.claude/commands, the
    // project's .claude/commands, skills, plugins). OpenCode answers 204.
    app.post('/api/session/:id/command', async (req, res, next) => {
      const sessionId = fromPublicId(req.params.id);
      if (!sessionId) return next();
      const body = await readJsonBody(req);
      const name = typeof body.name === 'string' ? body.name.trim().replace(/^\//, '') : '';
      if (!name || /\s/.test(name)) {
        return sendTagged(res, 400, 'InvalidRequestError', 'A command needs a name without spaces');
      }
      const args = typeof body.text === 'string' ? body.text.trim() : '';
      return startTurn(req, res, sessionId, {
        text: args ? `/${name} ${args}` : `/${name}`,
        files: Array.isArray(body.files) ? body.files : [],
        body,
        answer: 'empty',
        withContext: false,
      });
    });

    // Compaction is Claude Code's `/compact`: the CLI summarizes its own
    // context, as it does when it runs out, and the transcript records it.
    app.post('/api/session/:id/compact', async (req, res, next) => {
      const sessionId = fromPublicId(req.params.id);
      if (!sessionId) return next();
      const body = await readJsonBody(req);
      return startTurn(req, res, sessionId, { text: '/compact', body, withContext: false });
    });

    // A fork is a sibling transcript up to (and excluding) `before`, or all of it.
    app.post('/api/session/:id/fork', async (req, res, next) => {
      const sessionId = fromPublicId(req.params.id);
      if (!sessionId) return next();
      const body = await readJsonBody(req);
      const before = typeof body.before === 'string' && body.before.trim() ? body.before.trim() : undefined;
      return runtime
        .forkSession({ sessionID: sessionId, directory: await workingDirectoryOf(sessionId, directoryOf(req)), before })
        .then(async (session) => {
          if (session.directory) workingDirectories.set(session.id, session.directory);
          await Promise.all([refreshProjects(), refreshArchived()]);
          res.json({ data: toSession(session) });
        })
        .catch((error) => (error?.code === 'CLAUDE_FORK_POINT_NOT_FOUND'
          ? sendTagged(res, 404, 'MessageNotFoundError', error.message)
          : sendTagged(res, 500, 'UnknownError', error?.message || 'Failed to fork the session')));
    });

    // The front end still shows a session another process is writing: keep
    // following its transcript (the follow lapses otherwise, see runtime).
    app.post('/api/session/:id/claude/follow', async (req, res, next) => {
      const sessionId = fromPublicId(req.params.id);
      if (!sessionId) return next();
      const body = await readJsonBody(req);
      return runtime
        .keepFollowing({ sessionID: sessionId, directory: body.directory || directoryOf(req) })
        .then(() => res.status(204).end())
        .catch((error) => sendTagged(res, 500, 'UnknownError', error?.message || 'Failed'));
    });

    // Continue here a session another process holds: that process is closed,
    // this one resumes the transcript (see runtime `takeOverSession`).
    app.post('/api/session/:id/claude/takeover', async (req, res, next) => {
      const sessionId = fromPublicId(req.params.id);
      if (!sessionId) return next();
      await readJsonBody(req);
      const selection = selections.get(sessionId) || {};
      const modelId = typeof selection.model?.id === 'string' ? selection.model.id.trim() : '';
      return runtime
        .takeOverSession({
          sessionID: sessionId,
          directory: await workingDirectoryOf(sessionId, directoryOf(req)),
          model: modelId ? { modelID: modelId } : undefined,
          agent: selection.agent,
          variant: selection.model?.variant,
        })
        .then(async (session) => {
          if (!session) return sendNotFound(res);
          await refreshArchived();
          res.json({ data: toSession(session) });
        })
        .catch((error) => sendTagged(res, 500, 'UnknownError', error?.message || 'Failed to take the session over'));
    });

    // Free a session this server hosts so another Claude process (the VS Code
    // extension) can open it: that extension refuses a transcript a live
    // process holds. 409 while a turn is answering (see runtime
    // `releaseSession`).
    app.post('/api/session/:id/claude/release', async (req, res, next) => {
      const sessionId = fromPublicId(req.params.id);
      if (!sessionId) return next();
      await readJsonBody(req);
      return runtime
        .releaseSession({ sessionID: sessionId })
        .then((result) => (!result.released && result.busy
          ? sendTagged(res, 409, 'ConflictError', 'The session is answering; wait for the turn to end')
          : res.json({ data: result })))
        .catch((error) => sendTagged(res, 500, 'UnknownError', error?.message || 'Failed'));
    });

    app.post('/api/session/:id/interrupt', (req, res, next) => {
      const sessionId = fromPublicId(req.params.id);
      if (!sessionId) return next();
      return runtime
        .abortSession({ sessionID: sessionId })
        .then((interrupted) => res.json({ interrupted: interrupted !== false }))
        .catch((error) => sendTagged(res, 500, 'UnknownError', error?.message || 'Failed to interrupt'));
    });

    app.patch('/api/session/:id', async (req, res, next) => {
      const sessionId = fromPublicId(req.params.id);
      if (!sessionId) return next();
      const body = await readJsonBody(req);
      // Only the title belongs to the transcript; metadata and permissions are
      // OpenCode's and have nowhere to go for a Claude session.
      if (typeof body.title !== 'string' || !body.title.trim()) return res.status(204).end();
      return runtime
        .updateSession({ sessionID: sessionId, title: body.title })
        .then(() => res.status(204).end())
        .catch((error) => sendTagged(res, 500, 'UnknownError', error?.message || 'Failed to update'));
    });

    app.delete('/api/session/:id', (req, res, next) => {
      const sessionId = fromPublicId(req.params.id);
      if (!sessionId) return next();
      return runtime
        .deleteSession({ sessionID: sessionId })
        .then((removed) => (removed === false ? sendNotFound(res) : res.status(204).end()))
        .catch((error) => sendTagged(res, 500, 'UnknownError', error?.message || 'Failed to delete'));
    });

    // Anything else is an operation the Claude engine does not have (see
    // lib/engines/engines.js). Reads of lists a Claude session simply has none
    // of answer empty; everything else gets the typed refusal naming the
    // engine and the operation — never a fall-through to OpenCode, which does
    // not know the id and would report "session not found".
    app.all('/api/session/:id/*rest', (req, res, next) => {
      if (!fromPublicId(req.params.id)) return next();
      if (req.method === 'GET' && /\/(inbox|form|permission|diff)\/?$/.test(req.path)) return res.json({ data: [] });
      if (req.method === 'POST' && /\/view\/?$/.test(req.path)) return res.status(204).end();
      if (req.method === 'GET') return sendNotFound(res);
      const rest = Array.isArray(req.params.rest) ? req.params.rest.join('/') : String(req.params.rest || '');
      return sendUnsupportedOperation(res, 'claude', operationOfPath(rest));
    });

    return runtime;
  };

  return { register, listClaudeSessions, listClaudeActive, queueTransport, announceSession, runtime };
};

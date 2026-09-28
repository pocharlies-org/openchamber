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

import { createClaudeBackendRuntime, parseChildSessionId } from './runtime.js';
import { operationOfPath, sendUnsupportedOperation } from '../engines/engines.js';
import { createClaudeV2EventTranslator, pageOf, toV2Message, toV2Session } from './v2-wire.js';

/** The contract the UI's source filter keys on: `ses_ccc` is a Claude Code session. */
export const CLAUDE_SESSION_ID_PREFIX = 'ses_ccc';

const toPublicId = (sessionId) => `${CLAUDE_SESSION_ID_PREFIX}${sessionId}`;

/**
 * The engine's id behind a public one: a plain id (a transcript uuid), or
 * `<id>~<agentId>` for a subagent. Anything else is not a Claude session —
 * ids end up in file paths, so nothing with a separator or a dot gets through.
 */
const ENGINE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}(?:~[A-Za-z0-9][A-Za-z0-9_-]{0,127})?$/;
const fromPublicId = (publicId) => {
  if (typeof publicId !== 'string' || !publicId.startsWith(CLAUDE_SESSION_ID_PREFIX)) return null;
  const id = publicId.slice(CLAUDE_SESSION_ID_PREFIX.length);
  return ENGINE_ID.test(id) ? id : null;
};

export const isClaudeSessionId = (value) => fromPublicId(value) !== null;

/** `providerID` of a model picked from the Claude catalog (the composer sends it back on `/model`). */
const CLAUDE_PROVIDER_ID = 'claude';

/**
 * What a Claude Code command name looks like: `review`, `plugin:command`,
 * `my-skill`. A path (`/usr/local/bin/node`) or prose is not one.
 */
export const isCommandName = (name) => typeof name === 'string' && /^[A-Za-z][A-Za-z0-9:._-]*$/.test(name);

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
  const { publishEvent, readProjects, getArchivedSessions, getStoredMetadata, peekStoredMetadata, forgetStoredMetadata, ...rest } = dependencies;
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
    toPublicId,
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
   * Context reaches the turn two ways: `pendingContext` (what the composer
   * admitted through `/synthetic`, consumed unless `withPending` is false)
   * and `context` (handed in directly by the queue, which never parks
   * anything). A refusal puts consumed pending context back, so it is neither
   * lost nor duplicated by a retry.
   *
   * `asCommand`: `text` is `/name args`, sent as the one plain string Claude
   * Code parses as a command; context rides after the command line, in the
   * same message, and attachments are not allowed (the CLI would read the
   * command as prose).
   */
  const beginTurn = async (sessionId, {
    text,
    files = [],
    context = [],
    withPending = true,
    asCommand = false,
    directoryHint,
    clientMessageId,
  }) => {
    const pending = withPending ? pendingContext.get(sessionId) || [] : [];
    const admitted = [...pending, ...context].filter((entry) => typeof entry === 'string' && entry.trim());
    const fileParts = files
      .filter((file) => file && typeof file.uri === 'string')
      .map((file) => ({ type: 'file', url: file.uri, filename: file.name }));
    if (asCommand && fileParts.length > 0) {
      throw Object.assign(new Error('Claude Code commands take no attachments'), { code: 'COMMAND_ATTACHMENTS' });
    }
    const parts = asCommand
      ? [{ type: 'text', text: [text, ...admitted].join('\n\n') }]
      : [
        ...admitted.map((entry) => ({ type: 'text', text: entry })),
        ...(text ? [{ type: 'text', text }] : []),
        ...fileParts,
      ];
    if (parts.length === 0 || (asCommand && !text)) {
      throw Object.assign(new Error('No text or attachment in prompt'), { code: 'EMPTY_PROMPT' });
    }
    if (withPending) pendingContext.delete(sessionId);
    const restorePending = () => {
      if (!withPending || pending.length === 0) return;
      pendingContext.set(sessionId, [...pending, ...(pendingContext.get(sessionId) || [])]);
    };
    // The turn changes the transcript: the next read must not be the old parse.
    recordCache.delete(sessionId);
    const selection = selections.get(sessionId) || {};
    // Only a model picked from the Claude catalog is held (see /model);
    // without one the runtime keeps its own.
    const modelId = typeof selection.model?.id === 'string' ? selection.model.id.trim() : '';
    let directory;
    try {
      directory = await workingDirectoryOf(sessionId, directoryHint);
    } catch (error) {
      restorePending();
      throw error;
    }
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
          asCommand,
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
          restorePending();
          reject(error);
        });
    });
    return { messageID, created: now };
  };

  /** A turn from an HTTP route: answer `res` once it is accepted, as OpenCode does. */
  const startTurn = async (req, res, sessionId, { text, files = [], body = {}, answer: answerAs = 'item', withPending = true, asCommand = false }) => {
    let turn;
    try {
      turn = await beginTurn(sessionId, {
        text,
        files,
        withPending,
        asCommand,
        directoryHint: directoryOf(req),
        clientMessageId: body.id,
      });
    } catch (error) {
      if (error?.code === 'EMPTY_PROMPT') return sendTagged(res, 400, 'InvalidRequestError', error.message);
      if (error?.code === 'COMMAND_ATTACHMENTS') return sendUnsupportedOperation(res, 'claude', 'commandAttachments');
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
   * `/name args` when `text` is a command the CLI knows — by its name's shape
   * and, once a CLI has reported its commands, by that list — else null.
   */
  const commandIn = async (text, directory) => {
    const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(typeof text === 'string' ? text.trim() : '');
    if (!match || !isCommandName(match[1])) return null;
    const known = await runtime.listCommands({ directory }).catch(() => []);
    if (known.length > 0 && !known.some((command) => command.name === match[1])) return null;
    const args = (match[2] || '').trim();
    return args ? `/${match[1]} ${args}` : `/${match[1]}`;
  };

  /**
   * How the server's message queue (lib/message-queue) delivers to a Claude
   * session: through this engine, never OpenCode's port, which does not know
   * the id. Same shape as the composer: the captured context and pending
   * project knowledge go ahead of the text; a clean `/name args` the CLI knows
   * is its own command, with the captured context after the command line and
   * no knowledge (a command is not where standing context belongs). The
   * answer says whether the knowledge went out, so the queue records it
   * delivered only then. With the surface switched off
   * (OPENCHAMBER_CLAUDE_LIST_DISABLED=1) the queue holds Claude items: idleness
   * is unknown and a send refuses, so no CLI is started for them.
   */
  const queueTransport = {
    owns: (publicId) => fromPublicId(publicId) !== null,
    isIdle: async (publicId) => {
      const sessionId = fromPublicId(publicId);
      if (!sessionId || claudeSurfaceDisabled()) return null;
      const snapshot = await runtime.getStatusSnapshot({});
      return !snapshot[sessionId];
    },
    send: async (publicId, directory, { text = '', files = [], context = [], knowledge = '' } = {}) => {
      const sessionId = fromPublicId(publicId);
      if (!sessionId) throw new Error('Not a Claude Code session');
      if (claudeSurfaceDisabled()) throw new Error('The Claude Code surface is switched off');
      const command = await commandIn(text, directory);
      if (command) {
        await beginTurn(sessionId, { text: command, files, context, asCommand: true, directoryHint: directory });
        return { knowledgeDelivered: false };
      }
      await beginTurn(sessionId, {
        text,
        files,
        context: knowledge ? [...context, knowledge] : context,
        directoryHint: directory,
      });
      return { knowledgeDelivered: Boolean(knowledge) };
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
    if (!sessionId || !publishEvent || claudeSurfaceDisabled()) return;
    await loadStoredMetadata();
    const session = await runtime.getSession({ sessionID: sessionId }).catch(() => null);
    if (!session) return;
    translator.translate({ type: 'session.updated', directory: session.directory, properties: { info: session } });
  };

  const register = (app) => {
    // Kill switch (25-09-2026): the Claude routes parse whole transcripts per request.
    if (claudeSurfaceDisabled()) return runtime;

    // A subagent is a read-only child session: it is read (session, messages)
    // and never written — its turns belong to the session that ran it.
    app.use('/api/session/:id', (req, res, next) => {
      const sessionId = fromPublicId(req.params.id);
      if (!sessionId || !parseChildSessionId(sessionId) || req.method === 'GET') return next();
      if (req.method === 'POST' && /\/view\/?$/.test(req.path)) return res.status(204).end();
      // Stopping a running subagent is the one write a child takes.
      if (req.method === 'POST' && /^\/interrupt\/?$/.test(req.path)) {
        return runtime
          .abortSession({ sessionID: sessionId })
          .then((stopped) => res.json({ interrupted: stopped !== false }))
          .catch((error) => sendTagged(res, 500, 'UnknownError', error?.message || 'Failed to stop the subagent'));
      }
      return sendUnsupportedOperation(res, 'claude', 'subagentWrite');
    });

    // The subagents of a Claude session, as its child sessions.
    app.get('/api/session', (req, res, next) => {
      const parentId = typeof req.query?.parentID === 'string' ? fromPublicId(req.query.parentID) : null;
      if (!parentId) return next();
      return Promise.all([refreshProjects(), refreshArchived(), loadStoredMetadata()])
        .then(() => runtime.listSubagentSessions({ sessionID: parentId, directory: directoryOf(req) }))
        .then((children) => res.json({ data: children.map(toSession), cursor: {} }))
        .catch((error) => sendTagged(res, 500, 'UnknownError', error?.message || 'Failed'));
    });
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
      .then(async ({ modelSelector, effortSelector }) => {
        const modes = await runtime.listModes();
        res.json({
          models: modelSelector.options,
          defaultModelId: modelSelector.defaultOptionId,
          efforts: effortSelector.options,
          defaultEffort: effortSelector.defaultOptionId,
          modes,
          defaultMode: modes.find((mode) => mode.isDefault)?.id ?? 'default',
        });
      })
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

    // OpenCode's agent means nothing to Claude Code: the send path switches
    // every session to it, and its `plan` agent is not Claude's plan mode. A
    // Claude session's mode is set with /claude/mode.
    app.post('/api/session/:id/agent', async (req, res, next) => {
      const sessionId = fromPublicId(req.params.id);
      if (!sessionId) return next();
      await readJsonBody(req);
      res.status(204).end();
    });

    // The mode indicator: Manual, Edit automatically, Plan, Auto (and Bypass
    // where allowed). Takes effect at once, a running turn included.
    app.post('/api/session/:id/claude/mode', async (req, res, next) => {
      const sessionId = fromPublicId(req.params.id);
      if (!sessionId) return next();
      const body = await readJsonBody(req);
      return runtime
        .setSessionMode({ sessionID: sessionId, mode: body.mode })
        .then((mode) => res.json({ mode }))
        .catch((error) => (error?.code === 'UNKNOWN_MODE'
          ? sendTagged(res, 400, 'InvalidRequestError', error.message)
          : sendTagged(res, 500, 'UnknownError', error?.message || 'Failed to change the mode')));
    });

    // Claude Code asking the user (claude-requests.js): the same routes and
    // statuses as OpenCode's, so the UI's cards answer either engine.
    const requests = runtime.requests;
    const publicRequest = (request) => (request ? { ...request, sessionID: toPublicId(request.sessionID) } : null);
    const publicForm = publicRequest;

    app.get('/api/session/:id/permission', (req, res, next) => {
      const sessionId = fromPublicId(req.params.id);
      if (!sessionId) return next();
      return res.json({ data: requests.list('permission', { sessionId }).map(publicRequest) });
    });
    app.get('/api/session/:id/permission/:requestID', (req, res, next) => {
      const sessionId = fromPublicId(req.params.id);
      if (!sessionId) return next();
      const request = requests.get('permission', sessionId, req.params.requestID);
      return request ? res.json({ data: publicRequest(request) }) : sendNotFound(res);
    });
    app.post('/api/session/:id/permission/:requestID/reply', async (req, res, next) => {
      const sessionId = fromPublicId(req.params.id);
      if (!sessionId) return next();
      const body = await readJsonBody(req);
      // OpenCode 2.0.8 renamed `reply` to `decision`; both are read.
      const decision = typeof body.decision === 'string' ? body.decision : body.reply;
      if (!['once', 'always', 'reject'].includes(decision)) {
        return sendTagged(res, 400, 'InvalidRequestError', 'decision must be once, always or reject');
      }
      const answered = requests.replyPermission(sessionId, req.params.requestID, { decision, message: body.message });
      return answered ? res.status(204).end() : sendNotFound(res);
    });
    app.get('/api/session/:id/form', (req, res, next) => {
      const sessionId = fromPublicId(req.params.id);
      if (!sessionId) return next();
      return res.json({ data: requests.list('form', { sessionId }).map(publicForm) });
    });
    app.get('/api/session/:id/form/:formID', (req, res, next) => {
      const sessionId = fromPublicId(req.params.id);
      if (!sessionId) return next();
      const form = requests.get('form', sessionId, req.params.formID);
      return form ? res.json({ data: publicForm(form) }) : sendNotFound(res);
    });
    app.post('/api/session/:id/form/:formID/reply', async (req, res, next) => {
      const sessionId = fromPublicId(req.params.id);
      if (!sessionId) return next();
      const body = await readJsonBody(req);
      if (!body.answer || typeof body.answer !== 'object' || Array.isArray(body.answer)) {
        return sendTagged(res, 400, 'InvalidRequestError', 'answer must be an object');
      }
      return requests.replyForm(sessionId, req.params.formID, body.answer) ? res.status(204).end() : sendNotFound(res);
    });
    app.delete('/api/session/:id/form/:formID', (req, res, next) => {
      const sessionId = fromPublicId(req.params.id);
      if (!sessionId) return next();
      return requests.cancelForm(sessionId, req.params.formID) ? res.status(204).end() : sendNotFound(res);
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
      if (!isCommandName(name)) {
        return sendTagged(res, 400, 'InvalidRequestError', 'A command needs a name like `review` or `plugin:command`');
      }
      const args = typeof body.text === 'string' ? body.text.trim() : '';
      // Context the composer admitted with the command rides after the
      // command line, in the same message; see `beginTurn`.
      return startTurn(req, res, sessionId, {
        text: args ? `/${name} ${args}` : `/${name}`,
        files: Array.isArray(body.files) ? body.files : [],
        body,
        answer: 'empty',
        asCommand: true,
      });
    });

    // Compaction is Claude Code's `/compact`: the CLI summarizes its own
    // context, as it does when it runs out, and the transcript records it.
    app.post('/api/session/:id/compact', async (req, res, next) => {
      const sessionId = fromPublicId(req.params.id);
      if (!sessionId) return next();
      const body = await readJsonBody(req);
      // Context admitted for the next prompt waits for it: it is not compaction instructions.
      return startTurn(req, res, sessionId, { text: '/compact', body, withPending: false, asCommand: true });
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

    // "Rewind code to here" (Claude Code's file checkpoints): `dryRun` says
    // what would change; without it the files go back. The conversation stays.
    app.post('/api/session/:id/claude/rewind', async (req, res, next) => {
      const sessionId = fromPublicId(req.params.id);
      if (!sessionId) return next();
      const body = await readJsonBody(req);
      const messageID = typeof body.messageID === 'string' ? body.messageID.trim() : '';
      if (!messageID) return sendTagged(res, 400, 'InvalidRequestError', 'messageID is required');
      return runtime
        .rewindFiles({ sessionID: sessionId, messageID, dryRun: body.dryRun === true, directory: await workingDirectoryOf(sessionId, directoryOf(req)) })
        .then((result) => res.json({ data: result }))
        .catch((error) => {
          if (error?.code === 'CLAUDE_FORK_POINT_NOT_FOUND') return sendTagged(res, 404, 'MessageNotFoundError', error.message);
          if (error?.code === 'CLAUDE_BUSY' || error?.code === 'CLAUDE_SESSION_LIVE_ELSEWHERE') {
            return sendTagged(res, 409, 'SessionBusyError', error.message);
          }
          return sendTagged(res, 500, 'UnknownError', error?.message || 'Failed to rewind the files');
        });
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
        .then(async (removed) => {
          if (removed === false) return sendNotFound(res);
          // Its OpenChamber metadata goes with it; a failure only leaves an orphan entry.
          if (typeof forgetStoredMetadata === 'function') {
            await Promise.resolve(forgetStoredMetadata(req.params.id)).catch((error) => {
              console.warn('[claude-backend] could not forget session metadata:', error?.message ?? error);
            });
          }
          return res.status(204).end();
        })
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

  /** Open Claude requests of one kind for the global lists (`/api/permission/request`, `/api/form`). */
  const listClaudePending = (kind, { directory = null } = {}) => {
    if (claudeSurfaceDisabled()) return [];
    return runtime.requests.list(kind, { directory: directory || null }).map((request) => ({ ...request, sessionID: toPublicId(request.sessionID) }));
  };

  return { register, listClaudeSessions, listClaudeActive, listClaudePending, queueTransport, announceSession, runtime };
};

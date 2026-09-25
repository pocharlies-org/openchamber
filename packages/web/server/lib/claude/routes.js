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
import { createClaudeV2EventTranslator, pageOf, toV2Message, toV2Session } from './v2-wire.js';

/** The contract the UI's source filter keys on: `ses_ccc` is a Claude Code session. */
export const CLAUDE_SESSION_ID_PREFIX = 'ses_ccc';

const toPublicId = (sessionId) => `${CLAUDE_SESSION_ID_PREFIX}${sessionId}`;

const fromPublicId = (publicId) =>
  typeof publicId === 'string' && publicId.startsWith(CLAUDE_SESSION_ID_PREFIX)
    ? publicId.slice(CLAUDE_SESSION_ID_PREFIX.length)
    : null;

export const isClaudeSessionId = (value) => fromPublicId(value) !== null;

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
 */
export const createClaudeSurface = (dependencies = {}) => {
  const { publishEvent, readProjects, ...rest } = dependencies;
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

  const toSession = (session) => toV2Session(
    {
      ...session,
      id: toPublicId(session.id),
      parentID: session.parentID ? toPublicId(session.parentID) : undefined,
    },
    resolveProject,
  );

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
    await refreshProjects();
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
          await refreshProjects();
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

    // The composer puts a session on a model/agent before prompting; for
    // Claude that choice rides the next prompt (model, effort, mode).
    app.post('/api/session/:id/model', async (req, res, next) => {
      const sessionId = fromPublicId(req.params.id);
      if (!sessionId) return next();
      const body = await readJsonBody(req);
      selections.set(sessionId, { ...selections.get(sessionId), model: body.model || undefined });
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

    app.post('/api/session/:id/prompt', async (req, res, next) => {
      const sessionId = fromPublicId(req.params.id);
      if (!sessionId) return next();
      const body = await readJsonBody(req);
      const text = typeof body.text === 'string' ? body.text : '';
      const files = Array.isArray(body.files) ? body.files : [];
      const context = pendingContext.get(sessionId) || [];
      const parts = [
        ...context.map((entry) => ({ type: 'text', text: entry })),
        ...(text ? [{ type: 'text', text }] : []),
        ...files
          .filter((file) => file && typeof file.uri === 'string')
          .map((file) => ({ type: 'file', url: file.uri, filename: file.name })),
      ];
      if (parts.length === 0) {
        return sendTagged(res, 400, 'InvalidRequestError', 'No text or attachment in prompt');
      }
      pendingContext.delete(sessionId);
      // The turn changes the transcript: the next read must not be the old parse.
      recordCache.delete(sessionId);
      const selection = selections.get(sessionId) || {};
      // The composer's model comes from OpenCode's provider list: only a
      // Claude model is passed on, anything else leaves the runtime's own.
      const modelId = typeof selection.model?.id === 'string' ? selection.model.id.trim() : '';
      const directory = await workingDirectoryOf(sessionId, directoryOf(req));
      const now = Date.now();
      const messageID = typeof body.id === 'string' && body.id.startsWith('msg_')
        ? body.id
        : `msg_${String(now).padStart(14, '0')}_000000_local`;
      // `prompt` answers once the turn is accepted, as OpenCode's does; the
      // turn itself streams over the event channel. Only a rejection before
      // acceptance (session held by another process, backend unavailable) can
      // still become this request's error response.
      let answered = false;
      const answer = (send) => {
        if (answered) return;
        answered = true;
        send();
      };
      const accepted = () => answer(() => res.json({
        data: {
          id: messageID,
          sessionID: req.params.id,
          time: { created: now },
          type: 'user',
          payload: { text, ...(files.length > 0 ? { files } : {}) },
          delivery: body.delivery || 'queue',
        },
      }));
      runtime
        .promptAsync({
          sessionID: sessionId,
          directory,
          parts,
          model: modelId.startsWith('claude') ? { modelID: modelId } : undefined,
          agent: selection.agent,
          variant: selection.model?.variant,
          messageID,
          onStarted: accepted,
        })
        .then(accepted)
        .catch((error) => answer(() => sendPromptError(res, error)));
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
          model: modelId.startsWith('claude') ? { modelID: modelId } : undefined,
          agent: selection.agent,
          variant: selection.model?.variant,
        })
        .then((session) => (session ? res.json({ data: toSession(session) }) : sendNotFound(res)))
        .catch((error) => sendTagged(res, 500, 'UnknownError', error?.message || 'Failed to take the session over'));
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

    // Anything else OpenCode would answer for a session it does not have: a
    // Claude session has no inbox, forms, permissions or revert to report.
    app.all('/api/session/:id/*rest', (req, res, next) => {
      if (!fromPublicId(req.params.id)) return next();
      if (req.method === 'GET' && /\/(inbox|form|permission|diff)\/?$/.test(req.path)) return res.json({ data: [] });
      if (req.method === 'POST' && /\/view\/?$/.test(req.path)) return res.status(204).end();
      if (req.method === 'GET') return sendNotFound(res);
      return sendTagged(res, 400, 'InvalidRequestError', 'Not supported for Claude Code sessions');
    });

    return runtime;
  };

  return { register, listClaudeSessions, runtime };
};

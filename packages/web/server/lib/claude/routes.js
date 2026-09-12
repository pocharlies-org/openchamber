/**
 * Claude Code sessions on the OpenCode HTTP surface.
 *
 * OpenChamber's UI only knows one session shape: OpenCode's. Rather than teach
 * the UI a second backend, these routes answer the same `/api/session*` calls
 * for ids that belong to Claude Code, and `mergeClaudeSessions` folds them into
 * the list the sidebar already renders. A Claude session therefore behaves like
 * any other session: it opens, streams, aborts, renames and deletes without the
 * front end knowing where it came from.
 *
 * Ids are namespaced `claude:<uuid>` so routing is decided by the id alone and
 * never by a lookup that could be cold.
 */

import { createClaudeBackendRuntime } from './runtime.js';

export const CLAUDE_ID_PREFIX = 'claude:';

const toPublicId = (sessionId) => `${CLAUDE_ID_PREFIX}${sessionId}`;

const fromPublicId = (publicId) =>
  typeof publicId === 'string' && publicId.startsWith(CLAUDE_ID_PREFIX)
    ? publicId.slice(CLAUDE_ID_PREFIX.length)
    : null;

export const isClaudeSessionId = (value) => fromPublicId(value) !== null;

/**
 * Events carry the same ids the routes answer with, so the front end can match
 * a stream frame to the session it already has open. Only the id-bearing keys
 * OpenCode's events use are rewritten; everything else passes through.
 */
export const namespaceEventIds = (payload) => {
  if (!payload || typeof payload !== 'object') return payload;
  const properties = payload.properties;
  if (!properties || typeof properties !== 'object') return payload;

  const next = { ...payload, properties: { ...properties } };
  const info = properties.info;
  if (info && typeof info === 'object') {
    const nextInfo = { ...info };
    if (typeof nextInfo.id === 'string' && !isClaudeSessionId(nextInfo.id)) nextInfo.id = toPublicId(nextInfo.id);
    if (typeof nextInfo.sessionID === 'string') nextInfo.sessionID = toPublicId(nextInfo.sessionID);
    next.properties.info = nextInfo;
  }
  if (typeof next.properties.sessionID === 'string') {
    next.properties.sessionID = toPublicId(next.properties.sessionID);
  }
  const part = properties.part;
  if (part && typeof part === 'object') {
    const nextPart = { ...part };
    if (typeof nextPart.sessionID === 'string') nextPart.sessionID = toPublicId(nextPart.sessionID);
    if (typeof nextPart.messageID === 'string') nextPart.messageID = toPublicId(nextPart.messageID);
    next.properties.part = nextPart;
  }
  return next;
};

const slugFromId = (sessionId) => `claude-${String(sessionId).slice(0, 8)}`;

/**
 * The OpenCode proxy forwards raw request streams and no JSON body parser is
 * mounted globally, so these routes read their own body.
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
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });

/** OpenCode session object, from the runtime's own session record. */
const toSessionPayload = (session, resolveProject) => {
  const id = toPublicId(session.id);
  const cwd = session.directory || '';
  const project = resolveProject ? resolveProject(cwd) : null;
  // The sidebar admits a session only when its `directory` is exactly a
  // registered project root or an available worktree, and groups it the same
  // way. A transcript written in a subdirectory of a project is therefore
  // presented at that project's root, with the real working directory kept in
  // metadata for fidelity.
  const directory = project?.worktree ?? cwd;
  const payload = {
    id,
    slug: slugFromId(session.id),
    projectID: project?.id ?? 'global',
    directory,
    title: session.title || 'Untitled session',
    agent: 'claude',
    model: { providerID: 'anthropic', modelID: 'claude' },
    version: '1',
    time: session.time || { created: Date.now(), updated: Date.now() },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0 },
    share: session.share ?? null,
    metadata: {
      backend: 'claude',
      claude: { directory: cwd },
      ...(session.metadata || {}),
    },
  };
  if (project) {
    payload.project = { id: project.id, worktree: project.worktree };
  }
  return payload;
};
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

/** OpenCode message record: `{ info, parts }` keyed by the same public ids. */
const toMessagePayload = (record, directory) => {
  const info = {
    ...(record.info || {}),
    id: toPublicId(record.info?.id),
    sessionID: toPublicId(record.info?.sessionID),
  };
  if (directory) {
    info.path = { cwd: directory };
  }
  return {
    info,
    parts: (record.parts || []).map((part) => ({
      ...part,
      id: toPublicId(part.id),
      sessionID: toPublicId(part.sessionID),
      messageID: toPublicId(part.messageID),
    })),
  };
};

export const createClaudeSurface = (dependencies = {}) => {
  const { publishEvent, ...rest } = dependencies;
  const runtime = createClaudeBackendRuntime({
    ...rest,
    publishEvent: publishEvent
      ? (event) => publishEvent({ ...event, payload: namespaceEventIds(event?.payload) })
      : undefined,
  });

  const listClaudeSessions = async (directory, resolveProject = null, options = {}) => {
    const sessions = await runtime.listSessions({
      directory: directory || undefined,
      archived: options.archived === true,
      roots: options.roots !== false,
    });
    return sessions.map((session) => toSessionPayload(session, resolveProject));
  };

  const requireSessionId = (req, res) => {
    const sessionId = fromPublicId(req.params.id);
    if (!sessionId) {
      res.status(404).json({ error: 'Not found' });
      return null;
    }
    return sessionId;
  };

  const directoryOf = (req) =>
    typeof req.query?.directory === 'string' ? req.query.directory : undefined;

  const register = (app) => {
    app.get('/api/session/:id', (req, res, next) => {
      const sessionId = fromPublicId(req.params.id);
      if (!sessionId) return next();
      return runtime
        .getSession({ sessionID: sessionId, directory: directoryOf(req) })
        .then((session) => {
          if (!session) {
            res.status(404).json({ error: 'Session not found' });
            return;
          }
          res.json(toSessionPayload(session));
        })
        .catch((error) => res.status(500).json({ error: error?.message || 'Failed' }));
    });

    app.get('/api/session/:id/message', (req, res, next) => {
      const sessionId = fromPublicId(req.params.id);
      if (!sessionId) return next();
      return runtime
        .getMessages({ sessionID: sessionId, directory: directoryOf(req) })
        .then((records) => res.json(records.map((record) => toMessagePayload(record, directoryOf(req)))))
        .catch((error) => res.status(500).json({ error: error?.message || 'Failed' }));
    });

    app.post('/api/session', async (req, res, next) => {
      const body = await readJsonBody(req);
      const isClaude = body.metadata?.backend === 'claude' || body.agent === 'claude';
      if (!isClaude) return next();
      return runtime
        .createSession({
          directory: body.directory,
          title: body.title,
          model: body.model?.modelID,
        })
        .then((session) => res.json(toSessionPayload(session)))
        .catch((error) => res.status(500).json({ error: error?.message || 'Failed to create session' }));
    });

    app.post('/api/session/:id/prompt_async', async (req, res, next) => {
      const sessionId = fromPublicId(req.params.id);
      if (!sessionId) return next();
      const body = await readJsonBody(req);
      const parts = Array.isArray(body.parts) ? body.parts : [];
      const text = parts
        .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n');
      if (!text.trim()) {
        return res.status(400).json({ error: 'No text part in prompt' });
      }
      return runtime
        .promptAsync({
          sessionID: sessionId,
          directory: body.directory || directoryOf(req),
          message: text,
          model: body.model?.modelID,
          mode: body.mode,
        })
        .then(() => res.status(204).end())
        .catch((error) => res.status(500).json({ error: error?.message || 'Failed to prompt' }));
    });

    app.post('/api/session/:id/abort', (req, res, next) => {
      const sessionId = fromPublicId(req.params.id);
      if (!sessionId) return next();
      return runtime
        .abortSession({ sessionID: sessionId, directory: directoryOf(req) })
        .then(() => res.json(true))
        .catch((error) => res.status(500).json({ error: error?.message || 'Failed to abort' }));
    });

    app.patch('/api/session/:id', async (req, res, next) => {
      const sessionId = fromPublicId(req.params.id);
      if (!sessionId) return next();
      const body = await readJsonBody(req);
      return runtime
        .updateSession({
          sessionID: sessionId,
          directory: directoryOf(req),
          title: body.title,
          archived: body.time?.archived !== undefined ? Boolean(body.time.archived) : undefined,
        })
        .then((session) => res.json(toSessionPayload(session)))
        .catch((error) => res.status(500).json({ error: error?.message || 'Failed to update' }));
    });

    app.delete('/api/session/:id', (req, res, next) => {
      const sessionId = fromPublicId(req.params.id);
      if (!sessionId) return next();
      return runtime
        .deleteSession({ sessionID: sessionId, directory: directoryOf(req) })
        .then(() => res.json(true))
        .catch((error) => res.status(500).json({ error: error?.message || 'Failed to delete' }));
    });

    return runtime;
  };

  return { register, listClaudeSessions, runtime };
};

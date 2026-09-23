/**
 * Claude Code harness backend.
 *
 * Speaks to Claude Code through the official Agent SDK (`@anthropic-ai/claude-agent-sdk`),
 * the same CLI surface the VS Code extension drives. Transcripts are owned by
 * Claude Code under `~/.claude/projects/`, so this adapter indexes and reads
 * them rather than mirroring them: every session that exists on disk — VS Code,
 * terminal, Remote Control — shows up here, and continuing one is a `resume`.
 *
 * Exposed to OpenChamber through the OpenCode-shaped session routes in `routes.js`.
 */

import os from 'os';
import path from 'path';
import { mapClaudeSessionMessages, deriveClaudeTitle } from './claude-transcript.js';
import { createClaudeSessionProcess } from './session-process.js';

const BACKEND_ID = 'claude';
const PROVIDER_ID = 'claude';
const LIST_CACHE_TTL_MS = 4000;
const DEFAULT_MAX_CONCURRENT_RUNS = 4;
const DEFAULT_IDLE_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_MODE_ID = 'default';
const DEFAULT_EFFORT_ID = 'high';
const SDK_IMPORT_PATH = '@anthropic-ai/claude-agent-sdk';

const MODE_DEFINITIONS = Object.freeze({
  default: {
    id: 'default',
    label: 'Default',
    description: 'Ask before tool use that needs permission',
    permissionMode: 'default',
  },
  plan: {
    id: 'plan',
    label: 'Plan',
    description: 'Read-only: Claude proposes, nothing executes',
    permissionMode: 'plan',
  },
  acceptEdits: {
    id: 'acceptEdits',
    label: 'Accept edits',
    description: 'Auto-accept file edits',
    permissionMode: 'acceptEdits',
  },
});

const EFFORT_OPTIONS = Object.freeze([
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'max', label: 'Max' },
]);

const DEFAULT_MODEL_CATALOG = Object.freeze([
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'opus', label: 'Opus' },
  { id: 'haiku', label: 'Haiku' },
]);

const normalizeDirectory = (directory) => {
  if (typeof directory !== 'string') return '';
  const trimmed = directory.trim();
  if (!trimmed) return '';
  const normalized = trimmed.replace(/\\/g, '/');
  if (normalized.length > 1 && normalized.endsWith('/')) {
    return normalized.slice(0, -1);
  }
  return normalized;
};

const createId = (crypto) => `${Date.now().toString(16).padStart(12, '0')}${crypto.randomBytes(4).toString('hex')}`;

const createSessionId = (crypto) => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const hex = crypto.randomBytes(16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const pathToExecutableOption = (executable) => (executable ? { pathToClaudeCodeExecutable: executable } : {});

const transcriptExists = async (sdk, sessionId, directory) => {
  try {
    const info = await sdk.getSessionInfo?.(sessionId, directory ? { dir: directory } : {});
    return Boolean(info);
  } catch {
    return false;
  }
};

const clampText = (value, max) => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '';
  return text.length > max ? text.slice(0, max) : text;
};

const parseDataUrl = (url) => {
  if (typeof url !== 'string' || !url.startsWith('data:')) return null;
  const commaIndex = url.indexOf(',');
  if (commaIndex < 0) return null;
  const header = url.slice(5, commaIndex);
  const flagParts = header.split(';');
  const mime = flagParts[0] || 'application/octet-stream';
  const isBase64 = flagParts.includes('base64');
  const data = url.slice(commaIndex + 1);
  if (!isBase64) {
    return { mime, data: Buffer.from(decodeURIComponent(data), 'utf8').toString('base64') };
  }
  return { mime, data };
};

const isImageMime = (mime) => typeof mime === 'string' && mime.toLowerCase().startsWith('image/');

const buildSession = ({ sessionId, directory, title, createdAt, updatedAt, metadata }) => {
  const session = {
    id: sessionId,
    title: clampText(title, 120) || 'Untitled session',
    directory: normalizeDirectory(directory),
    parentID: null,
    time: {
      created: Number.isFinite(createdAt) ? createdAt : Date.now(),
      updated: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
    },
    backendId: BACKEND_ID,
    share: null,
  };
  if (metadata && typeof metadata === 'object') {
    session.metadata = metadata;
  }
  return session;
};

/** Selector option shape: description is present only when the model has one. */
const toModelOption = (entry) => {
  const option = { id: entry.id, label: entry.label };
  if (entry.description) {
    option.description = entry.description;
  }
  return option;
};

export const createClaudeBackendRuntime = (dependencies = {}) => {
  const {
    crypto,
    fsPromises,
    publishEvent,
    homeDir = os.homedir(),
    overlayFilePath,
    claudeExecutable,
    maxConcurrentRuns = DEFAULT_MAX_CONCURRENT_RUNS,
    sdkLoader,
    settingSources = ['user', 'project', 'local'],
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    // `{ enabled, baseUrl }`. Remote Control only links a session whose
    // ANTHROPIC_BASE_URL is first-party; `baseUrl` overrides the settings'
    // value for the processes OpenChamber starts (see DOCUMENTATION.md).
    remoteControl = null,
  } = dependencies;

  const eventClients = new Set();
  /** Live CLI process per session id; see session-process.js. */
  const processes = new Map();
  const idleTimers = new Map();
  const listCache = new Map();

  /** OpenChamber-side overlay: Claude owns transcripts, not archive state. */
  let overlay = { archived: {}, pendingTitles: {} };
  let overlayLoaded = false;
  let writeLock = Promise.resolve();

  let sdkPromise = null;
  let sdkAvailable = false;
  let executablePath = typeof claudeExecutable === 'string' && claudeExecutable.trim() ? claudeExecutable.trim() : null;

  const emitEvent = (directory, payload) => {
    const normalizedDirectory = normalizeDirectory(directory) || 'global';
    const eventPayload = {
      id: createId(crypto),
      directory: normalizedDirectory,
      ...payload,
    };
    publishEvent?.({
      payload: eventPayload,
      directory: normalizedDirectory,
      eventId: eventPayload.id,
    });
    const encoded = `data: ${JSON.stringify(eventPayload)}\n\n`;
    for (const client of eventClients) {
      if (client.directory && client.directory !== normalizedDirectory) continue;
      try {
        client.res.write(encoded);
      } catch {
        // Client gone; removed on 'close'.
      }
    }
  };

  const emitRecordEvents = (directory, record) => {
    emitEvent(directory, {
      type: 'message.updated',
      properties: { info: record.info, directory },
    });
    for (const part of record.parts) {
      emitEvent(directory, {
        type: 'message.part.updated',
        properties: { part, directory },
      });
    }
  };

  const emitSessionUpdate = (type, session) => {
    const eventPayload = {
      id: createId(crypto),
      directory: normalizeDirectory(session.directory) || 'global',
      type,
      properties: { info: session, directory: session.directory },
    };
    publishEvent?.({
      payload: eventPayload,
      directory: eventPayload.directory,
      eventId: eventPayload.id,
    });
    const encoded = `data: ${JSON.stringify(eventPayload)}\n\n`;
    for (const client of eventClients) {
      try {
        client.res.write(encoded);
      } catch {
        // Client gone; removed on 'close'.
      }
    }
  };

  const setBusyStatus = (sessionId, directory, status) => {
    emitEvent(directory, {
      type: 'session.status',
      properties: { sessionID: sessionId, status, info: status, directory },
    });
    if (status.type === 'idle') {
      emitEvent(directory, { type: 'session.idle', properties: { sessionID: sessionId, directory } });
    }
  };

  const loadOverlay = async () => {
    if (overlayLoaded) return overlay;
    try {
      const raw = await fsPromises.readFile(overlayFilePath, 'utf8');
      const parsed = JSON.parse(raw);
      overlay = {
        archived: parsed?.archived && typeof parsed.archived === 'object' ? parsed.archived : {},
        pendingTitles: parsed?.pendingTitles && typeof parsed.pendingTitles === 'object' ? parsed.pendingTitles : {},
      };
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        console.warn('[claude-backend] Failed to read overlay:', error);
      }
      overlay = { archived: {}, pendingTitles: {} };
    }
    overlayLoaded = true;
    return overlay;
  };

  const persistOverlay = async () => {
    if (!overlayFilePath) return;
    writeLock = writeLock.then(async () => {
      await fsPromises.mkdir(path.dirname(overlayFilePath), { recursive: true });
      await fsPromises.writeFile(overlayFilePath, JSON.stringify({ version: 1, ...overlay }, null, 2), 'utf8');
    });
    return writeLock;
  };

  const resolveExecutable = async () => {
    if (executablePath) return executablePath;
    const candidates = [
      process.env.OPENCHAMBER_CLAUDE_EXECUTABLE,
      path.join(homeDir, '.local', 'bin', 'claude'),
      '/usr/local/bin/claude',
    ].filter(Boolean);
    for (const candidate of candidates) {
      try {
        await fsPromises.access(candidate);
        executablePath = candidate;
        return executablePath;
      } catch {
        // try next
      }
    }
    return null;
  };

  const ensureSdk = async () => {
    if (sdkPromise) return sdkPromise;
    sdkPromise = (async () => {
      try {
        const load = sdkLoader || (() => import(SDK_IMPORT_PATH));
        const mod = await load();
        if (!mod?.listSessions || !mod?.query) {
          console.warn('[claude-backend] Agent SDK loaded without session APIs');
          return null;
        }
        const executable = await resolveExecutable();
        if (!executable && !sdkLoader) {
          console.warn('[claude-backend] No claude executable found; Claude backend disabled');
          return null;
        }
        sdkAvailable = true;
        return mod;
      } catch (error) {
        console.warn('[claude-backend] Agent SDK unavailable:', error?.message || error);
        return null;
      }
    })();
    return sdkPromise;
  };

  const ensureAvailable = async () => Boolean(await ensureSdk());

  const isAvailable = () => sdkAvailable;

  const readSettings = async () => {
    try {
      const raw = await fsPromises.readFile(path.join(homeDir, '.claude', 'settings.json'), 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  };

  const readModelCatalog = async () => {
    const settings = await readSettings();
    const options = Array.isArray(settings?.modelPicker?.options) ? settings.modelPicker.options : [];
    const catalog = options
      .filter((option) => typeof option?.model === 'string' && option.model.trim().length > 0)
      .map((option) => {
        const entry = {
          id: option.model.trim(),
          label: clampText(option.label, 60) || option.model.trim(),
        };
        const description = clampText(option.description, 160);
        if (description) {
          entry.description = description;
        }
        return entry;
      });
    if (catalog.length > 0) return catalog;
    return DEFAULT_MODEL_CATALOG.map((entry) => ({ ...entry }));
  };

  const buildSessionFromInfo = (info, fallbackDirectory) => buildSession({
    sessionId: info.sessionId,
    directory: info.cwd || fallbackDirectory || '',
    title: deriveClaudeTitle(info),
    createdAt: info.createdAt ?? info.lastModified,
    updatedAt: info.lastModified,
    metadata: info.gitBranch ? { gitBranch: info.gitBranch } : null,
  });

  /** A session with a live process advertises its Remote Control link. */
  const withLiveState = (session) => {
    const link = processes.get(session.id)?.remoteControl();
    if (!link) return { ...session };
    return { ...session, metadata: { ...(session.metadata || {}), remoteControl: { url: link.url } } };
  };

  const listSessions = async (input = {}) => {
    const sdk = await ensureSdk();
    if (!sdk) return [];

    await loadOverlay();
    const directory = normalizeDirectory(input.directory);
    const archivedOnly = input.archived === true;
    const rootsOnly = input.roots !== false;
    const limit = typeof input.limit === 'number' && input.limit > 0 ? input.limit : null;

    const cacheKey = directory || '*';
    const cached = listCache.get(cacheKey);
    let sessions;
    if (cached && Date.now() - cached.at < LIST_CACHE_TTL_MS) {
      sessions = cached.sessions;
    } else {
      try {
        const listRequest = { includeProgrammatic: true };
        if (directory) {
          listRequest.dir = directory;
        }
        const infos = await sdk.listSessions(listRequest);
        sessions = (Array.isArray(infos) ? infos : [])
          .filter((info) => info && typeof info.sessionId === 'string')
          .map((info) => buildSessionFromInfo(info, directory));
      } catch (error) {
        console.warn('[claude-backend] listSessions failed:', error?.message || error);
        return [];
      }
      listCache.set(cacheKey, { at: Date.now(), sessions });
    }

    let result = sessions
      .filter((session) => (rootsOnly ? !session.parentID : true))
      .filter((session) => {
        const archivedAt = overlay.archived[session.id];
        return archivedOnly ? Boolean(archivedAt) : !archivedAt;
      })
      .map((session) => {
        const archivedAt = overlay.archived[session.id];
        return archivedAt ? { ...session, time: { ...session.time, archived: archivedAt } } : session;
      })
      .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));

    if (limit) result = result.slice(0, limit);
    return result.map(withLiveState);
  };

  const getSession = async (input = {}) => {
    const sdk = await ensureSdk();
    const sessionId = typeof input.sessionID === 'string' ? input.sessionID.trim() : '';
    if (!sdk || !sessionId) return null;

    await loadOverlay();
    const directory = normalizeDirectory(input.directory);

    const known = await listSessions({ directory }).catch(() => []);
    const hit = known.find((session) => session.id === sessionId);
    if (hit) return hit;

    try {
      const info = await sdk.getSessionInfo?.(sessionId, directory ? { dir: directory } : {});
      if (!info) return null;
      return withLiveState(buildSessionFromInfo(info, directory));
    } catch (error) {
      console.warn('[claude-backend] getSessionInfo failed:', error?.message || error);
      return null;
    }
  };

  const getMessages = async (input = {}) => {
    const sdk = await ensureSdk();
    const sessionId = typeof input.sessionID === 'string' ? input.sessionID.trim() : '';
    if (!sdk || !sessionId) return [];

    const directory = normalizeDirectory(input.directory);
    let messages;
    try {
      messages = await sdk.getSessionMessages(sessionId, directory ? { dir: directory } : {});
    } catch (error) {
      console.warn('[claude-backend] getSessionMessages failed:', error?.message || error);
      return [];
    }

    let records = mapClaudeSessionMessages(messages, { sessionId, providerId: PROVIDER_ID });
    if (typeof input.before === 'string' && input.before.trim().length > 0) {
      records = records.filter((record) => record.info.id < input.before);
    }
    if (typeof input.limit === 'number' && input.limit > 0) {
      records = records.slice(-input.limit);
    }
    return records;
  };

  const createSession = async (input = {}) => {
    await loadOverlay();
    const sessionId = createSessionId(crypto);
    const directory = normalizeDirectory(input.directory);
    const now = Date.now();
    const title = clampText(input.title, 120);
    if (title) {
      overlay.pendingTitles[sessionId] = title;
      await persistOverlay();
    }

    const session = buildSession({
      sessionId,
      directory,
      title: title || 'New session',
      createdAt: now,
      updatedAt: now,
    });
    emitSessionUpdate('session.created', session);
    return { ...session };
  };

  const forkSession = async (input = {}) => {
    const sdk = await ensureSdk();
    const sessionId = typeof input.sessionID === 'string' ? input.sessionID.trim() : '';
    if (!sdk || !sessionId) throw new Error('Session not found');

    const directory = normalizeDirectory(input.directory);
    const result = await sdk.forkSession(sessionId, directory ? { dir: directory } : {});
    const forkedId = typeof result?.sessionId === 'string' ? result.sessionId : '';
    if (!forkedId) throw new Error('Claude did not fork the session');

    const session = await getSession({ sessionID: forkedId, directory });
    if (!session) throw new Error('Forked session could not be read');
    const withParent = { ...session, parentID: sessionId };
    emitSessionUpdate('session.created', withParent);
    return withParent;
  };

  const buildPrompt = (parts) => {
    const blocks = [];
    const unsupported = [];
    for (const part of Array.isArray(parts) ? parts : []) {
      if (part?.type === 'text') {
        const text = typeof part.text === 'string' ? part.text : '';
        if (text.length > 0) blocks.push({ type: 'text', text });
        continue;
      }
      if (part?.type === 'file') {
        const parsed = parseDataUrl(part.url);
        if (parsed && isImageMime(parsed.mime)) {
          blocks.push({ type: 'image', source: { type: 'base64', media_type: parsed.mime, data: parsed.data } });
          continue;
        }
        if (parsed) {
          blocks.push({ type: 'document', source: { type: 'base64', media_type: parsed.mime, data: parsed.data } });
          continue;
        }
        if (typeof part.url === 'string' && part.url.trim().length > 0) {
          blocks.push({
            type: 'text',
            text: `[attachment not sent: ${part.filename || part.url}]`,
          });
          unsupported.push(part.filename || part.url);
        }
      }
    }
    return { blocks, unsupported };
  };

  const applyPendingTitle = async (sdk, sessionId, directory) => {
    await loadOverlay();
    const pending = overlay.pendingTitles[sessionId];
    if (!pending) return;
    delete overlay.pendingTitles[sessionId];
    await persistOverlay();
    try {
      await sdk.renameSession(sessionId, pending, directory ? { dir: directory } : {});
    } catch (error) {
      console.warn(`[claude-backend] rename after first turn failed for ${sessionId}:`, error?.message || error);
    }
  };

  const remoteControlName = (title, directory) => {
    const label = clampText(title, 80);
    if (label && label !== 'Untitled session' && label !== 'New session') return label;
    return `OpenChamber · ${path.basename(directory || '') || 'session'}`;
  };

  const closeProcess = async (sessionId) => {
    const proc = processes.get(sessionId);
    if (!proc) return;
    processes.delete(sessionId);
    clearTimeout(idleTimers.get(sessionId));
    idleTimers.delete(sessionId);
    await proc.close();
  };

  // A live process holds memory and, with Remote Control, a claude.ai link.
  // An idle one is closed after `idleTimeoutMs`; the next prompt resumes the
  // transcript in a fresh process.
  const scheduleIdleClose = (sessionId) => {
    clearTimeout(idleTimers.get(sessionId));
    if (!(idleTimeoutMs > 0)) return;
    const timer = setTimeout(() => {
      const proc = processes.get(sessionId);
      if (proc && !proc.isBusy()) void closeProcess(sessionId);
    }, idleTimeoutMs);
    timer.unref?.();
    idleTimers.set(sessionId, timer);
  };

  /** Room for one more process: evict the longest-idle one, never a busy one. */
  const makeRoomForProcess = async () => {
    if (processes.size < maxConcurrentRuns) return;
    const idle = Array.from(processes.entries())
      .filter(([, proc]) => !proc.isBusy())
      .sort(([, a], [, b]) => a.lastActivityAt() - b.lastActivityAt());
    if (idle.length === 0) {
      throw new Error(`Claude is already running ${processes.size} sessions (limit ${maxConcurrentRuns}). Stop one first.`);
    }
    await closeProcess(idle[0][0]);
  };

  const startProcess = async ({ sdk, sessionId, directory, model, effort, permissionMode, title }) => {
    await makeRoomForProcess();
    const executable = await resolveExecutable();
    const resume = (await transcriptExists(sdk, sessionId, directory)) && !overlay.pendingTitles[sessionId];
    const flagSettings = remoteControl?.baseUrl ? { env: { ANTHROPIC_BASE_URL: remoteControl.baseUrl } } : undefined;

    const proc = createClaudeSessionProcess({
      sdk,
      sessionId,
      directory,
      model,
      options: {
        cwd: directory || undefined,
        model,
        effort,
        permissionMode,
        settingSources,
        includePartialMessages: true,
        env: { ...process.env },
        // Prompts from another surface (claude.ai) reach the stream only as
        // echoes; this is the flag the VS Code extension runs with too.
        extraArgs: { 'replay-user-messages': null },
        ...(flagSettings ? { settings: flagSettings } : {}),
        ...pathToExecutableOption(executable),
        ...(resume ? { resume: sessionId } : { sessionId }),
      },
      remoteControl: remoteControl?.enabled ? { name: remoteControlName(title, directory) } : null,
      emit: (payload) => emitEvent(directory, payload),
      setStatus: (status) => setBusyStatus(sessionId, directory, status),
      onRemotePrompt: (text) => {
        const now = Date.now();
        const recordId = `msg_${String(now).padStart(14, '0')}_000000_remote`;
        emitRecordEvents(directory, {
          info: {
            id: recordId,
            sessionID: sessionId,
            role: 'user',
            time: { created: new Date(now).toISOString(), completed: new Date(now).toISOString() },
          },
          parts: [{ id: `${recordId}_text_0`, sessionID: sessionId, messageID: recordId, type: 'text', text }],
        });
      },
      onRemoteControl: () => {
        listCache.clear();
        void getSession({ sessionID: sessionId, directory })
          .then((session) => session && emitSessionUpdate('session.updated', session))
          .catch(() => {});
      },
      onTurnEnd: async () => {
        await applyPendingTitle(sdk, sessionId, directory);
        listCache.clear();
        const known = await getSession({ sessionID: sessionId, directory }).catch(() => null);
        emitSessionUpdate('session.updated', withLiveState(buildSession({
          sessionId,
          directory,
          title: known?.title || title || 'Untitled session',
          createdAt: known?.time?.created ?? Date.now(),
          updatedAt: Date.now(),
          metadata: known?.metadata ?? null,
        })));
        scheduleIdleClose(sessionId);
      },
      onExit: () => {
        if (processes.get(sessionId) === proc) {
          processes.delete(sessionId);
          clearTimeout(idleTimers.get(sessionId));
          idleTimers.delete(sessionId);
        }
      },
      createUuid: () => createSessionId(crypto),
    });
    processes.set(sessionId, proc);
    return proc;
  };

  const promptAsync = async (input = {}) => {
    const sdk = await ensureSdk();
    if (!sdk) throw new Error('Claude backend is not available');
    await loadOverlay();

    const sessionId = typeof input.sessionID === 'string' ? input.sessionID.trim() : '';
    if (!sessionId) throw new Error('Session not found');
    const live = processes.get(sessionId);
    if (live?.isBusy()) throw new Error('Session is already running');

    const directory = normalizeDirectory(input.directory) || live?.directory || '';
    const settings = await readSettings();
    const modeId = MODE_DEFINITIONS[input.agent] ? input.agent : DEFAULT_MODE_ID;
    const permissionMode = MODE_DEFINITIONS[modeId].permissionMode;
    const effort = EFFORT_OPTIONS.some((option) => option.id === input.variant)
      ? input.variant
      : (typeof settings?.effortLevel === 'string' && EFFORT_OPTIONS.some((option) => option.id === settings.effortLevel)
        ? settings.effortLevel
        : DEFAULT_EFFORT_ID);
    const model = typeof input.model?.modelID === 'string' && input.model.modelID.trim().length > 0
      ? input.model.modelID.trim()
      : (typeof settings?.model === 'string' && settings.model.trim() ? settings.model.trim() : undefined);

    const { blocks, unsupported } = buildPrompt(input.parts);
    if (blocks.length === 0) {
      throw new Error('Cannot start a turn with empty input — the message had no text or attachment');
    }
    if (unsupported.length > 0) {
      console.warn(`[claude-backend] ${unsupported.length} attachment(s) could not be sent for ${sessionId}`);
    }

    // Effort is fixed when the CLI starts; a different one needs a new process.
    if (live && live.effort !== effort) await closeProcess(sessionId);
    let proc = processes.get(sessionId);
    if (!proc) {
      const existing = await getSession({ sessionID: sessionId, directory }).catch(() => null);
      proc = await startProcess({
        sdk,
        sessionId,
        directory,
        model,
        effort,
        permissionMode,
        title: overlay.pendingTitles[sessionId] || existing?.title,
      });
    } else {
      await proc.applyModel(model);
      await proc.applyPermissionMode(permissionMode);
    }
    clearTimeout(idleTimers.get(sessionId));

    const now = Date.now();
    const userRecordId = `msg_${String(now).padStart(14, '0')}_000000_local`;
    emitRecordEvents(directory, {
      info: {
        id: typeof input.messageID === 'string' && input.messageID.trim() ? input.messageID.trim() : userRecordId,
        sessionID: sessionId,
        role: 'user',
        time: { created: new Date(now).toISOString(), completed: new Date(now).toISOString() },
      },
      parts: blocks
        .filter((block) => block.type === 'text')
        .map((block, index) => ({
          id: `${userRecordId}_text_${index}`,
          sessionID: sessionId,
          messageID: userRecordId,
          type: 'text',
          text: block.text,
        })),
    });

    const turnDone = proc.send(blocks);
    // The turn is accepted from here on: every later failure is reported as a
    // `session.error` event, so an HTTP caller can be answered now instead of
    // being held open for the whole turn.
    input.onStarted?.();
    return turnDone;
  };

  const abortSession = async (input = {}) => {
    const sessionId = typeof input.sessionID === 'string' ? input.sessionID.trim() : '';
    const proc = processes.get(sessionId);
    if (proc) {
      await proc.interrupt();
      return true;
    }
    const entry = await getSession({ sessionID: sessionId }).catch(() => null);
    setBusyStatus(sessionId, entry?.directory || normalizeDirectory(input.directory), { type: 'idle' });
    return true;
  };

  const updateSession = async (input = {}) => {
    const sdk = await ensureSdk();
    const sessionId = typeof input.sessionID === 'string' ? input.sessionID.trim() : '';
    if (!sessionId) throw new Error('Session not found');

    await loadOverlay();
    const directory = normalizeDirectory(input.directory);
    const current = await getSession({ sessionID: sessionId, directory });

    const requestedTitle = typeof input.title === 'string' ? clampText(input.title, 120) : null;
    if (requestedTitle && sdk) {
      try {
        await sdk.renameSession(sessionId, requestedTitle, directory ? { dir: directory } : {});
      } catch (error) {
        await loadOverlay();
        overlay.pendingTitles[sessionId] = requestedTitle;
        await persistOverlay();
        console.warn(`[claude-backend] renameSession deferred for ${sessionId}:`, error?.message || error);
      }
    }

    const archivedAt = typeof input?.time?.archived === 'number' ? input.time.archived : null;
    if (archivedAt) {
      overlay.archived[sessionId] = archivedAt;
      await persistOverlay();
    } else if (input?.time && 'archived' in input.time && !input.time.archived) {
      delete overlay.archived[sessionId];
      await persistOverlay();
    }

    const next = buildSession({
      sessionId,
      directory: directory || current?.directory || '',
      title: requestedTitle || current?.title || 'Untitled session',
      createdAt: current?.time?.created ?? Date.now(),
      updatedAt: Date.now(),
    });
    if (overlay.archived[sessionId]) {
      next.time.archived = overlay.archived[sessionId];
    }
    emitSessionUpdate('session.updated', next);
    return { ...next };
  };

  const deleteSession = async (input = {}) => {
    const sdk = await ensureSdk();
    const sessionId = typeof input.sessionID === 'string' ? input.sessionID.trim() : '';
    if (!sessionId) return false;

    await closeProcess(sessionId);

    const directory = normalizeDirectory(input.directory);
    let removed = false;
    if (sdk) {
      try {
        await sdk.deleteSession(sessionId, directory ? { dir: directory } : {});
        removed = true;
      } catch (error) {
        console.warn('[claude-backend] deleteSession failed:', error?.message || error);
      }
    }

    await loadOverlay();
    const hadOverlay = Boolean(overlay.archived[sessionId] || overlay.pendingTitles[sessionId]);
    delete overlay.archived[sessionId];
    delete overlay.pendingTitles[sessionId];
    if (hadOverlay) await persistOverlay();
    listCache.clear();

    if (!removed && !hadOverlay) return false;
    emitEvent(directory, {
      type: 'session.deleted',
      properties: { info: { id: sessionId, directory }, directory },
    });
    return true;
  };

  const getStatusSnapshot = async (input = {}) => {
    const directory = normalizeDirectory(input.directory);
    const result = {};
    for (const [sessionId, proc] of processes) {
      if (!proc.isBusy()) continue;
      if (directory && proc.directory !== directory) continue;
      result[sessionId] = { type: 'busy' };
    }
    return result;
  };

  const addEventClient = (res, directory) => {
    const client = { res, directory: normalizeDirectory(directory) };
    eventClients.add(client);
    const remove = () => {
      eventClients.delete(client);
    };
    res.on('close', remove);
    return () => {
      res.off('close', remove);
      remove();
    };
  };

  const getControlSurface = async () => {
    const models = await readModelCatalog();
    const settings = await readSettings();
    const defaultModelId = (typeof settings?.model === 'string' && settings.model.trim())
      ? settings.model.trim()
      : models[0]?.id;
    const defaultEffort = EFFORT_OPTIONS.some((option) => option.id === settings?.effortLevel)
      ? settings.effortLevel
      : DEFAULT_EFFORT_ID;

    const interactionModes = Object.values(MODE_DEFINITIONS).map((mode) => ({
      id: mode.id,
      label: mode.label,
      description: mode.description,
      isDefault: mode.id === DEFAULT_MODE_ID,
    }));

    const effortOptionDescriptor = {
      id: 'effort',
      label: 'Thinking',
      type: 'select',
      currentValue: defaultEffort,
      options: EFFORT_OPTIONS.map((option) => ({
        id: option.id,
        label: option.label,
        isDefault: option.id === defaultEffort,
      })),
    };

    return {
      backendId: BACKEND_ID,
      providerSnapshot: {
        backendId: BACKEND_ID,
        label: 'Claude',
        enabled: true,
        auth: { status: 'unknown' },
        capabilities: {
          chat: true,
          sessions: true,
          models: true,
          commands: false,
          providers: false,
          auth: false,
          config: false,
          skills: false,
          shell: false,
        },
        models: models.map((entry) => ({
          ...toModelOption(entry),
          default: entry.id === defaultModelId,
          optionDescriptors: [{ ...effortOptionDescriptor }],
        })),
        interactionModes,
        commands: [],
      },
      modeSelector: {
        kind: 'mode',
        label: 'Mode',
        items: interactionModes,
      },
      modelSelector: {
        label: 'Model',
        source: 'provider-snapshot',
        providerId: PROVIDER_ID,
        defaultOptionId: defaultModelId,
        options: models.map((entry) => toModelOption(entry)),
      },
      effortSelector: {
        label: 'Thinking',
        source: 'provider-option',
        optionId: 'effort',
        defaultOptionId: defaultEffort,
        options: EFFORT_OPTIONS.map((option) => ({ ...option })),
      },
      commandSelector: {
        source: 'backend',
        items: [],
      },
    };
  };

  const shutdownAll = async () => {
    await Promise.all(Array.from(processes.keys()).map((sessionId) => closeProcess(sessionId)));
  };

  // Kick availability detection off at construction so the sync
  // `isAvailable()` used by the startup pipeline has an answer.
  void ensureSdk();

  return {
    ensureAvailable,
    isAvailable,
    listSessions,
    createSession,
    forkSession,
    getSession,
    getMessages,
    promptAsync,
    abortSession,
    updateSession,
    deleteSession,
    getStatusSnapshot,
    addEventClient,
    getControlSurface,
    shutdownAll,
  };
};

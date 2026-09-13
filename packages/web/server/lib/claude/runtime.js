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

const BACKEND_ID = 'claude';
const PROVIDER_ID = 'claude';
const LIST_CACHE_TTL_MS = 4000;
const DEFAULT_MAX_CONCURRENT_RUNS = 4;
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
  } = dependencies;

  const eventClients = new Set();
  const runs = new Map();
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
    return result.map((session) => ({ ...session }));
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
      return buildSessionFromInfo(info, directory);
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

  const promptAsync = async (input = {}) => {
    const sdk = await ensureSdk();
    if (!sdk) throw new Error('Claude backend is not available');
    await loadOverlay();

    const sessionId = typeof input.sessionID === 'string' ? input.sessionID.trim() : '';
    if (!sessionId) throw new Error('Session not found');
    if (runs.has(sessionId)) throw new Error('Session is already running');
    if (runs.size >= maxConcurrentRuns) {
      throw new Error(`Claude is already running ${runs.size} sessions (limit ${maxConcurrentRuns}). Stop one first.`);
    }

    const directory = normalizeDirectory(input.directory);
    const settings = await readSettings();
    const modeId = MODE_DEFINITIONS[input.agent] ? input.agent : DEFAULT_MODE_ID;
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

    const now = Date.now();
    const userRecordId = `msg_${String(now).padStart(14, '0')}_000000_local`;
    const userRecord = {
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
    };
    emitRecordEvents(directory, userRecord);

    const existing = await getSession({ sessionID: sessionId, directory }).catch(() => null);
    const abortController = new AbortController();
    runs.set(sessionId, { abortController, directory });
    setBusyStatus(sessionId, directory, { type: 'busy' });

    // One OpenChamber message per Claude API message id; the CLI emits several
    // API messages per turn (one per tool round), so ids must not be reused.
    const streamingParts = new Map();

    const ensureStreamingPart = (apiMessageId, index, type, text) => {
      const messageId = `msg_${apiMessageId}`;
      const partId = `${messageId}_${type}_${index}`;
      const existingPart = streamingParts.get(partId);
      if (existingPart) {
        existingPart.text += text;
        return existingPart;
      }

      const part = { id: partId, sessionID: sessionId, messageID: messageId, type, text };
      streamingParts.set(partId, part);
      emitEvent(directory, {
        type: 'message.updated',
        properties: {
          info: {
            id: messageId,
            sessionID: sessionId,
            role: 'assistant',
            model: { providerID: PROVIDER_ID, modelID: model || '' },
            providerID: PROVIDER_ID,
            modelID: model || '',
            time: { created: new Date().toISOString() },
          },
          directory,
        },
      });
      // The reducer applies deltas to an existing part only, so open it empty.
      emitEvent(directory, {
        type: 'message.part.updated',
        properties: { part: { ...part, text: '' }, directory },
      });
      return existingPart || part;
    };

    const emitStreamingPart = (partId) => {
      const part = streamingParts.get(partId);
      if (!part) return;
      emitEvent(directory, {
        type: 'message.part.updated',
        properties: { part: { ...part }, directory },
      });
    };

    try {
      const executable = await resolveExecutable();
      const query = sdk.query({
        prompt: blocks.length === 1 && blocks[0].type === 'text'
          ? blocks[0].text
          : (async function* promptStream() {
            yield {
              type: 'user',
              session_id: sessionId,
              parent_tool_use_id: null,
              message: { role: 'user', content: blocks },
            };
          })(),
        options: {
          cwd: directory || undefined,
          model,
          effort,
          permissionMode: MODE_DEFINITIONS[modeId].permissionMode,
          settingSources,
          includePartialMessages: true,
          abortController,
          env: { ...process.env },
          ...pathToExecutableOption(executable),
          ...(((await transcriptExists(sdk, sessionId, directory)) && !overlay.pendingTitles[sessionId])
            ? { resume: sessionId }
            : { sessionId }),
        },
      });
      runs.set(sessionId, { abortController, directory, query });

      let currentApiMessageId = null;

      for await (const message of query) {
        if (message?.type === 'stream_event') {
          const event = message.event;
          if (event?.type === 'message_start') {
            currentApiMessageId = typeof event.message?.id === 'string' ? event.message.id : null;
            continue;
          }
          if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            const apiMessageId = currentApiMessageId || `turn-${Date.now()}`;
            const index = typeof event.index === 'number' ? event.index : 0;
            ensureStreamingPart(apiMessageId, index, 'text', event.delta.text || '');
            emitEvent(directory, {
              type: 'message.part.delta',
              properties: {
                sessionID: sessionId,
                messageID: `msg_${apiMessageId}`,
                partID: `${`msg_${apiMessageId}`}_text_${index}`,
                field: 'text',
                delta: event.delta.text || '',
              },
            });
          }
          continue;
        }

        if (message?.type === 'assistant') {
          const apiMessageId = typeof message.message?.id === 'string'
            ? message.message.id
            : (currentApiMessageId || `turn-${Date.now()}`);
          const content = Array.isArray(message.message?.content) ? message.message.content : [];
          content.forEach((block, index) => {
            if (block?.type === 'text') {
              ensureStreamingPart(apiMessageId, index, 'text', block.text || '');
              emitStreamingPart(`${`msg_${apiMessageId}`}_text_${index}`);
              return;
            }
            if (block?.type === 'tool_use') {
              // Results are only known once the transcript is re-read, so the
              // live part stays 'running' until the post-turn refresh.
              const messageId = `msg_${apiMessageId}`;
              const callId = typeof block.id === 'string' ? block.id : `${messageId}_tool_${index}`;
              emitEvent(directory, {
                type: 'message.updated',
                properties: {
                  info: {
                    id: messageId,
                    sessionID: sessionId,
                    role: 'assistant',
                    model: { providerID: PROVIDER_ID, modelID: model || '' },
                    providerID: PROVIDER_ID,
                    modelID: model || '',
                    time: { created: new Date().toISOString() },
                  },
                  directory,
                },
              });
              emitEvent(directory, {
                type: 'message.part.updated',
                properties: {
                  part: {
                    id: `${messageId}_tool_${index}`,
                    sessionID: sessionId,
                    messageID: messageId,
                    type: 'tool',
                    callID: callId,
                    tool: typeof block.name === 'string' ? block.name : 'tool',
                    state: {
                      status: 'running',
                      input: block.input && typeof block.input === 'object' ? block.input : undefined,
                    },
                  },
                  directory,
                },
              });
            }
          });
          continue;
        }

        if (message?.type === 'result') {
          if (message.is_error) {
            emitEvent(directory, {
              type: 'session.error',
              properties: {
                sessionID: sessionId,
                error: { message: typeof message.result === 'string' ? message.result : 'Claude run failed' },
                directory,
              },
            });
          }
          continue;
        }
      }

      await applyPendingTitle(sdk, sessionId, directory);

      const updated = buildSession({
        sessionId,
        directory,
        title: existing?.title || 'Untitled session',
        createdAt: existing?.time?.created ?? now,
        updatedAt: Date.now(),
      });
      emitSessionUpdate('session.updated', updated);
      return { ok: true };
    } catch (error) {
      if (error?.name !== 'AbortError') {
        emitEvent(directory, {
          type: 'session.error',
          properties: {
            sessionID: sessionId,
            error: { message: error instanceof Error ? error.message : 'Claude run failed' },
            directory,
          },
        });
      }
      throw error;
    } finally {
      runs.delete(sessionId);
      setBusyStatus(sessionId, directory, { type: 'idle' });
      listCache.clear();
      if (unsupported.length > 0) {
        console.warn(`[claude-backend] ${unsupported.length} attachment(s) could not be sent for ${sessionId}`);
      }
    }
  };

  const abortSession = async (input = {}) => {
    const sessionId = typeof input.sessionID === 'string' ? input.sessionID.trim() : '';
    const run = runs.get(sessionId);
    if (run) {
      try {
        await run.query?.interrupt?.();
      } catch {
        // best effort
      }
      try {
        run.abortController.abort();
      } catch {
        // best effort
      }
      runs.delete(sessionId);
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

    await abortSession({ sessionID: sessionId, directory: input.directory });

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
    for (const [sessionId, run] of runs) {
      if (directory && run.directory !== directory) continue;
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
    for (const [sessionId, run] of Array.from(runs)) {
      try {
        await run.query?.interrupt?.();
      } catch {
        // best effort
      }
      try {
        run.abortController.abort();
      } catch {
        // best effort
      }
      runs.delete(sessionId);
    }
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

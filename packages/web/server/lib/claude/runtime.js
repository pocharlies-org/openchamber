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
import { mapClaudeSessionMessages, deriveClaudeTitle, isClaudeTitlePlaceholder, isClaudeGeneratedName, hasClaudeExplicitTitle, findForkCut, findPromptUuid } from './claude-transcript.js';
import { createClaudeRequests } from './claude-requests.js';
import { createClaudeSessionProcess } from './session-process.js';
import { createTranscriptSidecar, isSafeId } from './transcript-sidecar.js';
import { remoteControlUrl } from './live-sessions.js';
import { isCompanyClaudeSession } from './company-sessions.js';

const BACKEND_ID = 'claude';
const PROVIDER_ID = 'claude';
const LIST_CACHE_TTL_MS = 15_000;
// Listing reads the head of every transcript (~5 s for 1,600 of them). Past
// the TTL a list younger than this is still served while a fresh read runs in
// the background: the UI lists several directories at once and would otherwise
// wait on that read every few seconds.
const LIST_STALE_MAX_MS = 5 * 60 * 1000;
const DEFAULT_MAX_CONCURRENT_RUNS = 4;
const DEFAULT_IDLE_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_LIVE_POLL_MS = 2000;
// A session whose messages were read this recently is being looked at: its
// transcript is followed while another process writes it.
const LIVE_FOLLOW_WINDOW_MS = 15 * 60 * 1000;
// A session nobody touched in this long counts as archived, as
// opencode-archive-prune does for OpenCode's: nothing archives the transcripts
// VS Code, Desktop and `claude -p` leave behind, and they were 1,600 on 25-09.
const DEFAULT_AUTO_ARCHIVE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MODE_ID = 'default';
const DEFAULT_EFFORT_ID = 'high';
const SDK_IMPORT_PATH = '@anthropic-ai/claude-agent-sdk';

/** A fork named a record the transcript does not have (a stale view, or another session's id). */
export class ClaudeForkPointNotFoundError extends Error {
  constructor(recordId) {
    super(`The message to fork from (${recordId}) is not in this session's transcript; reload the session and try again`);
    this.name = 'ClaudeForkPointNotFoundError';
    this.code = 'CLAUDE_FORK_POINT_NOT_FOUND';
  }
}

/**
 * Claude Code's permission modes, named as the VS Code extension's mode
 * indicator names them. Bypass is offered only where the user already
 * accepted it for the CLI (`skipDangerousModePermissionPrompt`) or the host
 * opts in (OPENCHAMBER_CLAUDE_ALLOW_BYPASS=1).
 */
const MODE_DEFINITIONS = Object.freeze({
  default: {
    id: 'default',
    label: 'Manual',
    description: 'Asks before edits and most shell commands',
    permissionMode: 'default',
  },
  acceptEdits: {
    id: 'acceptEdits',
    label: 'Edit automatically',
    description: 'Edits files without asking',
    permissionMode: 'acceptEdits',
  },
  plan: {
    id: 'plan',
    label: 'Plan',
    description: 'Plans first and waits for your approval before changing anything',
    permissionMode: 'plan',
  },
  auto: {
    id: 'auto',
    label: 'Auto',
    description: 'A classifier reviews most actions instead of asking',
    permissionMode: 'auto',
  },
  bypassPermissions: {
    id: 'bypassPermissions',
    label: 'Bypass permissions',
    description: 'Runs every tool without asking',
    permissionMode: 'bypassPermissions',
    dangerous: true,
  },
});

/** The mode id a permission mode is offered under. */
const modeIdOf = (permissionMode) => Object.values(MODE_DEFINITIONS).find((mode) => mode.permissionMode === permissionMode)?.id ?? null;

const EFFORT_OPTIONS = Object.freeze([
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  // The CLI's slider has five stops and calls xhigh "Extra"; a session pinned
  // to xhigh in settings.json was unrepresentable here, so the picker showed
  // the default instead of the level the turn actually runs on.
  { id: 'xhigh', label: 'Extra' },
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

const buildSession = ({ sessionId, directory, title, createdAt, updatedAt, metadata, parentId = null }) => {
  const session = {
    id: sessionId,
    title: clampText(title, 120) || 'Untitled session',
    directory: normalizeDirectory(directory),
    parentID: parentId,
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

/**
 * A subagent is served as a child session of the session that ran it:
 * `<session>~<agentId>`. Every depth hangs off the root session, which is where
 * Claude Code files all its subagents (`<session>/subagents/agent-<id>.jsonl`).
 */
const CHILD_SEPARATOR = '~';

const childSessionIdOf = (sessionId, agentId) => `${sessionId}${CHILD_SEPARATOR}${agentId}`;

export const parseChildSessionId = (id) => {
  const at = typeof id === 'string' ? id.indexOf(CHILD_SEPARATOR) : -1;
  if (at <= 0 || at === id.length - 1) return null;
  const parentId = id.slice(0, at);
  const agentId = id.slice(at + 1);
  // Both halves name files (transcripts, `agent-<id>.jsonl`): plain ids only.
  if (!isSafeId(parentId) || !isSafeId(agentId)) return null;
  return { parentId, agentId };
};

/** Selector option shape: description is present only when the model has one. */
const toModelOption = (entry) => {
  const option = { id: entry.id, label: entry.label };
  if (entry.description) {
    option.description = entry.description;
  }
  return option;
};

/** A prompt for a session another process is writing; carries that owner. */
export class ClaudeSessionLiveElsewhereError extends Error {
  constructor(owner) {
    super(`This session is open in ${owner.entrypoint} (pid ${owner.pid}). Take it over to continue it here.`);
    this.name = 'ClaudeSessionLiveElsewhereError';
    this.code = 'CLAUDE_SESSION_LIVE_ELSEWHERE';
    this.owner = owner;
  }
}

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
    // Registry of sessions live in a CLI process OpenChamber does not own
    // (live-sessions.js). Without it every session is assumed free.
    liveRegistry = null,
    // Writes to a session live in another process through its Remote Control
    // bridge (remote-attach.js), as Claude Desktop does. Without it such a
    // session can only be taken over.
    remoteAttach = null,
    // Our own CLI children are in Claude Code's registry too; they are told
    // apart by their parent pid.
    selfPid = process.pid,
    // What the SDK's transcript reader drops (transcript-sidecar.js).
    transcriptSidecar = null,
    // The public id of a session, for links the records carry (a subagent call
    // → its child session). routes.js owns the id scheme.
    toPublicId = (id) => id,
    livePollMs = DEFAULT_LIVE_POLL_MS,
    liveFollowWindowMs = LIVE_FOLLOW_WINDOW_MS,
    // 0 turns automatic archiving off.
    autoArchiveAfterMs = DEFAULT_AUTO_ARCHIVE_AFTER_MS,
    // OpenChamber's auto-accept policy and routing safety net
    // (lib/permission-auto-accept, lib/routing), keyed by public session id.
    isAutoAccepting = null,
    evaluatePermission = null,
    // OpenChamber's own settings (Settings › Defaults), read from its store:
    // `claudeDefaultModel` / `claudeDefaultEffort` / `claudeDefaultMode` set the
    // model, thinking level and mode a new Claude session starts on, ahead of
    // Claude Code's `~/.claude/settings.json`. Absent or unset falls through.
    readAppSettings = null,
  } = dependencies;

  const eventClients = new Set();
  /** Live CLI process per session id; see session-process.js. */
  const processes = new Map();
  const idleTimers = new Map();
  const listCache = new Map();
  /** Map<cacheKey, Promise>: one transcript scan per key at a time. */
  const listInflight = new Map();
  /** Bumped on every hard invalidation, so a scan started before it cannot refill the cache. */
  let listGeneration = 0;
  /** Bumped on every soft invalidation: a scan that straddles one stores its result already expired. */
  let listStaleness = 0;
  const invalidateList = () => {
    listGeneration += 1;
    listCache.clear();
    listInflight.clear();
  };
  /**
   * A process elsewhere started or stopped: the list is out of date, not
   * wrong. Live state is read per call (withLiveState), so the cached records
   * stay servable while a rescan runs — with a dozen CLI sessions coming and
   * going, a hard clear here rescanned every transcript on every list call.
   */
  const markListStale = () => {
    const expired = Date.now() - LIST_CACHE_TTL_MS;
    for (const entry of listCache.values()) entry.at = Math.min(entry.at, expired);
    // Never a second scan beside a running one (each reads every transcript):
    // one that may predate the change stores its result already expired, so
    // the next call refreshes again.
    listStaleness += 1;
  };
  /** Map<sessionId, owner>: sessions live in a process that is not ours. */
  let foreignOwners = new Map();
  /** Map<sessionId, { directory, readAt, lastModified, sent: Map<recordId, json> }> */
  const followed = new Map();
  let livePollTimer = null;

  /** OpenChamber-side overlay: Claude owns transcripts, not archive state. */
  /** `selections` keeps the model/thinking/mode a session was created with. */
  let overlay = { archived: {}, pendingTitles: {}, kept: {}, selections: {} };
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
        kept: parsed?.kept && typeof parsed.kept === 'object' ? parsed.kept : {},
        selections: parsed?.selections && typeof parsed.selections === 'object' ? parsed.selections : {},
      };
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        console.warn('[claude-backend] Failed to read overlay:', error);
      }
      overlay = { archived: {}, pendingTitles: {}, kept: {}, selections: {} };
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

  const sidecar = transcriptSidecar || createTranscriptSidecar({
    fsPromises,
    configDir: process.env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude'),
  });

  /**
   * The CLI's own summary of a session, from its transcript, reread only when
   * the transcript changed: the list scan asks for it on every refresh, and
   * these are full JSONL files.
   */
  const aiTitleCache = new Map();
  const aiTitleOf = async (sessionId, directory) => {
    const file = await sidecar.locate(sessionId, directory).catch(() => null);
    if (!file) return '';
    let mtimeMs = 0;
    try {
      mtimeMs = (await fsPromises.stat(file)).mtimeMs;
    } catch {
      return '';
    }
    const known = aiTitleCache.get(sessionId);
    if (known && known.file === file && known.mtimeMs === mtimeMs) return known.title;
    const title = await sidecar.readAiTitle(sessionId, directory).catch(() => '');
    aiTitleCache.set(sessionId, { file, mtimeMs, title });
    return title;
  };

  /**
   * The real custom title an earlier transcript record carries when the newest
   * one is a generated VS Code name (see `readRealCustomTitle`). Cached the
   * same way as the ai-title: one read per transcript change.
   */
  const realCustomTitleCache = new Map();
  const realCustomTitleOf = async (sessionId, directory) => {
    const file = await sidecar.locate(sessionId, directory).catch(() => null);
    if (!file) return '';
    let mtimeMs = 0;
    try {
      mtimeMs = (await fsPromises.stat(file)).mtimeMs;
    } catch {
      return '';
    }
    const known = realCustomTitleCache.get(sessionId);
    if (known && known.file === file && known.mtimeMs === mtimeMs) return known.title;
    const title = await (sidecar.readRealCustomTitle?.(sessionId, directory) ?? Promise.resolve('')).catch(() => '');
    realCustomTitleCache.set(sessionId, { file, mtimeMs, title });
    return title;
  };

  /**
   * The first prompt read from the transcript (see `readFirstPrompt`), for when
   * the SDK's comes back empty. It never changes once written, so one read.
   */
  const firstPromptCache = new Map();
  const firstPromptOf = async (sessionId, directory) => {
    if (firstPromptCache.has(sessionId)) return firstPromptCache.get(sessionId);
    const prompt = await (sidecar.readFirstPrompt?.(sessionId, directory) ?? Promise.resolve('')).catch(() => '');
    if (prompt) firstPromptCache.set(sessionId, prompt);
    return prompt;
  };

  /**
   * What the engine learns about a session as it runs — the mode it is in,
   * the prompt cache's lifetime, the model's context window — published on
   * the session as `metadata.claude`.
   */
  const sessionState = new Map();
  const rememberState = (sessionId, patch) => {
    const previous = sessionState.get(sessionId) || {};
    const next = { ...previous, ...patch };
    const changed = Object.keys(patch).some((key) => previous[key] !== next[key]);
    sessionState.set(sessionId, next);
    return changed;
  };

  /** Subagents seen running here, by child session id, until their process ends. */
  const liveSubagents = new Map();

  /** Claude Code's permission prompts, questions and plan approvals (claude-requests.js). */
  const requests = createClaudeRequests({
    emit: (payload) => emitEvent(payload.properties?.directory, payload),
    createId: () => createId(crypto),
    isAutoAccepting: typeof isAutoAccepting === 'function'
      ? (sessionId, directory) => Promise.resolve(isAutoAccepting(toPublicId(sessionId), directory))
      : null,
    evaluatePermission: typeof evaluatePermission === 'function'
      ? (request, directory) => Promise.resolve(evaluatePermission({ ...request, sessionID: toPublicId(request.sessionID) }, directory))
      : null,
  });

  /** Re-publish a session after the engine's facts about it changed. */
  const announce = async (sessionId) => {
    const session = await getSession({ sessionID: sessionId }).catch(() => null);
    if (session) emitSessionUpdate('session.updated', session);
  };

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

  const buildSessionFromInfo = async (info, fallbackDirectory) => {
    let title = deriveClaudeTitle(info);
    // A generated VS Code name stamped as the newest custom title is not the
    // session's title: the one the conversation earned sits in an earlier
    // record, and when there is none, the `ai-title` below gets its say — the
    // stamp is no more a title than the Remote Control placeholder was.
    const generated = isClaudeGeneratedName(info?.customTitle);
    const real = generated ? await realCustomTitleOf(info.sessionId, info.cwd || fallbackDirectory || undefined) : '';
    if (real) {
      title = clampText(real, 120);
    } else if (generated || isClaudeTitlePlaceholder(title) || !hasClaudeExplicitTitle(info)) {
      // The stamp is no title even when nothing real sits under it: without an
      // `ai-title`, the first prompt says what the session is about. Not the
      // SDK's `summary` — that is its display title, the stamp again.
      if (generated) {
        const prompt = info.firstPrompt || await firstPromptOf(info.sessionId, info.cwd || fallbackDirectory || undefined);
        title = deriveClaudeTitle({ firstPrompt: prompt });
      }
      // VS Code names a session by its `custom-title` first and the `ai-title`
      // the CLI generated second; the raw first prompt is nobody's title, it
      // is only what the SDK scan falls back to. So whenever the SDK gave us
      // no title of its own — no custom title, no summary, or one the old
      // Remote Control placeholder had written (see `remoteControlName`) —
      // the transcript's `ai-title` decides, and the two views agree. Without
      // one (a session with no turns yet) the fallback stays, honest about
      // being untitled.
      const ai = await aiTitleOf(info.sessionId, info.cwd || fallbackDirectory || undefined);
      if (ai) title = clampText(ai, 120);
    }
    return buildSession({
      sessionId: info.sessionId,
      directory: info.cwd || fallbackDirectory || '',
      title,
      createdAt: info.createdAt ?? info.lastModified,
      updatedAt: info.lastModified,
      metadata: {
        ...(info.gitBranch ? { gitBranch: info.gitBranch } : {}),
        // The sidebar files these into the "Compañía" folder automatically.
        ...(isCompanyClaudeSession(info) ? { company: true } : {}),
      },
    });
  };

  /** A session with a live process advertises its Remote Control link. */
  const withLiveState = (input) => {
    const state = sessionState.get(input.id);
    const session = state && Object.keys(state).length > 0
      ? { ...input, metadata: { ...(input.metadata || {}), claude: { ...(input.metadata?.claude || {}), ...state } } }
      : input;
    const link = processes.get(session.id)?.remoteControl();
    if (link) {
      return { ...session, metadata: { ...(session.metadata || {}), remoteControl: { url: link.url } } };
    }
    const owner = foreignOwners.get(session.id);
    if (!owner) return { ...session };
    const url = remoteControlUrl(owner.bridgeSessionId);
    return {
      ...session,
      metadata: {
        ...(session.metadata || {}),
        liveElsewhere: {
          entrypoint: owner.entrypoint,
          name: owner.name,
          status: owner.status,
          pid: owner.pid,
          attachable: Boolean(remoteAttach && owner.bridgeSessionId),
        },
        ...(url ? { remoteControl: { url } } : {}),
      },
    };
  };

  /**
   * When the session counts as archived, or null. An archive by hand wins;
   * otherwise a session idle for autoArchiveAfterMs is archived from the moment
   * it crossed that line, unless it is live somewhere or was unarchived by hand
   * since. New activity in the transcript brings it back by itself.
   */
  const archivedAtOf = (session) => {
    const explicit = overlay.archived[session.id];
    if (explicit) return explicit;
    const updated = session.time?.updated;
    if (!autoArchiveAfterMs || !updated) return null;
    if (processes.has(session.id) || foreignOwners.has(session.id)) return null;
    const archivedAt = Math.max(updated, overlay.kept[session.id] ?? 0) + autoArchiveAfterMs;
    return archivedAt <= Date.now() ? archivedAt : null;
  };

  const withArchiveState = (session) => {
    const archivedAt = archivedAtOf(session);
    return archivedAt ? { ...session, time: { ...session.time, archived: archivedAt } } : session;
  };

  const listSessions = async (input = {}) => {
    const sdk = await ensureSdk();
    if (!sdk) return [];
    ensureLivePolling();

    await loadOverlay();
    const directory = normalizeDirectory(input.directory);
    const archivedOnly = input.archived === true;
    const anyArchiveState = input.archived === 'any';
    const rootsOnly = input.roots !== false;
    const limit = typeof input.limit === 'number' && input.limit > 0 ? input.limit : null;

    const cacheKey = directory || '*';
    const scan = () => {
      const pending = listInflight.get(cacheKey);
      if (pending) return pending;
      const generation = listGeneration;
      const staleness = listStaleness;
      const promise = (async () => {
        const listRequest = { includeProgrammatic: true };
        if (directory) {
          listRequest.dir = directory;
        }
        const infos = await sdk.listSessions(listRequest);
        const scanned = await Promise.all((Array.isArray(infos) ? infos : [])
          .filter((info) => info && typeof info.sessionId === 'string')
          .map((info) => buildSessionFromInfo(info, directory)));
        if (generation === listGeneration) {
          const at = staleness === listStaleness ? Date.now() : Date.now() - LIST_CACHE_TTL_MS;
          listCache.set(cacheKey, { at, sessions: scanned });
        }
        return scanned;
      })().finally(() => {
        if (listInflight.get(cacheKey) === promise) listInflight.delete(cacheKey);
      });
      listInflight.set(cacheKey, promise);
      return promise;
    };
    const cached = listCache.get(cacheKey);
    const age = cached ? Date.now() - cached.at : Infinity;
    let sessions;
    if (cached && age < LIST_CACHE_TTL_MS) {
      sessions = cached.sessions;
    } else if (cached && age < LIST_STALE_MAX_MS) {
      sessions = cached.sessions;
      scan().catch((error) => console.warn('[claude-backend] listSessions refresh failed:', error?.message || error));
    } else {
      try {
        sessions = await scan();
      } catch (error) {
        console.warn('[claude-backend] listSessions failed:', error?.message || error);
        return [];
      }
    }

    let result = sessions
      .filter((session) => (rootsOnly ? !session.parentID : true))
      .map(withArchiveState)
      .filter((session) => anyArchiveState || (archivedOnly ? Boolean(session.time?.archived) : !session.time?.archived))
      .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));

    if (limit) result = result.slice(0, limit);
    return result.map(withLiveState);
  };

  /**
   * A subagent as a read-only child session of the session that ran it: its
   * title is what it was asked to do, its time the span of its transcript.
   */
  /**
   * One subagent as a child session. `live` is what `task_started` said (a
   * subagent that just started may have no `.meta.json` yet); `stored` is its
   * `.meta.json`. The status is the live one while this server watched it.
   */
  const subagentSession = ({ parentId, agentId, directory, live = null, stored = null, parent = null }) => {
    const description = live?.description || stored?.description || '';
    const agentType = live?.agentType || stored?.agentType || '';
    return buildSession({
      sessionId: childSessionIdOf(parentId, agentId),
      directory: directory || parent?.directory || '',
      title: description || agentType || 'Subagent',
      createdAt: live?.startedAt ?? parent?.time?.created,
      updatedAt: live?.endedAt ?? live?.startedAt ?? parent?.time?.updated,
      parentId,
      metadata: {
        subagent: {
          agentType,
          toolUseId: live?.toolUseId || stored?.toolUseId || undefined,
          status: live?.status || 'completed',
          ...(live?.startedAt ? { startedAt: live.startedAt } : {}),
          ...(live?.endedAt ? { endedAt: live.endedAt } : {}),
        },
      },
    });
  };

  const getSubagentSession = async ({ parentId, agentId }, directory) => {
    const live = liveSubagents.get(childSessionIdOf(parentId, agentId)) || null;
    const parent = await getSession({ sessionID: parentId, directory }).catch(() => null);
    if (!parent && !live) return null;
    const stored = await sidecar.readSubagent(parentId, parent?.directory || live?.directory, agentId).catch(() => null);
    if (!stored && !live) return null;
    return subagentSession({ parentId, agentId, directory: parent?.directory || live?.directory, live, stored, parent });
  };

  /** The subagents a session ran, as its child sessions. */
  const listSubagentSessions = async (input = {}) => {
    const parentId = typeof input.sessionID === 'string' ? input.sessionID.trim() : '';
    if (!parentId || parseChildSessionId(parentId)) return [];
    const parent = await getSession({ sessionID: parentId, directory: input.directory }).catch(() => null);
    const liveOnes = Array.from(liveSubagents.values()).filter((entry) => entry.parentId === parentId);
    if (!parent && liveOnes.length === 0) return [];
    const { subagents } = parent
      ? await sidecar.read(parentId, parent.directory).catch(() => ({ subagents: new Map() }))
      : { subagents: new Map() };
    const byAgent = new Map();
    for (const stored of subagents.values()) byAgent.set(stored.agentId, { stored, live: null });
    for (const live of liveOnes) byAgent.set(live.agentId, { stored: byAgent.get(live.agentId)?.stored ?? null, live });
    return Array.from(byAgent.entries()).map(([agentId, { stored, live }]) => subagentSession({
      parentId,
      agentId,
      directory: parent?.directory || live?.directory,
      live,
      stored,
      parent,
    }));
  };

  const getSession = async (input = {}) => {
    const sdk = await ensureSdk();
    const sessionId = typeof input.sessionID === 'string' ? input.sessionID.trim() : '';
    if (!sdk || !sessionId) return null;

    const child = parseChildSessionId(sessionId);
    if (child) return getSubagentSession(child, normalizeDirectory(input.directory));

    await loadOverlay();
    const directory = normalizeDirectory(input.directory);

    // An archived session still opens by its id.
    const known = await listSessions({ directory, archived: 'any' }).catch(() => []);
    const hit = known.find((session) => session.id === sessionId);
    if (hit) return hit;

    try {
      const info = await sdk.getSessionInfo?.(sessionId, directory ? { dir: directory } : {});
      if (!info) return null;
      return withLiveState(withArchiveState(await buildSessionFromInfo(info, directory)));
    } catch (error) {
      console.warn('[claude-backend] getSessionInfo failed:', error?.message || error);
      return null;
    }
  };

  const recordJson = (record) => JSON.stringify(record);

  const rememberFollowed = (sessionId, directory, records) => {
    const entry = followed.get(sessionId) || { directory, lastModified: null, sent: new Map() };
    entry.directory = directory;
    entry.readAt = Date.now();
    entry.sent = new Map(records.map((record) => [record.info.id, recordJson(record)]));
    followed.set(sessionId, entry);
  };

  /**
   * Re-read a transcript another process is writing and publish only the
   * records that changed since the last read, as the live stream of an owned
   * session would have. Record ids are stable across reads, so the front end
   * updates in place.
   */
  const refreshFollowed = async (sdk, sessionId, entry) => {
    let info;
    try {
      info = await sdk.getSessionInfo?.(sessionId, entry.directory ? { dir: entry.directory } : {});
    } catch {
      return;
    }
    const lastModified = info?.lastModified ?? null;
    if (lastModified === null || lastModified === entry.lastModified) return;
    const first = entry.lastModified === null;
    entry.lastModified = lastModified;
    if (first && entry.sent.size > 0) return;
    const records = await getMessages({ sessionID: sessionId, directory: entry.directory, internal: true });
    const directory = entry.directory;
    const refreshRow = async () => {
      const session = await buildSessionFromInfo(info, directory);
      if (session) emitSessionUpdate('session.updated', withLiveState(withArchiveState(session)));
    };
    // A follow opened by the live-writer lease below: no view waits on its
    // history, so the first read only seeds the diff base.
    if (first && entry.auto) {
      entry.sent = new Map(records.map((record) => [record.info.id, recordJson(record)]));
      await refreshRow();
      return;
    }
    let flushed = 0;
    for (const record of records) {
      const json = recordJson(record);
      if (entry.sent.get(record.info.id) === json) continue;
      entry.sent.set(record.info.id, json);
      emitRecordEvents(directory, record);
      flushed += 1;
    }
    // The list row (title, time.updated, company flag) moves with the
    // transcript; without this the sidebar keeps the row as it was listed.
    if (flushed > 0) await refreshRow();
  };

  const readOwners = () => liveRegistry.read({ ignoreParentPid: selfPid });

  const pollLiveSessions = async () => {
    if (!liveRegistry) return;
    let owners;
    try {
      owners = await readOwners();
    } catch (error) {
      console.warn('[claude-backend] live session registry unreadable:', error?.message || error);
      return;
    }
    for (const [sessionId, owner] of owners) {
      const proc = processes.get(sessionId);
      if (!proc || proc.hasExited()) continue;
      // Without a parent pid (no /proc) our own process cannot be told apart
      // from a foreign one: it is taken as ours.
      if (!Number.isInteger(owner.ppid)) {
        owners.delete(sessionId);
        continue;
      }
      // Someone resumed a session we hold — typically VS Code reopening it.
      // Two writers corrupt the transcript, and ours is the one we can stop:
      // it yields, and the session is followed from here on.
      console.warn(`[claude-backend] ${sessionId} was resumed by ${owner.entrypoint} (pid ${owner.pid}); closing our process`);
      await closeProcess(sessionId);
      setBusyStatus(sessionId, normalizeDirectory(owner.cwd), { type: owner.status });
    }
    const previous = foreignOwners;
    foreignOwners = owners;

    const changed = new Set([...previous.keys(), ...owners.keys()]);
    for (const sessionId of changed) {
      const before = previous.get(sessionId);
      const after = owners.get(sessionId);
      const statusBefore = before?.status || 'idle';
      const statusAfter = after?.status || 'idle';
      const directory = normalizeDirectory(after?.cwd || before?.cwd || followed.get(sessionId)?.directory);
      if (statusBefore !== statusAfter) setBusyStatus(sessionId, directory, { type: statusAfter });
      if (Boolean(before) !== Boolean(after)) {
        markListStale();
        const session = await getSession({ sessionID: sessionId, directory }).catch(() => null);
        if (session) emitSessionUpdate(before ? 'session.updated' : 'session.created', session);
      }
    }

    const sdk = await ensureSdk();
    if (!sdk) return;
    const now = Date.now();
    // A live foreign writer is its own lease: follow every session another
    // process is writing, whether or not a browser still pings. The front end
    // only pings the session it shows, and a backgrounded tab throttles that
    // ping, so the 15-minute window lapsed and the list froze while VS Code
    // kept writing (30-09).
    for (const [sessionId, owner] of owners) {
      if (processes.has(sessionId)) continue;
      const entry = followed.get(sessionId);
      if (entry) {
        entry.readAt = now;
        continue;
      }
      followed.set(sessionId, {
        directory: normalizeDirectory(owner.cwd),
        lastModified: null,
        sent: new Map(),
        readAt: now,
        auto: true,
      });
    }
    for (const [sessionId, entry] of followed) {
      if (now - entry.readAt > liveFollowWindowMs) {
        followed.delete(sessionId);
        continue;
      }
      // Owned sessions stream live already; only a foreign writer (or one
      // that just exited, for its last lines) needs the transcript followed.
      if (processes.has(sessionId)) continue;
      if (!owners.has(sessionId) && !previous.has(sessionId)) continue;
      await refreshFollowed(sdk, sessionId, entry);
    }
  };

  /**
   * The front end still shows this session: keep following its transcript.
   * Answers whether the lease was dead when it renewed — a follow that lapsed
   * (a sleeping laptop, a throttled tab) starts over, and the caller has to pull
   * the transcript to cover the gap the stream never carried.
   */
  const keepFollowing = async (input = {}) => {
    const sessionId = typeof input.sessionID === 'string' ? input.sessionID.trim() : '';
    if (!sessionId) return { lapsed: false };
    const entry = followed.get(sessionId);
    if (entry) {
      entry.readAt = Date.now();
      return { lapsed: false };
    }
    followed.set(sessionId, {
      directory: normalizeDirectory(input.directory),
      lastModified: null,
      sent: new Map(),
      readAt: Date.now(),
    });
    ensureLivePolling();
    // A new entry means the lease was gone when this window renewed it, so the
    // events of that gap never reached it: republishing them from the transcript
    // takes a poll, and the window has no way to notice. Say so and it pulls.
    return { lapsed: true };
  };

  const ensureLivePolling = () => {
    if (!liveRegistry || livePollTimer || !(livePollMs > 0)) return;
    let running = false;
    livePollTimer = setInterval(() => {
      if (running) return;
      running = true;
      void pollLiveSessions().finally(() => { running = false; });
    }, livePollMs);
    livePollTimer.unref?.();
  };

  const getMessages = async (input = {}) => {
    const sdk = await ensureSdk();
    const sessionId = typeof input.sessionID === 'string' ? input.sessionID.trim() : '';
    if (!sdk || !sessionId) return [];

    const child = parseChildSessionId(sessionId);
    let directory = normalizeDirectory(input.directory);
    if (child && !directory) {
      directory = normalizeDirectory((await getSession({ sessionID: child.parentId }).catch(() => null))?.directory);
    }
    const dirOption = directory ? { dir: directory } : {};
    let messages;
    try {
      messages = child
        ? await sdk.getSubagentMessages(child.parentId, child.agentId, dirOption)
        : await sdk.getSessionMessages(sessionId, dirOption);
    } catch (error) {
      console.warn('[claude-backend] getSessionMessages failed:', error?.message || error);
      return [];
    }

    // What the SDK reader drops: exact edit hunks, the subagent each call started.
    const rootId = child ? child.parentId : sessionId;
    const { toolResults, subagents } = await sidecar
      .read(rootId, directory, { agentId: child?.agentId ?? null })
      .catch(() => ({ toolResults: new Map(), subagents: new Map() }));
    let records = mapClaudeSessionMessages(messages, {
      sessionId,
      providerId: PROVIDER_ID,
      toolResults,
      subagents,
      childSessionId: (agentId) => toPublicId(childSessionIdOf(rootId, agentId)),
      subagent: Boolean(child),
      // Prompts this server sent keep the id their live echo used; the transcript
      // could not have rebuilt it (its ordinal is a position, its seed a uuid).
      promptRecordIdOf: (uuid) => promptRecordIdOf(rootId, uuid),
    });
    if (!input.internal && !child) {
      rememberFollowed(sessionId, directory, records);
      ensureLivePolling();
    }
    if (typeof input.before === 'string' && input.before.trim().length > 0) {
      // By position: an answer's id is its API message id, which does not sort.
      const at = records.findIndex((record) => record.info.id === input.before.trim());
      if (at >= 0) records = records.slice(0, at);
    }
    if (typeof input.limit === 'number' && input.limit > 0) {
      records = records.slice(-input.limit);
    }
    return records;
  };

  /**
   * The transcript uuid each prompt sent from here went out with, keyed by the
   * record id the UI holds it under. Bounded: only recent prompts can still be
   * named by a live id; older ones are read back from the transcript.
   */
  const promptUuids = new Map();
  /**
   * The same pairs the other way round: the transcript uuid of a prompt sent
   * from here back to the record id its live echo used. A transcript read needs
   * it because the id it would build for that prompt (`buildClaudeRecordId`:
   * position in the transcript plus a uuid seed) cannot be known when the
   * prompt goes out, and two ids for one prompt left the UI showing the same
   * question twice (measured 29-09-2026, session b00e8d06).
   */
  const promptRecordIds = new Map();
  const MAX_PROMPT_UUIDS = 500;
  const promptUuidKey = (sessionId, recordId) => `${sessionId}\u0000${recordId}`;
  const promptRecordKey = (sessionId, uuid) => `${sessionId}\u0000${uuid}`;
  const rememberPromptUuid = (sessionId, recordId, uuid) => {
    promptUuids.set(promptUuidKey(sessionId, recordId), uuid);
    promptRecordIds.set(promptRecordKey(sessionId, uuid), recordId);
    while (promptUuids.size > MAX_PROMPT_UUIDS) {
      const oldest = promptUuids.keys().next().value;
      if (oldest === undefined) break;
      const oldestUuid = promptUuids.get(oldest);
      promptUuids.delete(oldest);
      if (oldestUuid) promptRecordIds.delete(oldest.split('\u0000')[0] + '\u0000' + oldestUuid);
    }
  };
  /** What record id a prompt sent from here was echoed under, asked by its transcript uuid. */
  const promptRecordIdOf = (sessionId, uuid) => (
    typeof uuid === 'string' && uuid
      ? promptRecordIds.get(promptRecordKey(sessionId, uuid)) || null
      : null
  );
  const forkTitleOf = (title) => (title ? clampText(`${title} (fork)`, 120) : 'Fork');

  /**
   * A new session, optionally started on a model / thinking level / mode picked
   * for it (the dialog on `+`). What is not picked here is left to
   * `resolveTurnSettings`: OpenChamber's defaults, then Claude Code's own
   * settings. The pick is kept in the overlay, so a session that has not had
   * its first turn yet keeps it across a restart of this server.
   */
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

    const settings = await readSettings();
    const selection = input.selection && typeof input.selection === 'object' ? input.selection : {};
    const picked = {
      model: modelIdOf(selection.model),
      effort: effortIdOf(selection.effort),
      mode: offeredModeIdOf(selection.mode, settings),
    };
    const stored = Object.fromEntries(Object.entries(picked).filter(([, value]) => value));
    if (Object.keys(stored).length > 0) {
      overlay.selections[sessionId] = stored;
      await persistOverlay();
      rememberState(sessionId, stored);
    }

    const session = buildSession({
      sessionId,
      directory,
      title: title || 'New session',
      createdAt: now,
      updatedAt: now,
    });
    const announced = withLiveState(session);
    emitSessionUpdate('session.created', announced);
    return { ...announced };
  };

  /**
   * Fork a session, as OpenCode's `fork({ before })`: a sibling session with the
   * transcript up to, and excluding, the record `before` names — the whole
   * transcript without it. The Agent SDK copies the transcript with fresh
   * uuids; the source is not touched.
   *
   * `before` is a record id as the UI holds it: the transcript's own
   * (`mapClaudeSessionMessages`), or the id a live turn streamed it under —
   * the prompt's client id (resolved through the uuid it was sent with) or
   * `msg_<API message id>` for an answer.
   */
  const forkSession = async (input = {}) => {
    const sdk = await ensureSdk();
    const sessionId = typeof input.sessionID === 'string' ? input.sessionID.trim() : '';
    if (!sdk || !sessionId) throw new Error('Session not found');

    const known = await getSession({ sessionID: sessionId, directory: input.directory }).catch(() => null);
    const directory = normalizeDirectory(input.directory) || normalizeDirectory(known?.directory);
    const dirOption = directory ? { dir: directory } : {};
    const before = typeof input.before === 'string' ? input.before.trim() : '';
    const title = clampText(input.title, 120) || undefined;

    let upToMessageId;
    if (before) {
      const messages = await sdk.getSessionMessages(sessionId, dirOption);
      const cut = findForkCut(messages, before, { uuid: promptUuids.get(promptUuidKey(sessionId, before)) });
      if (!cut.found) throw new ClaudeForkPointNotFoundError(before);
      if (cut.upToMessageId === null) {
        // Nothing precedes the cut: the fork is an empty session where the
        // source runs, which is what a fork before the first prompt holds.
        return createSession({ directory, title: title || forkTitleOf(known?.title) });
      }
      upToMessageId = cut.upToMessageId;
    }

    const result = await sdk.forkSession(sessionId, {
      ...dirOption,
      ...(upToMessageId ? { upToMessageId } : {}),
      ...(title ? { title } : {}),
    });
    const forkedId = typeof result?.sessionId === 'string' ? result.sessionId : '';
    if (!forkedId) throw new Error('Claude did not fork the session');

    const session = await getSession({ sessionID: forkedId, directory });
    if (!session) throw new Error('Forked session could not be read');
    invalidateList();
    // A sibling, not a child: `parentID` means a subagent session to the UI,
    // which nests it under the source instead of listing it.
    emitSessionUpdate('session.created', session);
    return session;
  };

  /**
   * "Rewind code to here": the files Claude changed go back to how they were
   * when the prompt `messageID` was sent (the conversation stays). Needs the
   * session's process — started for it when none runs — and never under a
   * running turn or another process's hold.
   */
  const rewindFiles = async (input = {}) => {
    const sdk = await ensureSdk();
    if (!sdk) throw new Error('Claude backend is not available');
    await loadOverlay();
    const sessionId = typeof input.sessionID === 'string' ? input.sessionID.trim() : '';
    const messageID = typeof input.messageID === 'string' ? input.messageID.trim() : '';
    if (!sessionId || parseChildSessionId(sessionId)) throw new Error('Session not found');
    const owner = await readForeignOwner(sessionId);
    if (owner) throw new ClaudeSessionLiveElsewhereError(owner);
    let proc = processes.get(sessionId);
    if (proc?.isBusy()) throw Object.assign(new Error('Claude is answering in this session; stop it before rewinding'), { code: 'CLAUDE_BUSY' });

    const known = await getSession({ sessionID: sessionId, directory: input.directory }).catch(() => null);
    const directory = normalizeDirectory(input.directory) || normalizeDirectory(known?.directory) || proc?.directory || '';
    const messages = await sdk.getSessionMessages(sessionId, directory ? { dir: directory } : {});
    const uuid = findPromptUuid(messages, messageID, { uuid: promptUuids.get(promptUuidKey(sessionId, messageID)) });
    if (!uuid) throw new ClaudeForkPointNotFoundError(messageID);

    if (!proc) {
      const { permissionMode, effort, model, allowBypass } = await resolveTurnSettings({ sessionID: sessionId });
      proc = await startProcess({ sdk, sessionId, directory, model, effort, permissionMode, allowBypass, title: known?.title });
    }
    const result = await proc.rewindFiles(uuid, { dryRun: input.dryRun === true });
    if (!proc.isBusy()) scheduleIdleClose(sessionId);
    return {
      canRewind: result?.canRewind === true,
      ...(typeof result?.error === 'string' && result.error ? { error: result.error } : {}),
      filesChanged: Array.isArray(result?.filesChanged) ? result.filesChanged.filter((file) => typeof file === 'string') : [],
      insertions: Number.isFinite(result?.insertions) ? result.insertions : 0,
      deletions: Number.isFinite(result?.deletions) ? result.deletions : 0,
      ...(Number.isFinite(result?.skippedLinks) && result.skippedLinks > 0 ? { skippedLinks: result.skippedLinks } : {}),
    };
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

  const remoteControlName = (title) => {
    const label = clampText(title, 80);
    if (label && label !== 'Untitled session' && label !== 'New session') return label;
    // No name at all: the CLI registers under its own title. A placeholder
    // here used to be persisted by the CLI as the transcript's custom title,
    // where it masked the summary the CLI writes after the first turn
    // (measured 29-09-2026: sessions stuck as `OpenChamber · <directory>`).
    return undefined;
  };

  const closeProcess = async (sessionId) => {
    const proc = processes.get(sessionId);
    if (!proc) return null;
    processes.delete(sessionId);
    clearTimeout(idleTimers.get(sessionId));
    idleTimers.delete(sessionId);
    await proc.close();
    return proc;
  };

  /**
   * Wait for a closed process to be gone, bounded. `close()` only asks the CLI
   * to stop; on its way out it still writes its closing stats to the
   * transcript. Deleting before that lands leaves a stub file the next listing
   * shows as an empty session (measured 28-09-2026).
   */
  const EXIT_WAIT_MS = 5_000;
  const waitForExit = async (proc) => {
    if (!proc || typeof proc.exited?.then !== 'function') return;
    let timer;
    await Promise.race([
      proc.exited.catch(() => undefined),
      new Promise((resolve) => {
        timer = setTimeout(resolve, EXIT_WAIT_MS);
        timer.unref?.();
      }),
    ]).finally(() => clearTimeout(timer));
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

  const startProcess = async ({ sdk, sessionId, directory, model, effort, permissionMode, title, reattachSessionId, allowBypass = false }) => {
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
        // Needed at start for Bypass to be reachable later in the session.
        ...(allowBypass ? { allowDangerouslySkipPermissions: true } : {}),
        // Checkpoints before each prompt's edits, as the VS Code extension
        // keeps them: "rewind code to here" (`rewindFiles`).
        enableFileCheckpointing: true,
        // Every tool that needs approval, every question, every plan comes
        // here and waits for the user (claude-requests.js).
        canUseTool: requests.canUseToolFor({
          sessionId,
          directory,
          onModeChange: (permission) => {
            proc.notePermissionMode(permission);
            if (rememberState(sessionId, { mode: modeIdOf(permission) || permission })) void announce(sessionId);
          },
        }),
        settingSources,
        includePartialMessages: true,
        // The SDK stamps `sdk-ts` unless an entrypoint is set, and the VS Code
        // extension hides every sdk-* transcript from its session list.
        env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'cli' },
        // Prompts from another surface (claude.ai) reach the stream only as
        // echoes; this is the flag the VS Code extension runs with too.
        extraArgs: { 'replay-user-messages': null },
        ...(flagSettings ? { settings: flagSettings } : {}),
        ...pathToExecutableOption(executable),
        ...(resume ? { resume: sessionId } : { sessionId }),
      },
      remoteControl: remoteControl?.enabled
        ? { name: remoteControlName(title), reattachSessionId }
        : null,
      emit: (payload) => emitEvent(directory, payload),
      setStatus: (status) => setBusyStatus(sessionId, directory, status),
      childSessionId: (agentId) => toPublicId(childSessionIdOf(sessionId, agentId)),
      childInternalId: (agentId) => childSessionIdOf(sessionId, agentId),
      onSubagentStarted: ({ agentId, toolUseId, description, agentType }) => {
        const childId = childSessionIdOf(sessionId, agentId);
        const live = { parentId: sessionId, agentId, toolUseId, description, agentType, directory, status: 'running', startedAt: Date.now() };
        liveSubagents.set(childId, live);
        emitSessionUpdate('session.created', subagentSession({ parentId: sessionId, agentId, directory, live }));
        setBusyStatus(childId, directory, { type: 'busy' });
      },
      onSubagentEnded: ({ agentId, status }) => {
        const childId = childSessionIdOf(sessionId, agentId);
        const live = liveSubagents.get(childId);
        if (live) Object.assign(live, { status, endedAt: Date.now() });
        setBusyStatus(childId, directory, { type: 'idle' });
        if (live) emitSessionUpdate('session.updated', subagentSession({ parentId: sessionId, agentId, directory, live }));
      },
      onModeReported: (permission) => {
        const modeId = modeIdOf(permission);
        if (modeId && rememberState(sessionId, { mode: modeId })) void announce(sessionId);
      },
      onUsage: (usage) => {
        const patch = {};
        if (Number.isFinite(usage?.cacheTtlMs)) patch.cacheTtlMs = usage.cacheTtlMs;
        if (Number.isFinite(usage?.contextWindow)) patch.contextWindow = usage.contextWindow;
        if (Object.keys(patch).length > 0 && rememberState(sessionId, patch)) void announce(sessionId);
      },
      onRemotePrompt: (text, uuid = null) => {
        const now = Date.now();
        const recordId = `msg_${String(now).padStart(14, '0')}_000000_remote`;
        if (uuid) rememberPromptUuid(sessionId, recordId, uuid);
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
        invalidateList();
        void getSession({ sessionID: sessionId, directory })
          .then((session) => session && emitSessionUpdate('session.updated', session))
          .catch(() => {});
      },
      onTurnEnd: async () => {
        await applyPendingTitle(sdk, sessionId, directory);
        invalidateList();
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
        // A question the process can no longer take an answer to closes.
        requests.withdrawSession(sessionId);
        for (const [childId, live] of liveSubagents) {
          if (live.parentId !== sessionId || live.status !== 'running') continue;
          Object.assign(live, { status: 'stopped', endedAt: Date.now() });
          setBusyStatus(childId, directory, { type: 'idle' });
        }
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

  /** Whether Bypass permissions may be offered (see MODE_DEFINITIONS). */
  const bypassAllowedBy = (settings) => settings?.skipDangerousModePermissionPrompt === true
    || process.env.OPENCHAMBER_CLAUDE_ALLOW_BYPASS === '1';

  /** An effort id this host knows (`low`…`max`), or null. */
  const effortIdOf = (value) => (typeof value === 'string' && EFFORT_OPTIONS.some((option) => option.id === value.trim())
    ? value.trim()
    : null);

  /** A mode id this host offers — Bypass only where it is allowed (see MODE_DEFINITIONS). */
  const offeredModeIdOf = (value, settings) => {
    const id = typeof value === 'string' ? MODE_DEFINITIONS[value.trim()]?.id : null;
    if (!id) return null;
    return MODE_DEFINITIONS[id].dangerous && !bypassAllowedBy(settings) ? null : id;
  };

  /** A model id worth carrying, or null. Claude Code takes aliases (`opus`) and full ids. */
  const modelIdOf = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

  /**
   * OpenChamber's own defaults for a new Claude session (Settings › Defaults),
   * which outrank Claude Code's `~/.claude/settings.json`: the user configures
   * the tool here, not in the CLI's file. An unset key, or a value this host
   * does not offer, is not a default and falls through to the CLI's own.
   */
  const appClaudeDefaults = async (settings) => {
    let stored = null;
    if (typeof readAppSettings === 'function') {
      try {
        stored = await readAppSettings();
      } catch (error) {
        console.warn('[claude-backend] OpenChamber settings unreadable:', error?.message ?? error);
      }
    }
    return {
      model: modelIdOf(stored?.claudeDefaultModel),
      effort: effortIdOf(stored?.claudeDefaultEffort),
      mode: offeredModeIdOf(stored?.claudeDefaultMode, settings),
    };
  };

  /** The model/thinking/mode a session was created with, kept across restarts. */
  const creationPickOf = async (sessionId) => {
    if (!sessionId) return null;
    const stored = (await loadOverlay()).selections?.[sessionId];
    return stored && typeof stored === 'object' ? stored : null;
  };

  /** The mode a session starts in: OpenChamber's default, then the CLI's `permissions.defaultMode`, else Manual. */
  const defaultModeIdOf = (settings, appMode = null) => {
    const fromApp = offeredModeIdOf(appMode, settings);
    if (fromApp) return fromApp;
    const configured = modeIdOf(settings?.permissions?.defaultMode);
    if (!configured) return DEFAULT_MODE_ID;
    if (MODE_DEFINITIONS[configured].dangerous && !bypassAllowedBy(settings)) return DEFAULT_MODE_ID;
    return configured;
  };

  /** The modes this host offers, for the composer's mode menu. */
  const listModes = async () => {
    const settings = await readSettings();
    const allowBypass = bypassAllowedBy(settings);
    const defaultId = defaultModeIdOf(settings, (await appClaudeDefaults(settings)).mode);
    return Object.values(MODE_DEFINITIONS)
      .filter((mode) => !mode.dangerous || allowBypass)
      .map((mode) => ({
        id: mode.id,
        label: mode.label,
        description: mode.description,
        isDefault: mode.id === defaultId,
        ...(mode.dangerous ? { dangerous: true } : {}),
      }));
  };

  /**
   * Put a session in a mode, as the mode indicator does: at once when its
   * process runs (a turn in flight included), else from its next turn.
   */
  const setSessionMode = async (input = {}) => {
    const sessionId = typeof input.sessionID === 'string' ? input.sessionID.trim() : '';
    if (!sessionId) throw new Error('Session not found');
    const mode = MODE_DEFINITIONS[input.mode];
    const settings = await readSettings();
    if (!mode || (mode.dangerous && !bypassAllowedBy(settings))) {
      throw Object.assign(new Error(`Claude Code has no mode "${input.mode}" here`), { code: 'UNKNOWN_MODE' });
    }
    const proc = processes.get(sessionId);
    if (proc) await proc.applyPermissionMode(mode.permissionMode);
    if (rememberState(sessionId, { mode: mode.id })) await announce(sessionId);
    return mode.id;
  };

  /**
   * What a turn runs on. Nearest choice wins: this turn's pick (the composer),
   * then what the session is already on (the live process, the mode the CLI
   * reported), then how it was created, then OpenChamber's defaults, then
   * Claude Code's own settings.
   */
  const resolveTurnSettings = async (input = {}) => {
    const settings = await readSettings();
    const defaults = await appClaudeDefaults(settings);
    const sessionKey = typeof input.sessionID === 'string' ? input.sessionID.trim() : '';
    const live = sessionState.get(sessionKey);
    const created = await creationPickOf(sessionKey);
    // OpenCode's agent never picks the mode — its `plan` agent is not Claude's
    // plan mode — so it is not consulted here.
    const modeId = [input.mode, live?.mode, created?.mode]
      .map((candidate) => offeredModeIdOf(candidate, settings))
      .find((candidate) => candidate)
      ?? defaultModeIdOf(settings, defaults.mode);
    const effort = effortIdOf(input.variant)
      ?? effortIdOf(live?.effort)
      ?? effortIdOf(created?.effort)
      ?? defaults.effort
      ?? effortIdOf(settings?.effortLevel)
      ?? DEFAULT_EFFORT_ID;
    const model = modelIdOf(input.model?.modelID)
      ?? modelIdOf(live?.model)
      ?? modelIdOf(created?.model)
      ?? defaults.model
      ?? modelIdOf(settings?.model)
      ?? undefined;
    return { permissionMode: MODE_DEFINITIONS[modeId].permissionMode, effort, model, allowBypass: bypassAllowedBy(settings) };
  };

  /** The foreign owner of a session, read now rather than from the last poll. */
  const readForeignOwner = async (sessionId) => {
    if (!liveRegistry) return null;
    const owners = await readOwners();
    return owners.get(sessionId) || null;
  };

  /**
   * Close the process that holds a session elsewhere and continue it here,
   * keeping its claude.ai link when it had one. Nothing is prompted: the
   * session is left open and idle for the next message.
   */
  const takeOverSession = async (input = {}) => {
    const sdk = await ensureSdk();
    if (!sdk) throw new Error('Claude backend is not available');
    await loadOverlay();
    const sessionId = typeof input.sessionID === 'string' ? input.sessionID.trim() : '';
    if (!sessionId) throw new Error('Session not found');

    const owner = await readForeignOwner(sessionId);
    const directory = normalizeDirectory(input.directory) || normalizeDirectory(owner?.cwd);
    if (owner) {
      const stopped = await liveRegistry.stop(owner);
      if (!stopped) {
        throw new Error(`The ${owner.entrypoint} process (pid ${owner.pid}) holding this session did not exit`);
      }
      foreignOwners.delete(sessionId);
    }
    if (!processes.get(sessionId)) {
      const existing = await getSession({ sessionID: sessionId, directory }).catch(() => null);
      const { permissionMode, effort, model, allowBypass } = await resolveTurnSettings(input);
      await startProcess({
        sdk,
        sessionId,
        directory,
        model,
        effort,
        permissionMode,
        allowBypass,
        title: existing?.title,
        reattachSessionId: owner?.bridgeSessionId || undefined,
      });
    }
    setBusyStatus(sessionId, directory, { type: 'idle' });
    invalidateList();
    const session = await getSession({ sessionID: sessionId, directory });
    if (session) emitSessionUpdate('session.updated', session);
    return session;
  };

  // Free a transcript this server itself hosts: closes our process so another
  // Claude process can open it. The VS Code extension refuses a transcript a
  // live process holds (single writer), so "Open in VS Code" calls this first.
  // When no process here holds the session there is nothing to release and the
  // caller still opens the link; a foreign holder is left alone.
  const releaseSession = async (input = {}) => {
    const sessionId = typeof input.sessionID === 'string' ? input.sessionID.trim() : '';
    if (!sessionId) return { released: false, busy: false };
    const proc = processes.get(sessionId);
    if (!proc) return { released: true, busy: false };
    if (proc.isBusy()) return { released: false, busy: true };
    await closeProcess(sessionId);
    return { released: true, busy: false };
  };

  const promptAsync = async (input = {}) => {
    const sdk = await ensureSdk();
    if (!sdk) throw new Error('Claude backend is not available');
    await loadOverlay();

    const sessionId = typeof input.sessionID === 'string' ? input.sessionID.trim() : '';
    if (!sessionId) throw new Error('Session not found');
    const live = processes.get(sessionId);

    const directory = normalizeDirectory(input.directory) || live?.directory || '';
    const { permissionMode, effort, model, allowBypass } = await resolveTurnSettings(input);

    const { blocks, unsupported } = buildPrompt(input.parts);
    if (blocks.length === 0) {
      throw new Error('Cannot start a turn with empty input — the message had no text or attachment');
    }
    if (unsupported.length > 0) {
      console.warn(`[claude-backend] ${unsupported.length} attachment(s) could not be sent for ${sessionId}`);
    }

    // One writer per transcript: a session open in another process is never
    // resumed underneath it. Linked to claude.ai, the message goes to that
    // process through its bridge, which runs the turn; otherwise it has to be
    // taken over first.
    if (!live) {
      const owner = await readForeignOwner(sessionId);
      if (owner) {
        if (!remoteAttach || !owner.bridgeSessionId) throw new ClaudeSessionLiveElsewhereError(owner);
        // Follow the transcript so the owner's answer streams here.
        if (!followed.has(sessionId)) await getMessages({ sessionID: sessionId, directory: directory || owner.cwd });
        // Only a model picked in the composer: the owner keeps its own otherwise.
        const pickedModel = typeof input.model?.modelID === 'string' ? input.model.modelID.trim() : '';
        if (pickedModel) await remoteAttach.setModel(owner.bridgeSessionId, pickedModel);
        await remoteAttach.send(owner.bridgeSessionId, blocks);
        input.onStarted?.();
        return;
      }
    }

    // Effort is fixed when the CLI starts; a different one needs a new
    // process — but never under a running turn, whose prompt then keeps the
    // process it has.
    if (live && !live.isBusy() && live.effort !== effort) await closeProcess(sessionId);
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
        allowBypass,
        title: overlay.pendingTitles[sessionId] || existing?.title,
      });
    } else if (!proc.isBusy()) {
      await proc.applyModel(model);
      await proc.applyPermissionMode(permissionMode);
    }
    clearTimeout(idleTimers.get(sessionId));

    const now = Date.now();
    // The client names its prompt so the echo replaces its optimistic copy;
    // info and parts carry the same id or the parts belong to no message.
    const userRecordId = typeof input.messageID === 'string' && input.messageID.trim()
      ? input.messageID.trim()
      : `msg_${String(now).padStart(14, '0')}_000000_local`;
    emitRecordEvents(directory, {
      info: {
        id: userRecordId,
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

    const promptUuid = createSessionId(crypto);
    rememberPromptUuid(sessionId, userRecordId, promptUuid);
    const turnDone = proc.send(blocks, { uuid: promptUuid, asCommand: input.asCommand === true });
    // The turn is accepted from here on: every later failure is reported as a
    // `session.error` event, so an HTTP caller can be answered now instead of
    // being held open for the whole turn.
    input.onStarted?.();
    return turnDone;
  };

  /**
   * Slash commands for sessions in `directory`, as the Claude CLI reports them.
   * Only a running CLI can say, so the list comes from a live process here
   * (preferring one in that directory) and is kept per directory for when none
   * runs. Empty until a Claude session has run once: typing `/name` still
   * reaches Claude Code, which answers unknown commands itself.
   */
  const commandCache = new Map();
  const COMMANDS_TIMEOUT_MS = 5_000;
  const listCommands = async (input = {}) => {
    const directory = normalizeDirectory(input.directory);
    // Only a CLI running where the session runs can answer for it: another
    // project's commands (its .claude/commands) are not this one's.
    const proc = [...processes.values()].find((candidate) => !candidate.hasExited()
      && (candidate.directory || '') === directory);
    if (proc) {
      try {
        let timer;
        const commands = await Promise.race([
          proc.supportedCommands(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('timed out')), COMMANDS_TIMEOUT_MS);
            timer.unref?.();
          }),
        ]).finally(() => clearTimeout(timer));
        const normalized = commands
          .filter((command) => typeof command?.name === 'string' && command.name.trim())
          .map((command) => ({
            name: command.name.trim().replace(/^\//, ''),
            description: typeof command.description === 'string' ? command.description : '',
            argumentHint: typeof command.argumentHint === 'string' ? command.argumentHint : '',
          }));
        commandCache.set(directory, normalized);
        return normalized;
      } catch (error) {
        console.warn('[claude-backend] supportedCommands failed:', error?.message || error);
      }
    }
    return commandCache.get(directory) || [];
  };

  const abortSession = async (input = {}) => {
    const sessionId = typeof input.sessionID === 'string' ? input.sessionID.trim() : '';
    // A subagent stops alone; the session that ran it goes on.
    const child = parseChildSessionId(sessionId);
    if (child) {
      const parentProc = processes.get(child.parentId);
      return parentProc ? parentProc.stopTask(child.agentId) : false;
    }
    const proc = processes.get(sessionId);
    if (proc) {
      await proc.interrupt();
      requests.withdrawSession(sessionId);
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
      delete overlay.kept[sessionId];
      await persistOverlay();
    } else if (input?.time && 'archived' in input.time && !input.time.archived) {
      delete overlay.archived[sessionId];
      // Unarchived by hand: automatic archiving counts from now, not from the
      // transcript's last write.
      overlay.kept[sessionId] = Date.now();
      await persistOverlay();
    }

    const next = buildSession({
      sessionId,
      directory: directory || current?.directory || '',
      title: requestedTitle || current?.title || 'Untitled session',
      createdAt: current?.time?.created ?? Date.now(),
      updatedAt: Date.now(),
    });
    const nextArchivedAt = archivedAtOf(next);
    if (nextArchivedAt) {
      next.time.archived = nextArchivedAt;
    }
    emitSessionUpdate('session.updated', next);
    return { ...next };
  };

  const deleteSession = async (input = {}) => {
    const sdk = await ensureSdk();
    const sessionId = typeof input.sessionID === 'string' ? input.sessionID.trim() : '';
    if (!sessionId) return false;

    await waitForExit(await closeProcess(sessionId));

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
    const hadOverlay = Boolean(overlay.archived[sessionId] || overlay.pendingTitles[sessionId]
      || overlay.kept[sessionId] || overlay.selections[sessionId]);
    delete overlay.archived[sessionId];
    delete overlay.pendingTitles[sessionId];
    delete overlay.kept[sessionId];
    delete overlay.selections[sessionId];
    if (hadOverlay) await persistOverlay();
    invalidateList();

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
    for (const [sessionId, owner] of foreignOwners) {
      if (owner.status !== 'busy') continue;
      if (directory && normalizeDirectory(owner.cwd) !== directory) continue;
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
    const defaults = await appClaudeDefaults(settings);
    // The defaults the composer and the new-session dialog open on: what the
    // user set in OpenChamber first, Claude Code's own settings otherwise.
    const defaultModelId = modelIdOf(defaults.model) ?? modelIdOf(settings?.model) ?? models[0]?.id;
    const defaultEffort = effortIdOf(defaults.effort) ?? effortIdOf(settings?.effortLevel) ?? DEFAULT_EFFORT_ID;

    const interactionModes = await listModes();

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
    clearInterval(livePollTimer);
    livePollTimer = null;
    remoteAttach?.closeAll();
    await Promise.all(Array.from(processes.keys()).map((sessionId) => closeProcess(sessionId)));
  };

  // Kick availability detection off at construction so the sync
  // `isAvailable()` used by the startup pipeline has an answer.
  void ensureSdk();

  return {
    ensureAvailable,
    isAvailable,
    resolveExecutable,
    listSessions,
    createSession,
    forkSession,
    listCommands,
    getSession,
    listSubagentSessions,
    getMessages,
    promptAsync,
    takeOverSession,
    releaseSession,
    keepFollowing,
    abortSession,
    updateSession,
    deleteSession,
    getStatusSnapshot,
    addEventClient,
    getControlSurface,
    listModes,
    setSessionMode,
    rewindFiles,
    requests,
    shutdownAll,
  };
};

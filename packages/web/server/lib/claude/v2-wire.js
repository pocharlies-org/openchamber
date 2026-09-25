/**
 * Claude Code sessions in OpenCode 2's wire shapes.
 *
 * The Claude runtime (runtime.js, session-process.js) still thinks in
 * OpenCode 1 records — a message is `{ info, parts }` and a turn streams as
 * `message.updated` / `message.part.updated` / `message.part.delta`. The UI no
 * longer reads those: it lists sessions and messages through the OpenCode 2 SDK
 * and reduces OpenCode 2's durable event log (`session.step.started`,
 * `session.text.delta`, `session.tool.called`, ...). This module is the one
 * place that crosses that boundary, so the runtime keeps its own vocabulary and
 * the UI sees a Claude session exactly as it sees an OpenCode one.
 *
 * Part identity is the UI's: text and reasoning are addressed by
 * `(assistantMessageID, ordinal)` and tools by call id (`partIds` in
 * packages/ui/src/lib/opencode/model.ts). A page read over HTTP and the live
 * stream therefore agree only if both count ordinals the same way — per kind,
 * in content order — which is what `toV2Message` and the translator do.
 */

const ZERO_TOKENS = Object.freeze({ input: 0, output: 0, reasoning: 0, cache: Object.freeze({ read: 0, write: 0 }) });

/** The agent and model a Claude session reports; the composer never runs them itself. */
export const CLAUDE_AGENT = 'claude';

const toMillis = (value, fallback = Date.now()) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
};

const tokensOf = (value) => {
  if (!value || typeof value !== 'object') return { ...ZERO_TOKENS, cache: { ...ZERO_TOKENS.cache } };
  const count = (n) => (Number.isFinite(n) && n > 0 ? n : 0);
  return {
    input: count(value.input),
    output: count(value.output),
    reasoning: count(value.reasoning),
    cache: { read: count(value.cache?.read), write: count(value.cache?.write) },
  };
};

const withoutUndefined = (object) => {
  const result = {};
  for (const [key, value] of Object.entries(object)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
};

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * `Session.Info` for a runtime session whose `id` is already public.
 *
 * The sidebar groups a session under the project whose directory it names, so
 * a transcript written in a subdirectory of a registered project is presented
 * at that project's root with the rest as `subpath` — OpenCode 2's own way of
 * saying the same thing. The real working directory stays in
 * `metadata.claude.directory`.
 */
export const toV2Session = (session, resolveProject = null) => {
  const cwd = typeof session.directory === 'string' ? session.directory : '';
  const project = resolveProject ? resolveProject(cwd) : null;
  const directory = project?.worktree ?? cwd;
  const subpath = project && cwd.length > project.worktree.length ? cwd.slice(project.worktree.length + 1) : undefined;
  const created = toMillis(session.time?.created);
  const time = { created, updated: toMillis(session.time?.updated, created) };
  if (typeof session.time?.archived === 'number') time.archived = session.time.archived;
  return withoutUndefined({
    id: session.id,
    parentID: typeof session.parentID === 'string' && session.parentID ? session.parentID : undefined,
    projectID: project?.id ?? 'global',
    location: { directory },
    subpath: subpath || undefined,
    title: session.title || 'Untitled session',
    agent: CLAUDE_AGENT,
    model: { providerID: 'anthropic', id: 'claude' },
    cost: 0,
    tokens: tokensOf(null),
    time,
    metadata: {
      backend: 'claude',
      claude: { directory: cwd },
      ...(session.metadata && typeof session.metadata === 'object' ? session.metadata : {}),
    },
  });
};

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

const toolText = (output) => [{ type: 'text', text: typeof output === 'string' ? output : '' }];

/** One runtime tool part as an assistant `tool` content item. */
const toV2ToolItem = (part, fallbackTime) => {
  const state = part.state && typeof part.state === 'object' ? part.state : {};
  const input = state.input && typeof state.input === 'object' ? state.input : {};
  const created = toMillis(state.time?.start, fallbackTime);
  const time = { created, ran: created };
  let v2State;
  switch (state.status) {
    case 'completed':
      v2State = { status: 'completed', input, content: toolText(state.output) };
      time.completed = toMillis(state.time?.end, created);
      break;
    case 'error':
      v2State = withoutUndefined({
        status: 'error',
        input,
        error: { type: 'ToolError', message: state.error || 'Tool call failed' },
        content: typeof state.output === 'string' && state.output.length > 0 ? toolText(state.output) : undefined,
      });
      time.completed = toMillis(state.time?.end, created);
      break;
    case 'pending':
      v2State = { status: 'streaming', input: '' };
      delete time.ran;
      break;
    default:
      v2State = { status: 'running', input, metadata: {} };
  }
  return {
    type: 'tool',
    id: part.callID || part.id,
    name: part.tool || 'tool',
    executed: true,
    state: v2State,
    time,
  };
};

/** A runtime file part as a prompt attachment the UI can show. */
const toV2File = (part) => withoutUndefined({
  mime: part.mime || 'application/octet-stream',
  name: typeof part.filename === 'string' ? part.filename : undefined,
  source: { type: 'uri', uri: part.url || '' },
});

/**
 * `Session.Message.Info` for one runtime record `{ info, parts }`. Ordinals of
 * text and reasoning count per kind in content order, as the UI projects them.
 */
export const toV2Message = (record) => {
  const info = record?.info || {};
  const parts = Array.isArray(record?.parts) ? record.parts : [];
  const created = toMillis(info.time?.created);
  if (info.role === 'user') {
    const files = parts.filter((part) => part?.type === 'file').map(toV2File);
    return withoutUndefined({
      type: 'user',
      id: info.id,
      time: { created },
      text: parts.filter((part) => part?.type === 'text').map((part) => part.text || '').join('\n'),
      files: files.length > 0 ? files : undefined,
    });
  }
  const content = [];
  for (const part of parts) {
    if (part?.type === 'text') content.push({ type: 'text', text: part.text || '' });
    else if (part?.type === 'reasoning') content.push({ type: 'reasoning', text: part.text || '' });
    else if (part?.type === 'tool') content.push(toV2ToolItem(part, created));
  }
  const completed = info.time?.completed !== undefined ? toMillis(info.time.completed, created) : undefined;
  return withoutUndefined({
    type: 'assistant',
    id: info.id,
    time: withoutUndefined({ created, completed }),
    agent: CLAUDE_AGENT,
    model: { providerID: info.providerID || info.model?.providerID || 'claude', id: info.modelID || info.model?.modelID || '' },
    content,
    finish: completed !== undefined ? (info.finish || 'stop') : undefined,
    cost: 0,
    tokens: tokensOf(info.tokens),
  });
};

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

const encodeCursor = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

const decodeCursor = (cursor) => {
  try {
    const value = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    return value && typeof value === 'object' && Number.isInteger(value.offset) && value.offset >= 0 ? value : null;
  } catch {
    return null;
  }
};

/**
 * One page of `items` (oldest first) the way `session.message.list` answers:
 * `order` applies to the first page and the cursor carries it afterwards, since
 * the SDK sends `cursor` without `order`. Returns `null` for a cursor that is
 * not ours, which the route answers as a 400 like OpenCode does.
 */
export const pageOf = (items, { limit, order, cursor } = {}) => {
  let offset = 0;
  let direction = order === 'asc' ? 'asc' : 'desc';
  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (!decoded) return null;
    offset = decoded.offset;
    direction = decoded.order === 'asc' ? 'asc' : 'desc';
  }
  const ordered = direction === 'asc' ? items : [...items].reverse();
  const size = Number.isInteger(limit) && limit > 0 ? limit : ordered.length;
  const data = ordered.slice(offset, offset + size);
  const next = offset + data.length < ordered.length ? encodeCursor({ offset: offset + data.length, order: direction }) : null;
  const previous = offset > 0 ? encodeCursor({ offset: Math.max(0, offset - size), order: direction }) : null;
  return { data, cursor: { previous, next } };
};

// ---------------------------------------------------------------------------
// Live events
// ---------------------------------------------------------------------------

const TEXT_KINDS = new Set(['text', 'reasoning']);

/**
 * Turns the runtime's OpenCode 1 events into OpenCode 2 wire events.
 *
 * Stateful: OpenCode 2 streams text as `started` / `delta` / `ended` per
 * ordinal and tool calls as transitions of a part the UI already holds, while
 * the runtime republishes whole parts. The translator remembers what each
 * message has shown so a full part becomes the delta it adds, a tool it has not
 * announced is announced first, and a user record — published as the info and
 * then its parts in one synchronous burst — becomes a single inbox event once
 * the burst is over.
 *
 * @param {object} deps
 * @param {(event: object) => void} deps.publish receives each wire event
 * @param {(sessionId: string) => string} deps.toPublicId runtime id → public session id
 * @param {(session: object) => object} deps.toSession runtime session → `Session.Info`
 * @param {() => string} deps.createEventId
 * @param {() => number} [deps.now]
 * @param {(fn: () => void) => void} [deps.schedule] runs after the current burst
 * @param {number} [deps.maxTrackedMessages]
 */
export const createClaudeV2EventTranslator = ({
  publish,
  toPublicId,
  toSession,
  createEventId,
  now = Date.now,
  schedule = queueMicrotask,
  maxTrackedMessages = 1000,
}) => {
  /** Map<messageID, MessageState>, insertion-ordered for eviction. */
  const messages = new Map();
  /** Map<messageID, { sessionID, info, parts, directory }> user records still collecting parts. */
  const pendingUsers = new Map();

  const emit = (type, directory, data) => {
    publish(withoutUndefined({
      id: createEventId(),
      type,
      created: now(),
      location: directory ? { directory } : undefined,
      data: withoutUndefined(data),
    }));
  };

  const track = (messageID, init) => {
    let state = messages.get(messageID);
    if (!state) {
      state = { text: new Map(), reasoning: new Map(), tools: new Map(), started: false, ended: false, ...init };
      messages.set(messageID, state);
      while (messages.size > maxTrackedMessages) messages.delete(messages.keys().next().value);
    }
    return state;
  };

  const startStep = (messageID, state, info) => {
    if (state.started) return;
    state.started = true;
    emit('session.step.started', state.directory, {
      sessionID: state.sessionID,
      assistantMessageID: messageID,
      agent: CLAUDE_AGENT,
      model: {
        providerID: info?.providerID || info?.model?.providerID || 'claude',
        id: info?.modelID || info?.model?.modelID || '',
      },
      started: toMillis(info?.time?.created, now()),
    });
  };

  const endStep = (messageID, state, finish = 'stop') => {
    if (!state.started || state.ended) return;
    for (const kind of TEXT_KINDS) {
      for (const entry of state[kind].values()) {
        if (entry.ended) continue;
        entry.ended = true;
        emit(`session.${kind}.ended`, state.directory, {
          sessionID: state.sessionID,
          assistantMessageID: messageID,
          ordinal: entry.ordinal,
          text: entry.text,
        });
      }
    }
    state.ended = true;
    emit('session.step.ended', state.directory, {
      sessionID: state.sessionID,
      assistantMessageID: messageID,
      finish,
      cost: 0,
      tokens: tokensOf(state.tokens),
    });
  };

  /** Everything still open in a session closes when its turn does. */
  const endSession = (sessionID, finish) => {
    for (const [messageID, state] of messages) {
      if (state.sessionID === sessionID) endStep(messageID, state, finish);
    }
  };

  const textPart = (messageID, state, part) => {
    const kind = part.type;
    let entry = state[kind].get(part.id);
    if (!entry) {
      entry = { ordinal: state[kind].size, text: '', ended: false };
      state[kind].set(part.id, entry);
      emit(`session.${kind}.started`, state.directory, {
        sessionID: state.sessionID,
        assistantMessageID: messageID,
        ordinal: entry.ordinal,
      });
    }
    const text = typeof part.text === 'string' ? part.text : '';
    if (text === entry.text) return;
    if (text.startsWith(entry.text) && !entry.ended) {
      const delta = text.slice(entry.text.length);
      entry.text = text;
      emit(`session.${kind}.delta`, state.directory, {
        sessionID: state.sessionID,
        assistantMessageID: messageID,
        ordinal: entry.ordinal,
        delta,
      });
      return;
    }
    // Not a continuation (a settled block, a transcript re-read): the full
    // text replaces what the UI holds.
    entry.text = text;
    emit(`session.${kind}.ended`, state.directory, {
      sessionID: state.sessionID,
      assistantMessageID: messageID,
      ordinal: entry.ordinal,
      text,
    });
  };

  const toolPart = (messageID, state, part) => {
    const id = part.callID || part.id;
    const status = part.state?.status;
    let tool = state.tools.get(id);
    if (!tool) {
      tool = { status: 'pending' };
      state.tools.set(id, tool);
      emit('session.tool.input.started', state.directory, {
        sessionID: state.sessionID,
        assistantMessageID: messageID,
        id,
        name: part.tool || 'tool',
      });
    }
    const base = { sessionID: state.sessionID, assistantMessageID: messageID, id };
    if (status !== 'pending' && tool.status === 'pending') {
      tool.status = 'running';
      emit('session.tool.called', state.directory, {
        ...base,
        input: part.state?.input && typeof part.state.input === 'object' ? part.state.input : {},
        executed: true,
      });
    }
    if (status === 'completed' && tool.status === 'running') {
      tool.status = 'completed';
      emit('session.tool.success', state.directory, { ...base, content: toolText(part.state.output), executed: true });
    } else if (status === 'error' && tool.status === 'running') {
      tool.status = 'error';
      const output = part.state?.output;
      emit('session.tool.failed', state.directory, {
        ...base,
        error: { type: 'ToolError', message: part.state?.error || 'Tool call failed' },
        content: typeof output === 'string' && output.length > 0 ? toolText(output) : undefined,
        executed: true,
      });
    }
  };

  const flushUser = (messageID) => {
    const pending = pendingUsers.get(messageID);
    if (!pending) return;
    pendingUsers.delete(messageID);
    const message = toV2Message({ info: pending.info, parts: pending.parts });
    track(messageID, { sessionID: pending.sessionID, directory: pending.directory, role: 'user', started: true, ended: true });
    emit('session.inbox.enqueued', pending.directory, {
      sessionID: pending.sessionID,
      inboxID: messageID,
      item: {
        type: 'user',
        payload: withoutUndefined({ text: message.text, files: message.files }),
        delivery: 'queue',
      },
    });
    emit('session.inbox.delivered', pending.directory, { sessionID: pending.sessionID, inboxID: messageID });
  };

  const onMessageUpdated = (info, directory) => {
    if (!info || typeof info.id !== 'string') return;
    const sessionID = toPublicId(info.sessionID);
    if (info.role === 'user') {
      if (messages.has(info.id) || pendingUsers.has(info.id)) return;
      pendingUsers.set(info.id, { sessionID, info, parts: [], directory });
      schedule(() => flushUser(info.id));
      return;
    }
    const state = track(info.id, { sessionID, directory, role: 'assistant' });
    if (info.tokens) state.tokens = info.tokens;
    startStep(info.id, state, info);
    // A record read back from a transcript is already finished: its parts
    // follow in the same burst, and the step closes after them.
    if (info.time?.completed !== undefined && !state.ended) {
      schedule(() => endStep(info.id, state, info.finish || 'stop'));
    }
  };

  const onPartUpdated = (part, directory) => {
    if (!part || typeof part.messageID !== 'string') return;
    const pending = pendingUsers.get(part.messageID);
    if (pending) {
      pending.parts.push(part);
      return;
    }
    let state = messages.get(part.messageID);
    if (!state) {
      state = track(part.messageID, { sessionID: toPublicId(part.sessionID), directory, role: 'assistant' });
      startStep(part.messageID, state, null);
    }
    if (state.role !== 'assistant') return;
    if (TEXT_KINDS.has(part.type)) textPart(part.messageID, state, part);
    else if (part.type === 'tool') toolPart(part.messageID, state, part);
  };

  const onPartDelta = (properties) => {
    const state = messages.get(properties.messageID);
    if (!state || typeof properties.delta !== 'string' || properties.delta.length === 0) return;
    for (const kind of TEXT_KINDS) {
      const entry = state[kind].get(properties.partID);
      if (!entry) continue;
      entry.text += properties.delta;
      emit(`session.${kind}.delta`, state.directory, {
        sessionID: state.sessionID,
        assistantMessageID: properties.messageID,
        ordinal: entry.ordinal,
        delta: properties.delta,
      });
      return;
    }
  };

  const translate = (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const properties = payload.properties && typeof payload.properties === 'object' ? payload.properties : {};
    const directory = typeof properties.directory === 'string' && properties.directory
      ? properties.directory
      : (typeof payload.directory === 'string' && payload.directory !== 'global' ? payload.directory : undefined);
    switch (payload.type) {
      case 'message.updated':
        onMessageUpdated(properties.info, directory);
        return;
      case 'message.part.updated':
        onPartUpdated(properties.part, directory);
        return;
      case 'message.part.delta':
        onPartDelta(properties);
        return;
      case 'session.status': {
        const sessionID = toPublicId(properties.sessionID);
        const type = properties.status?.type === 'busy' ? 'busy' : properties.status?.type === 'retry' ? 'retry' : 'idle';
        if (type === 'idle') endSession(sessionID, 'stop');
        emit('session.status', directory, {
          sessionID,
          status: type === 'retry' ? { ...properties.status } : { type },
        });
        return;
      }
      case 'session.idle': {
        const sessionID = toPublicId(properties.sessionID);
        endSession(sessionID, 'stop');
        emit('session.idle', directory, { sessionID });
        return;
      }
      case 'session.error': {
        const sessionID = toPublicId(properties.sessionID);
        endSession(sessionID, 'error');
        emit('session.execution.failed', directory, {
          sessionID,
          error: { type: 'ClaudeError', message: properties.error?.message || 'Claude run failed' },
        });
        return;
      }
      case 'session.created': {
        const session = toSession(properties.info);
        emit('session.created', session.location.directory, {
          sessionID: session.id,
          projectID: session.projectID,
          location: session.location,
          subpath: session.subpath,
          parentID: session.parentID,
          slug: `claude-${session.id.slice(-8)}`,
          title: session.title,
          agent: session.agent,
          model: session.model,
          metadata: session.metadata,
          version: '2',
        });
        return;
      }
      case 'session.updated': {
        const session = toSession(properties.info);
        emit('session.renamed', session.location.directory, { sessionID: session.id, title: session.title });
        emit('session.metadata.updated', session.location.directory, { sessionID: session.id, metadata: session.metadata });
        return;
      }
      case 'session.deleted': {
        const id = properties.info?.id ?? properties.sessionID;
        if (typeof id === 'string') emit('session.deleted', directory, { sessionID: toPublicId(id) });
        return;
      }
      default:
    }
  };

  return { translate };
};

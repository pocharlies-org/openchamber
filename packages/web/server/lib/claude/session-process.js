/**
 * One live Claude Code process per session.
 *
 * The CLI is driven the way the VS Code extension drives it: the prompt is a
 * stream that stays open, so the process — and with it the session's Remote
 * Control link to claude.ai and the Claude app — survives between turns. A
 * process per turn would drop that link the moment each turn ended.
 *
 * Because the process outlives a turn, turns are no longer delimited by the
 * caller. A turn starts when OpenChamber sends a prompt or when the process
 * starts answering one that arrived from elsewhere (typed on claude.ai), and
 * ends with the CLI's `result` message. Only one process ever writes a
 * session's transcript; every surface is a client of that process.
 */

import { toolResultText } from './claude-transcript.js';

// Stream deltas that grow a part live, keyed by the Anthropic delta type.
const STREAM_DELTA_KINDS = Object.freeze({
  text_delta: { partType: 'text', field: 'text' },
  thinking_delta: { partType: 'reasoning', field: 'thinking' },
});

/** An async iterable the CLI reads prompts from; it ends only on `end()`. */
const createPromptStream = () => {
  const queued = [];
  const waiting = [];
  let ended = false;
  return {
    push(message) {
      if (ended) return;
      const next = waiting.shift();
      if (next) next({ value: message, done: false });
      else queued.push(message);
    },
    end() {
      ended = true;
      for (const next of waiting.splice(0)) next({ value: undefined, done: true });
    },
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          if (queued.length > 0) return Promise.resolve({ value: queued.shift(), done: false });
          if (ended) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => waiting.push(resolve));
        },
        return: () => {
          ended = true;
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
};

const humanText = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
};

import { cacheTtlOf } from './claude-transcript.js';
import { isSubagentTool, toV2Tool } from './claude-tools.js';

/**
 * The content of a prompt as the CLI receives it. A command (`/name args`,
 * sent through the command route) goes as one plain string: that is the shape
 * in which Claude Code parses a slash command. Everything else keeps its
 * blocks, which the CLI reads as prose even when the text starts with `/` —
 * `/usr/local/bin/node --version` in a prompt is a question, not a command.
 */
export const toCliContent = (content, { asCommand = false } = {}) => {
  if (!asCommand || !Array.isArray(content)) return content;
  const texts = content.filter((block) => block?.type === 'text' && typeof block.text === 'string');
  return texts.length === content.length ? texts.map((block) => block.text).join('\n\n') : content;
};

/**
 * @param {object} dependencies
 * @param {object} dependencies.sdk Agent SDK module (`query`)
 * @param {string} dependencies.sessionId
 * @param {string} dependencies.directory
 * @param {object} dependencies.options SDK query options, minus `prompt`
 * @param {string} [dependencies.model] model the process was started with
 * @param {{ name?: string, reattachSessionId?: string } | null} [dependencies.remoteControl]
 *   enable Remote Control under this name, reattaching an existing remote session when given
 * @param {(payload: object) => void} dependencies.emit directory-scoped event emitter
 * @param {(status: object) => void} dependencies.setStatus busy/idle publisher
 * @param {(text: string, uuid?: string | null) => void} dependencies.onRemotePrompt a prompt typed on another surface, with its transcript uuid
 * @param {(info: { url: string, bridgeSessionId: string }) => void} [dependencies.onRemoteControl]
 * @param {() => Promise<void>} [dependencies.onTurnEnd]
 * @param {() => void} [dependencies.onExit]
 * @param {() => string} dependencies.createUuid
 * @param {(agentId: string) => string} [dependencies.childSessionId] public id of a subagent's child session
 * @param {(agentId: string) => string} [dependencies.childInternalId] the engine's id of that child session (its events' sessionID)
 * @param {(subagent: { agentId: string, toolUseId: string, description: string, agentType: string }) => void} [dependencies.onSubagentStarted]
 * @param {(subagent: { agentId: string, status: string }) => void} [dependencies.onSubagentEnded]
 * @param {(usage: { cacheTtlMs?: number, contextWindow?: number }) => void} [dependencies.onUsage]
 * @param {(permissionMode: string) => void} [dependencies.onModeReported] the CLI switched its own mode (`/plan`, a plan approval)
 */
export const createClaudeSessionProcess = (dependencies) => {
  const {
    sdk,
    sessionId,
    directory,
    options,
    remoteControl = null,
    emit,
    setStatus,
    onRemotePrompt,
    onRemoteControl,
    onTurnEnd,
    onExit,
    createUuid,
    childSessionId = () => null,
    childInternalId = (agentId) => `${sessionId}~${agentId}`,
    onSubagentStarted,
    onSubagentEnded,
    onUsage,
    onModeReported,
  } = dependencies;

  const prompts = createPromptStream();
  const sentUuids = new Set();
  /** Prompts sent while a turn ran, keyed by uuid, until the CLI takes them. */
  const queued = new Map();
  let model = dependencies.model;
  let permissionMode = options.permissionMode;
  let turn = null;
  let exited = false;
  let lastActivityAt = Date.now();
  let remoteControlInfo = null;

  const query = sdk.query({ prompt: prompts, options });

  /**
   * One session's view of the CLI's output: the parent session's, or a
   * subagent's child session's. Each keeps its own open parts, tool calls and
   * usage, keyed by the API message ids the CLI streams.
   */
  const createStream = (streamSessionId, { main = false } = {}) => ({
    sessionId: streamSessionId,
    main,
    // One OpenChamber message per Claude API message id; the CLI emits
    // several API messages per turn (one per tool round).
    streamingParts: new Map(),
    settledPartIds: new Set(),
    // Tool calls stay open until the CLI hands back their `tool_result`.
    toolParts: new Map(),
    currentApiMessageId: null,
    // Token usage per API message, published as it arrives so the answer's
    // step ends with it (the UI's context meter and cache readouts).
    usage: new Map(),
  });

  const beginTurn = (pending = null) => {
    turn = {
      pending,
      // Prompts the CLI folded into this turn while it ran; they end with it.
      folded: [],
      main: createStream(sessionId, { main: true }),
      // Subagent call id → agent id, from `task_started`.
      subagents: new Map(),
      // Agent id → the stream of its child session.
      children: new Map(),
    };
    lastActivityAt = Date.now();
    setStatus({ type: 'busy' });
    return turn;
  };

  const endTurn = async ({ error } = {}) => {
    const finished = turn;
    if (!finished) return;
    turn = null;
    lastActivityAt = Date.now();
    setStatus({ type: 'idle' });
    try {
      await onTurnEnd?.();
    } catch (hookError) {
      console.warn(`[claude-backend] turn-end hook failed for ${sessionId}:`, hookError?.message || hookError);
    }
    for (const waiter of [finished.pending, ...finished.folded]) {
      if (!waiter) continue;
      if (error) waiter.reject(error);
      else waiter.resolve({ ok: true });
    }
  };

  const assistantInfo = (stream, messageId) => ({
    id: messageId,
    sessionID: stream.sessionId,
    role: 'assistant',
    model: { providerID: 'claude', modelID: model || '' },
    providerID: 'claude',
    modelID: model || '',
    time: { created: new Date().toISOString() },
  });

  const tokensFrom = (usage) => {
    const count = (value) => (Number.isFinite(value) && value > 0 ? value : 0);
    return {
      input: count(usage?.input_tokens),
      output: count(usage?.output_tokens),
      reasoning: 0,
      cache: { read: count(usage?.cache_read_input_tokens), write: count(usage?.cache_creation_input_tokens) },
    };
  };

  /** Record an API message's usage (a later report replaces an earlier one) and publish it. */
  const recordUsage = (stream, apiMessageId, usage) => {
    if (!apiMessageId || !usage || typeof usage !== 'object') return;
    const previous = stream.usage.get(apiMessageId) || {};
    const merged = { ...previous, ...Object.fromEntries(Object.entries(usage).filter(([, value]) => value !== null && value !== undefined)) };
    stream.usage.set(apiMessageId, merged);
    const messageId = `msg_${apiMessageId}`;
    emit({ type: 'message.updated', properties: { info: { ...assistantInfo(stream, messageId), tokens: tokensFrom(merged) }, directory } });
    if (!stream.main) return;
    const cacheTtlMs = cacheTtlOf({ usage: merged });
    if (cacheTtlMs) onUsage?.({ cacheTtlMs });
  };

  const ensureStreamingPart = (stream, apiMessageId, index, type, text) => {
    const messageId = `msg_${apiMessageId}`;
    const partId = `${messageId}_${type}_${index}`;
    const existingPart = stream.streamingParts.get(partId);
    if (existingPart) {
      existingPart.text += text;
      return existingPart;
    }
    const part = { id: partId, sessionID: stream.sessionId, messageID: messageId, type, text };
    stream.streamingParts.set(partId, part);
    emit({ type: 'message.updated', properties: { info: assistantInfo(stream, messageId), directory } });
    // The reducer applies deltas to an existing part only, so open it empty.
    emit({ type: 'message.part.updated', properties: { part: { ...part, text: '' }, directory } });
    return part;
  };

  const emitStreamingPart = (part) => {
    emit({ type: 'message.part.updated', properties: { part: { ...part }, directory } });
  };

  // The CLI delivers each content block of an API message as its own SDK
  // `assistant` message, always at content index 0, while the stream events
  // that preceded it carried the block's real index. The finished block
  // therefore settles the part its deltas already built instead of opening a
  // second one keyed by index 0, which would render the text twice.
  const settleBlockPart = (stream, apiMessageId, type, text) => {
    const messageId = `msg_${apiMessageId}`;
    const finalText = typeof text === 'string' ? text : '';
    for (const part of stream.streamingParts.values()) {
      if (part.messageID !== messageId || part.type !== type || stream.settledPartIds.has(part.id)) continue;
      if (part.text.trim() !== finalText.trim()) continue;
      part.text = finalText;
      stream.settledPartIds.add(part.id);
      emitStreamingPart(part);
      return;
    }
    let index = 0;
    while (stream.streamingParts.has(`${messageId}_${type}_${index}`)) index += 1;
    const part = ensureStreamingPart(stream, apiMessageId, index, type, finalText);
    stream.settledPartIds.add(part.id);
    emitStreamingPart(part);
  };

  const handleStreamEvent = (stream, event) => {
    if (event?.type === 'message_start') {
      stream.currentApiMessageId = typeof event.message?.id === 'string' ? event.message.id : null;
      recordUsage(stream, stream.currentApiMessageId, event.message?.usage);
      return;
    }
    if (event?.type === 'message_delta') {
      recordUsage(stream, stream.currentApiMessageId, event.usage);
      return;
    }
    const deltaKind = event?.type === 'content_block_delta' ? STREAM_DELTA_KINDS[event.delta?.type] : undefined;
    if (!deltaKind) return;
    const apiMessageId = stream.currentApiMessageId || `turn-${Date.now()}`;
    const index = typeof event.index === 'number' ? event.index : 0;
    const delta = event.delta[deltaKind.field] || '';
    ensureStreamingPart(stream, apiMessageId, index, deltaKind.partType, delta);
    emit({
      type: 'message.part.delta',
      properties: {
        sessionID: stream.sessionId,
        messageID: `msg_${apiMessageId}`,
        partID: `msg_${apiMessageId}_${deltaKind.partType}_${index}`,
        field: 'text',
        delta,
      },
    });
  };

  /** The public id of the child session a subagent call started, once known. */
  const childLinkOf = (callId) => {
    const agentId = turn?.subagents.get(callId);
    return agentId ? childSessionId(agentId) : null;
  };

  const handleAssistant = (stream, message) => {
    const apiMessageId = typeof message.message?.id === 'string'
      ? message.message.id
      : (stream.currentApiMessageId || `turn-${Date.now()}`);
    const content = Array.isArray(message.message?.content) ? message.message.content : [];
    recordUsage(stream, apiMessageId, message.message?.usage);
    content.forEach((block, index) => {
      if (block?.type === 'text') {
        settleBlockPart(stream, apiMessageId, 'text', block.text || '');
        return;
      }
      if (block?.type === 'thinking') {
        if (typeof block.thinking === 'string' && block.thinking.length > 0) {
          settleBlockPart(stream, apiMessageId, 'reasoning', block.thinking);
        }
        return;
      }
      if (block?.type !== 'tool_use') return;
      const messageId = `msg_${apiMessageId}`;
      const callId = typeof block.id === 'string' ? block.id : `${messageId}_tool_${index}`;
      emit({ type: 'message.updated', properties: { info: assistantInfo(stream, messageId), directory } });
      // Keyed by call id, not content index: every block arrives at index 0,
      // so parallel calls of one API message would overwrite each other.
      // Claude Code's names and keys as OpenCode's (claude-tools.js).
      const v2 = toV2Tool(block.name, block.input, { childSessionId: childLinkOf(callId) });
      const toolPart = {
        id: `${messageId}_tool_${callId}`,
        sessionID: stream.sessionId,
        messageID: messageId,
        type: 'tool',
        callID: callId,
        tool: v2.tool,
        rawName: typeof block.name === 'string' ? block.name : 'tool',
        rawInput: block.input && typeof block.input === 'object' ? block.input : {},
        state: {
          status: 'running',
          input: v2.input,
          ...(v2.metadata ? { metadata: v2.metadata } : {}),
          time: { start: Date.now() },
        },
      };
      stream.toolParts.set(callId, toolPart);
      emit({ type: 'message.part.updated', properties: { part: publicPart(toolPart), directory } });
    });
  };

  /** A tool part as published: the raw Claude call it was mapped from stays private. */
  const publicPart = (part) => {
    const { rawName: _rawName, rawInput: _rawInput, ...rest } = part;
    return rest;
  };

  const handleToolResults = (stream, content, structured = null) => {
    const results = content.filter((block) => block?.type === 'tool_result' && typeof block.tool_use_id === 'string');
    for (const block of results) {
      const toolPart = stream.toolParts.get(block.tool_use_id);
      if (!toolPart) continue;
      stream.toolParts.delete(block.tool_use_id);
      const output = toolResultText(block.content);
      const failed = block.is_error === true;
      // The SDK hands one structured result per tool-result message: the
      // exact diff of an edit, the agent a subagent call started.
      const result = results.length === 1 && structured && typeof structured === 'object' ? structured : null;
      const agentId = isSubagentTool(toolPart.rawName)
        ? (typeof result?.agentId === 'string' && result.agentId) || turn?.subagents.get(block.tool_use_id) || null
        : null;
      const v2 = toV2Tool(toolPart.rawName, toolPart.rawInput, {
        result,
        childSessionId: agentId ? childSessionId(agentId) : null,
      });
      emit({
        type: 'message.part.updated',
        properties: {
          part: publicPart({
            ...toolPart,
            state: {
              status: failed ? 'error' : 'completed',
              input: toolPart.state.input,
              output,
              error: failed ? (output || 'Tool call failed') : undefined,
              ...(v2.metadata ? { metadata: v2.metadata } : {}),
              time: { start: toolPart.state.time.start, end: Date.now() },
            },
          }),
          directory,
        },
      });
    }
  };

  /**
   * The child session a subagent frame belongs to, or null when the frame
   * names a call no `task_started` has linked (it is dropped: a subagent's
   * traffic is never shown inline in the parent's answer).
   */
  const streamForSubagentFrame = (message) => {
    const agentId = turn?.subagents.get(message.parent_tool_use_id);
    if (!agentId) return null;
    let stream = turn.children.get(agentId);
    if (!stream) {
      stream = createStream(childInternalId(agentId));
      turn.children.set(agentId, stream);
    }
    return stream;
  };

  /** A subagent's own traffic, streamed into its child session. */
  const handleSubagentFrame = (message) => {
    const stream = streamForSubagentFrame(message);
    if (!stream) return;
    if (message.type === 'stream_event') {
      handleStreamEvent(stream, message.event);
      return;
    }
    if (message.type === 'assistant') {
      handleAssistant(stream, message);
      return;
    }
    const content = message.message?.content;
    if (Array.isArray(content) && content.some((block) => block?.type === 'tool_result')) {
      handleToolResults(stream, content, message.tool_use_result);
    }
    // The prompt the subagent was given is not replayed live: its transcript
    // record (a different id) is what a read of the child session shows, and
    // the call that started it already carries it.
  };

  const handleUser = (message) => {
    const content = message.message?.content;
    if (Array.isArray(content) && content.some((block) => block?.type === 'tool_result')) {
      if (turn) handleToolResults(turn.main, content, message.tool_use_result);
      return;
    }
    // `--replay-user-messages` echoes every prompt the process accepts. Ours
    // are already on screen; anything else was typed on another surface.
    if (typeof message.uuid === 'string' && sentUuids.delete(message.uuid)) {
      // A prompt queued behind a turn is taken now: into the running turn if
      // the CLI folded it in, or as the turn that starts here.
      const waiter = queued.get(message.uuid);
      if (waiter) {
        queued.delete(message.uuid);
        if (turn) turn.folded.push(waiter);
        else beginTurn(waiter);
      }
      return;
    }
    const text = humanText(content);
    if (!text) return;
    // Its uuid travels with it: the echo and the later transcript read must land
    // on one record, or the same question shows up twice.
    onRemotePrompt(text, typeof message.uuid === 'string' ? message.uuid : null);
    if (!turn) beginTurn();
  };

  /**
   * A subagent's lifecycle: `task_started` names the agent a call started, so
   * the call links to the child session at once; `task_notification` closes it.
   */
  const handleSystem = (message) => {
    // `init` (every turn) and `status` name the mode the CLI is in: a `/plan`
    // typed as a prompt or an approved plan changes it without asking us.
    if ((message.subtype === 'init' || message.subtype === 'status') && typeof message.permissionMode === 'string' && message.permissionMode) {
      if (message.permissionMode !== permissionMode) {
        permissionMode = message.permissionMode;
        onModeReported?.(message.permissionMode);
      }
      return;
    }
    if (message.subtype === 'task_started' && typeof message.task_id === 'string' && typeof message.tool_use_id === 'string') {
      turn?.subagents.set(message.tool_use_id, message.task_id);
      const owner = turn ? [turn.main, ...turn.children.values()].find((stream) => stream.toolParts.has(message.tool_use_id)) : null;
      const toolPart = owner?.toolParts.get(message.tool_use_id);
      if (toolPart && isSubagentTool(toolPart.rawName)) {
        const v2 = toV2Tool(toolPart.rawName, toolPart.rawInput, { childSessionId: childSessionId(message.task_id) });
        toolPart.state = { ...toolPart.state, ...(v2.metadata ? { metadata: v2.metadata } : {}) };
        emit({ type: 'message.part.updated', properties: { part: publicPart(toolPart), directory } });
      }
      onSubagentStarted?.({
        agentId: message.task_id,
        toolUseId: message.tool_use_id,
        description: typeof message.description === 'string' ? message.description : '',
        agentType: typeof message.subagent_type === 'string' ? message.subagent_type : '',
      });
      return;
    }
    if (message.subtype === 'task_notification' && typeof message.task_id === 'string') {
      onSubagentEnded?.({ agentId: message.task_id, status: typeof message.status === 'string' ? message.status : 'completed' });
    }
  };

  const handleMessage = async (message) => {
    if (message?.type === 'system') {
      handleSystem(message);
      return;
    }
    if ((message?.type === 'stream_event' || message?.type === 'assistant' || message?.type === 'user') && message.parent_tool_use_id) {
      // A subagent's traffic: its own child session's, never inline in the
      // parent's answer.
      handleSubagentFrame(message);
      return;
    }
    if (message?.type === 'user') {
      handleUser(message);
      return;
    }
    if (message?.type === 'stream_event' || message?.type === 'assistant') {
      // Output with no open turn is the process answering a prompt that
      // arrived from elsewhere: it is a turn all the same.
      if (!turn) beginTurn();
      if (message.type === 'stream_event') handleStreamEvent(turn.main, message.event);
      else handleAssistant(turn.main, message);
      return;
    }
    if (message?.type === 'result') {
      const models = message.modelUsage && typeof message.modelUsage === 'object' ? Object.values(message.modelUsage) : [];
      const contextWindow = models.map((entry) => entry?.contextWindow).find((value) => Number.isFinite(value) && value > 0);
      if (contextWindow) onUsage?.({ contextWindow });
      if (message.is_error) {
        emit({
          type: 'session.error',
          properties: {
            sessionID: sessionId,
            error: { message: typeof message.result === 'string' ? message.result : 'Claude run failed' },
            directory,
          },
        });
      }
      await endTurn();
    }
  };

  const pump = (async () => {
    try {
      for await (const message of query) {
        await handleMessage(message);
      }
    } catch (error) {
      if (error?.name !== 'AbortError') {
        emit({
          type: 'session.error',
          properties: {
            sessionID: sessionId,
            error: { message: error instanceof Error ? error.message : 'Claude run failed' },
            directory,
          },
        });
      }
      await endTurn({ error });
    } finally {
      exited = true;
      prompts.end();
      await endTurn();
      for (const waiter of queued.values()) waiter.reject(new Error('Claude process exited before taking the prompt'));
      queued.clear();
      onExit?.();
    }
  })();

  // Taking a session over from a process that had it on claude.ai reattaches
  // that same remote session; if the service refuses, a fresh link is better
  // than none.
  const enableRemoteControl = async () => {
    if (!remoteControl.reattachSessionId) return query.enableRemoteControl(true, remoteControl.name);
    try {
      return await query.enableRemoteControl(true, remoteControl.name, {
        reattachSessionId: remoteControl.reattachSessionId,
      });
    } catch (error) {
      console.warn(`[claude-backend] Remote Control reattach refused for ${sessionId}:`, error?.message || error);
      return query.enableRemoteControl(true, remoteControl.name);
    }
  };

  if (remoteControl && typeof query.enableRemoteControl === 'function') {
    enableRemoteControl()
      .then((response) => {
        const url = typeof response?.session_url === 'string' ? response.session_url : '';
        if (!url) return;
        remoteControlInfo = {
          url,
          bridgeSessionId: typeof response.bridge_session_id === 'string' ? response.bridge_session_id : '',
        };
        onRemoteControl?.(remoteControlInfo);
      })
      .catch((error) => {
        console.warn(`[claude-backend] Remote Control unavailable for ${sessionId}:`, error?.message || error);
      });
  }

  /**
   * Send a prompt; resolves when the turn that answers it ends. While a turn
   * runs the prompt is queued in the CLI, as OpenCode queues one, instead of
   * being refused.
   */
  const send = (content, options = {}) => {
    if (exited) return Promise.reject(new Error('Claude process has exited'));
    return new Promise((resolve, reject) => {
      // The caller may name the prompt's transcript uuid, so a record the UI
      // still holds under its own id can be found in the transcript later
      // (a fork cut, see runtime `forkSession`).
      const uuid = typeof options.uuid === 'string' && options.uuid ? options.uuid : createUuid();
      if (turn) queued.set(uuid, { resolve, reject });
      else beginTurn({ resolve, reject });
      sentUuids.add(uuid);
      prompts.push({
        type: 'user',
        uuid,
        session_id: sessionId,
        parent_tool_use_id: null,
        message: { role: 'user', content: toCliContent(content, { asCommand: options.asCommand === true }) },
      });
    });
  };

  const applyModel = async (nextModel) => {
    if (!nextModel || nextModel === model || typeof query.setModel !== 'function') return;
    await query.setModel(nextModel);
    model = nextModel;
  };

  const applyPermissionMode = async (nextMode) => {
    if (!nextMode || nextMode === permissionMode || typeof query.setPermissionMode !== 'function') return;
    await query.setPermissionMode(nextMode);
    permissionMode = nextMode;
  };

  /** The CLI changed its own mode (a plan approved with a mode): only remember it. */
  const notePermissionMode = (mode) => {
    if (mode) permissionMode = mode;
  };

  /**
   * Put the files Claude changed back as they were at a prompt (its file
   * checkpoint); `dryRun` only says what would change.
   */
  const rewindFiles = async (userMessageId, { dryRun = false } = {}) => {
    if (exited || typeof query.rewindFiles !== 'function') throw new Error('This Claude Code process cannot rewind files');
    return query.rewindFiles(userMessageId, { dryRun });
  };

  /** Stop one running subagent; its `task_notification` reports it stopped. */
  const stopTask = async (taskId) => {
    if (exited || typeof query.stopTask !== 'function') return false;
    await query.stopTask(taskId);
    return true;
  };

  /** Stop the running turn; the process — and its Remote Control link — stays up. */
  const interrupt = async () => {
    try {
      await query.interrupt?.();
    } catch {
      // best effort: the turn is closed locally either way
    }
    await endTurn();
  };

  const close = async () => {
    prompts.end();
    try {
      await query.interrupt?.();
    } catch {
      // best effort
    }
    query.close?.();
    await endTurn();
  };

  /**
   * The slash commands this CLI answers (built-ins, the user's and the
   * project's commands, skills, plugins). Only a running CLI knows them.
   */
  const supportedCommands = async () => {
    if (exited || typeof query.supportedCommands !== 'function') return [];
    const commands = await query.supportedCommands();
    return Array.isArray(commands) ? commands : [];
  };

  return {
    send,
    interrupt,
    close,
    supportedCommands,
    applyModel,
    applyPermissionMode,
    notePermissionMode,
    permissionMode: () => permissionMode,
    stopTask,
    rewindFiles,
    exited: pump,
    isBusy: () => Boolean(turn),
    hasExited: () => exited,
    lastActivityAt: () => lastActivityAt,
    remoteControl: () => remoteControlInfo,
    directory,
    effort: options.effort,
  };
};

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

/**
 * @param {object} dependencies
 * @param {object} dependencies.sdk Agent SDK module (`query`)
 * @param {string} dependencies.sessionId
 * @param {string} dependencies.directory
 * @param {object} dependencies.options SDK query options, minus `prompt`
 * @param {string} [dependencies.model] model the process was started with
 * @param {{ name: string, reattachSessionId?: string } | null} [dependencies.remoteControl]
 *   enable Remote Control under this name, reattaching an existing remote session when given
 * @param {(payload: object) => void} dependencies.emit directory-scoped event emitter
 * @param {(status: object) => void} dependencies.setStatus busy/idle publisher
 * @param {(text: string) => void} dependencies.onRemotePrompt a prompt typed on another surface
 * @param {(info: { url: string, bridgeSessionId: string }) => void} [dependencies.onRemoteControl]
 * @param {() => Promise<void>} [dependencies.onTurnEnd]
 * @param {() => void} [dependencies.onExit]
 * @param {() => string} dependencies.createUuid
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

  const beginTurn = (pending = null) => {
    turn = {
      pending,
      // Prompts the CLI folded into this turn while it ran; they end with it.
      folded: [],
      // One OpenChamber message per Claude API message id; the CLI emits
      // several API messages per turn (one per tool round).
      streamingParts: new Map(),
      settledPartIds: new Set(),
      // Tool calls stay open until the CLI hands back their `tool_result`.
      toolParts: new Map(),
      currentApiMessageId: null,
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

  const assistantInfo = (messageId) => ({
    id: messageId,
    sessionID: sessionId,
    role: 'assistant',
    model: { providerID: 'claude', modelID: model || '' },
    providerID: 'claude',
    modelID: model || '',
    time: { created: new Date().toISOString() },
  });

  const ensureStreamingPart = (apiMessageId, index, type, text) => {
    const messageId = `msg_${apiMessageId}`;
    const partId = `${messageId}_${type}_${index}`;
    const existingPart = turn.streamingParts.get(partId);
    if (existingPart) {
      existingPart.text += text;
      return existingPart;
    }
    const part = { id: partId, sessionID: sessionId, messageID: messageId, type, text };
    turn.streamingParts.set(partId, part);
    emit({ type: 'message.updated', properties: { info: assistantInfo(messageId), directory } });
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
  const settleBlockPart = (apiMessageId, type, text) => {
    const messageId = `msg_${apiMessageId}`;
    const finalText = typeof text === 'string' ? text : '';
    for (const part of turn.streamingParts.values()) {
      if (part.messageID !== messageId || part.type !== type || turn.settledPartIds.has(part.id)) continue;
      if (part.text.trim() !== finalText.trim()) continue;
      part.text = finalText;
      turn.settledPartIds.add(part.id);
      emitStreamingPart(part);
      return;
    }
    let index = 0;
    while (turn.streamingParts.has(`${messageId}_${type}_${index}`)) index += 1;
    const part = ensureStreamingPart(apiMessageId, index, type, finalText);
    turn.settledPartIds.add(part.id);
    emitStreamingPart(part);
  };

  const handleStreamEvent = (event) => {
    if (event?.type === 'message_start') {
      turn.currentApiMessageId = typeof event.message?.id === 'string' ? event.message.id : null;
      return;
    }
    const deltaKind = event?.type === 'content_block_delta' ? STREAM_DELTA_KINDS[event.delta?.type] : undefined;
    if (!deltaKind) return;
    const apiMessageId = turn.currentApiMessageId || `turn-${Date.now()}`;
    const index = typeof event.index === 'number' ? event.index : 0;
    const delta = event.delta[deltaKind.field] || '';
    ensureStreamingPart(apiMessageId, index, deltaKind.partType, delta);
    emit({
      type: 'message.part.delta',
      properties: {
        sessionID: sessionId,
        messageID: `msg_${apiMessageId}`,
        partID: `msg_${apiMessageId}_${deltaKind.partType}_${index}`,
        field: 'text',
        delta,
      },
    });
  };

  const handleAssistant = (message) => {
    const apiMessageId = typeof message.message?.id === 'string'
      ? message.message.id
      : (turn.currentApiMessageId || `turn-${Date.now()}`);
    const content = Array.isArray(message.message?.content) ? message.message.content : [];
    content.forEach((block, index) => {
      if (block?.type === 'text') {
        settleBlockPart(apiMessageId, 'text', block.text || '');
        return;
      }
      if (block?.type === 'thinking') {
        if (typeof block.thinking === 'string' && block.thinking.length > 0) {
          settleBlockPart(apiMessageId, 'reasoning', block.thinking);
        }
        return;
      }
      if (block?.type !== 'tool_use') return;
      const messageId = `msg_${apiMessageId}`;
      const callId = typeof block.id === 'string' ? block.id : `${messageId}_tool_${index}`;
      emit({ type: 'message.updated', properties: { info: assistantInfo(messageId), directory } });
      // Keyed by call id, not content index: every block arrives at index 0,
      // so parallel calls of one API message would overwrite each other.
      const toolPart = {
        id: `${messageId}_tool_${callId}`,
        sessionID: sessionId,
        messageID: messageId,
        type: 'tool',
        callID: callId,
        tool: typeof block.name === 'string' ? block.name : 'tool',
        state: {
          status: 'running',
          input: block.input && typeof block.input === 'object' ? block.input : undefined,
          time: { start: Date.now() },
        },
      };
      turn.toolParts.set(callId, toolPart);
      emit({ type: 'message.part.updated', properties: { part: toolPart, directory } });
    });
  };

  const handleToolResults = (content) => {
    for (const block of content) {
      if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
      const toolPart = turn?.toolParts.get(block.tool_use_id);
      if (!toolPart) continue;
      turn.toolParts.delete(block.tool_use_id);
      const output = toolResultText(block.content);
      const failed = block.is_error === true;
      emit({
        type: 'message.part.updated',
        properties: {
          part: {
            ...toolPart,
            state: {
              status: failed ? 'error' : 'completed',
              input: toolPart.state.input,
              output,
              error: failed ? (output || 'Tool call failed') : undefined,
              time: { start: toolPart.state.time.start, end: Date.now() },
            },
          },
          directory,
        },
      });
    }
  };

  const handleUser = (message) => {
    const content = message.message?.content;
    if (Array.isArray(content) && content.some((block) => block?.type === 'tool_result')) {
      handleToolResults(content);
      return;
    }
    if (message.parent_tool_use_id) return;
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
    onRemotePrompt(text);
    if (!turn) beginTurn();
  };

  const handleMessage = async (message) => {
    if (message?.type === 'user') {
      handleUser(message);
      return;
    }
    if (message?.type === 'stream_event' || message?.type === 'assistant') {
      // Output with no open turn is the process answering a prompt that
      // arrived from elsewhere: it is a turn all the same.
      if (!turn) beginTurn();
      if (message.type === 'stream_event') handleStreamEvent(message.event);
      else handleAssistant(message);
      return;
    }
    if (message?.type === 'result') {
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
  const send = (content) => {
    if (exited) return Promise.reject(new Error('Claude process has exited'));
    return new Promise((resolve, reject) => {
      const uuid = createUuid();
      if (turn) queued.set(uuid, { resolve, reject });
      else beginTurn({ resolve, reject });
      sentUuids.add(uuid);
      prompts.push({
        type: 'user',
        uuid,
        session_id: sessionId,
        parent_tool_use_id: null,
        message: { role: 'user', content },
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

  return {
    send,
    interrupt,
    close,
    applyModel,
    applyPermissionMode,
    exited: pump,
    isBusy: () => Boolean(turn),
    hasExited: () => exited,
    lastActivityAt: () => lastActivityAt,
    remoteControl: () => remoteControlInfo,
    directory,
    effort: options.effort,
  };
};

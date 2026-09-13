/**
 * Transcript mapping for the Claude harness backend.
 *
 * Claude Code owns its transcripts (`~/.claude/projects/<project>/<sessionId>.jsonl`).
 * The Agent SDK reads them through `getSessionMessages()` and returns one
 * `SessionMessage` per *content block*, so a single assistant turn arrives as
 * several entries sharing one `message.id`. This module collapses those entries
 * into OpenChamber message records and folds `tool_result` carriers back into
 * the tool part they answer.
 *
 * CONTRACT: the record shape `{ info, parts }` is consumed by
 * `toHarnessMessageRecord()` in `lib/opencode/openchamber-routes.js`.
 */

const TEXT_BLOCK = 'text';
const THINKING_BLOCK = 'thinking';
const REDACTED_THINKING_BLOCK = 'redacted_thinking';
const TOOL_USE_BLOCK = 'tool_use';
const TOOL_RESULT_BLOCK = 'tool_result';
const IMAGE_BLOCK = 'image';
const DOCUMENT_BLOCK = 'document';

// OpenChamber part vocabulary (`toHarnessMessageRecord` in openchamber-routes.js
// and the shared UI renderers). Claude's block names differ from these.
const REASONING_PART = 'reasoning';
const TOOL_PART = 'tool';

const asArray = (value) => (Array.isArray(value) ? value : []);

const contentBlocks = (message) => {
  const content = message?.content;
  if (typeof content === 'string') {
    return content.trim().length > 0 ? [{ type: TEXT_BLOCK, text: content }] : [];
  }
  return asArray(content);
};

const textOf = (block) => {
  if (typeof block?.text === 'string') return block.text;
  if (typeof block?.thinking === 'string') return block.thinking;
  return '';
};

const toolResultText = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((block) => block?.type === TEXT_BLOCK && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
  return text.length > 0 ? text : undefined;
};

const isToolResultOnly = (blocks) => (
  blocks.length > 0 && blocks.every((block) => block?.type === TOOL_RESULT_BLOCK)
);

const toMillis = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
};

const toIso = (value) => new Date(toMillis(value)).toISOString();

const tokenCount = (value) => (Number.isFinite(value) && value > 0 ? value : 0);

/**
 * Claude reports usage per assistant record; the message shape the UI hydrates
 * groups cache reads and writes separately and has no reasoning bucket.
 */
const claudeUsage = (message) => {
  const usage = message?.usage ?? {};
  return {
    input: tokenCount(usage.input_tokens),
    output: tokenCount(usage.output_tokens),
    reasoning: 0,
    cache: {
      read: tokenCount(usage.cache_read_input_tokens),
      write: tokenCount(usage.cache_creation_input_tokens),
    },
  };
};

const addUsage = (left, right) => ({
  input: left.input + right.input,
  output: left.output + right.output,
  reasoning: left.reasoning + right.reasoning,
  cache: {
    read: left.cache.read + right.cache.read,
    write: left.cache.write + right.cache.write,
  },
});

const attachmentFrom = (block) => {
  const source = block?.source && typeof block.source === 'object' ? block.source : {};
  const url = typeof source.url === 'string'
    ? source.url
    : (typeof source.data === 'string'
      ? `data:${source.media_type || 'application/octet-stream'};base64,${source.data}`
      : '');
  return {
    mime: typeof source.media_type === 'string' ? source.media_type : 'application/octet-stream',
    url,
  };
};

/**
 * Sortable, stable record id. The harness route layer pages history with a
 * lexicographic `before` comparison, so ids must sort chronologically.
 */
export const buildClaudeRecordId = (timestampMs, ordinal, seed) => {
  const millis = Math.max(0, Math.trunc(Number(timestampMs) || 0));
  const seq = String(Math.max(0, Math.trunc(Number(ordinal) || 0))).padStart(6, '0');
  const seedPart = typeof seed === 'string' ? seed.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) : '';
  return `msg_${String(millis).padStart(14, '0')}_${seq}_${seedPart}`;
};

export const buildClaudePartId = (recordId, ordinal, kind) => `${recordId}_${kind}_${ordinal}`;

const collectToolOutputs = (messages) => {
  const outputs = new Map();
  for (const message of messages) {
    if (message?.type !== 'user') continue;
    for (const block of contentBlocks(message.message)) {
      if (block?.type !== TOOL_RESULT_BLOCK) continue;
      const callId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
      if (!callId) continue;
      outputs.set(callId, {
        output: toolResultText(block.content),
        error: block.is_error === true,
      });
    }
  }
  return outputs;
};

const buildUserParts = (blocks, { sessionId, recordId }) => {
  const parts = [];
  blocks.forEach((block, index) => {
    if (block?.type === TEXT_BLOCK) {
      parts.push({
        id: buildClaudePartId(recordId, index, TEXT_BLOCK),
        sessionID: sessionId,
        messageID: recordId,
        type: TEXT_BLOCK,
        text: typeof block.text === 'string' ? block.text : '',
      });
      return;
    }
    if (block?.type === IMAGE_BLOCK || block?.type === DOCUMENT_BLOCK) {
      const attachment = attachmentFrom(block);
      const filePart = {
        id: buildClaudePartId(recordId, index, 'file'),
        sessionID: sessionId,
        messageID: recordId,
        type: 'file',
        mime: attachment.mime,
        url: attachment.url,
      };
      if (typeof block.filename === 'string') {
        filePart.filename = block.filename;
      }
      parts.push(filePart);
      return;
    }
  });
  return parts;
};

const buildAssistantParts = (blocks, toolOutputs, { sessionId, recordId }) => {
  const parts = [];
  blocks.forEach(({ block }, index) => {
    const id = buildClaudePartId(recordId, index, block?.type || 'custom');

    if (block?.type === TEXT_BLOCK) {
      parts.push({
        id,
        sessionID: sessionId,
        messageID: recordId,
        type: TEXT_BLOCK,
        text: textOf(block),
      });
      return;
    }

    if (block?.type === THINKING_BLOCK || block?.type === REDACTED_THINKING_BLOCK) {
      const text = textOf(block);
      if (text.length === 0 && block?.type !== REDACTED_THINKING_BLOCK) return;
      parts.push({
        id,
        sessionID: sessionId,
        messageID: recordId,
        type: REASONING_PART,
        text,
      });
      return;
    }

    if (block?.type === TOOL_USE_BLOCK) {
      const callId = typeof block.id === 'string' ? block.id : id;
      const result = toolOutputs.get(callId);
      const status = result ? (result.error ? 'error' : 'completed') : 'running';
      parts.push({
        id,
        sessionID: sessionId,
        messageID: recordId,
        type: TOOL_PART,
        callID: callId,
        tool: typeof block.name === 'string' ? block.name : 'tool',
        state: {
          status,
          input: block.input && typeof block.input === 'object' ? block.input : undefined,
          output: result?.output,
          error: result?.error ? (result.output || 'Tool call failed') : undefined,
        },
      });
      return;
    }

    if (block?.type === IMAGE_BLOCK || block?.type === DOCUMENT_BLOCK) {
      const attachment = attachmentFrom(block);
      parts.push({
        id,
        sessionID: sessionId,
        messageID: recordId,
        type: 'file',
        mime: attachment.mime,
        url: attachment.url,
      });
    }
  });
  return parts;
};

/**
 * @param {Array} messages SessionMessage[] from the Agent SDK
 * @param {{ sessionId?: string, providerId?: string }} options
 * @returns {Array<{info: object, parts: Array<object>}>}
 */
export const mapClaudeSessionMessages = (messages, { sessionId = '', providerId = 'claude' } = {}) => {
  const ordered = asArray(messages).filter((message) => {
    // Subagent output belongs to the parent tool call, not to the main chain.
    if (message?.parent_tool_use_id) return false;
    return message?.type === 'user' || message?.type === 'assistant';
  });

  const toolOutputs = collectToolOutputs(ordered);

  // Turn list in first-seen order: one entry per user message and per distinct
  // assistant message.id. Assistant blocks from later entries join their group.
  const turns = [];
  const assistantTurns = new Map();

  ordered.forEach((message, index) => {
    const created = toMillis(message.timestamp);

    if (message.type === 'user') {
      const blocks = contentBlocks(message.message);
      if (blocks.length === 0 || isToolResultOnly(blocks)) return;
      const id = buildClaudeRecordId(created, index + 1, message.uuid);
      turns.push({
        kind: 'user',
        id,
        created,
        completed: created,
        blocks,
      });
      return;
    }

    const messageId = typeof message.message?.id === 'string' ? message.message.id : '';
    const existing = messageId ? assistantTurns.get(messageId) : undefined;
    if (existing) {
      existing.completed = created;
      existing.usage = addUsage(existing.usage, claudeUsage(message.message));
      existing.blocks.push(...contentBlocks(message.message).map((block) => ({ block })));
      return;
    }

    const turn = {
      kind: 'assistant',
      id: buildClaudeRecordId(created, index + 1, message.uuid),
      created,
      completed: created,
      modelId: typeof message.message?.model === 'string' ? message.message.model : '',
      usage: claudeUsage(message.message),
      blocks: contentBlocks(message.message).map((block) => ({ block })),
    };
    turns.push(turn);
    if (messageId) assistantTurns.set(messageId, turn);
  });

  return turns.map((turn) => {
    const isAssistant = turn.kind === 'assistant';
    const modelId = isAssistant ? turn.modelId : '';
    const parts = isAssistant
      ? buildAssistantParts(turn.blocks, toolOutputs, { sessionId, recordId: turn.id })
      : buildUserParts(turn.blocks, { sessionId, recordId: turn.id });

    const info = {
      id: turn.id,
      sessionID: sessionId,
      role: turn.kind,
      time: { created: toIso(turn.created), completed: toIso(turn.completed) },
    };
    if (isAssistant) {
      info.model = { providerID: providerId, modelID: modelId };
      info.providerID = providerId;
      info.modelID = modelId;
      info.finish = 'stop';
      info.tokens = turn.usage;
    }

    return {
      info,
      parts,
    };
  });
};

export const deriveClaudeTitle = (info) => {
  const custom = typeof info?.customTitle === 'string' ? info.customTitle.trim() : '';
  if (custom) return custom;
  const summary = typeof info?.summary === 'string' ? info.summary.trim() : '';
  if (summary) return summary.slice(0, 120);
  const firstPrompt = typeof info?.firstPrompt === 'string' ? info.firstPrompt.trim() : '';
  if (firstPrompt) return firstPrompt.slice(0, 120);
  return 'Untitled session';
};

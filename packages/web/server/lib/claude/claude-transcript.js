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

import { isSubagentTool, toV2Tool } from './claude-tools.js';

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

export const toolResultText = (content) => {
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

/**
 * How long the prompt cache this answer wrote lives, from Claude's usage
 * breakdown: `ephemeral_1h_input_tokens` (Claude Code's default on a
 * subscription) or `ephemeral_5m_input_tokens`. Null when the answer wrote no
 * cache: the tier then stays whatever an earlier answer set.
 */
export const cacheTtlOf = (message) => {
  const creation = message?.usage?.cache_creation;
  if (!creation || typeof creation !== 'object') return null;
  if (tokenCount(creation.ephemeral_1h_input_tokens) > 0) return 60 * 60 * 1000;
  if (tokenCount(creation.ephemeral_5m_input_tokens) > 0) return 5 * 60 * 1000;
  return null;
};

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
        endedAt: toMillis(message.timestamp),
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

const buildAssistantParts = (blocks, toolOutputs, {
  sessionId,
  recordId,
  startedAt = 0,
  toolResults = new Map(),
  subagents = new Map(),
  childSessionId = () => null,
}) => {
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
      // Claude Code's names and keys as OpenCode's, with the structured result
      // (exact diff hunks, the subagent it started) the SDK reader drops.
      const structured = toolResults.get(callId) || null;
      const agentId = isSubagentTool(block.name)
        ? (typeof structured?.agentId === 'string' && structured.agentId) || subagents.get(callId)?.agentId || null
        : null;
      const v2 = toV2Tool(block.name, block.input, {
        result: structured,
        childSessionId: agentId ? childSessionId(agentId) : null,
      });
      const state = {
        status,
        input: v2.input,
        output: result?.output,
        error: result?.error ? (result.output || 'Tool call failed') : undefined,
      };
      if (v2.metadata) state.metadata = v2.metadata;
      // The timeline only renders a finished tool card once it can read an end
      // time, so a resolved call carries the window Claude ran it in. Running
      // calls stay time-less for the live path to fill in.
      if (result) {
        const start = startedAt > 0 ? startedAt : result.endedAt;
        state.time = { start, end: Math.max(result.endedAt, start) };
      }
      parts.push({
        id,
        sessionID: sessionId,
        messageID: recordId,
        type: TOOL_PART,
        callID: callId,
        tool: v2.tool,
        state,
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
/**
 * The entries record ids are numbered over: user and assistant messages of the
 * main chain. Subagent output belongs to the parent tool call, not to it.
 * Shared with {@link findForkCut}, which must number them the same way.
 */
/**
 * The conversation's own entries. A session's transcript also carries its
 * subagents' traffic (`parent_tool_use_id` set), which is theirs, not its;
 * a subagent's own transcript (`getSubagentMessages`) is all such entries,
 * every one of them its conversation.
 */
const mainChain = (messages, { subagent = false } = {}) => asArray(messages).filter((message) => {
  if (!subagent && message?.parent_tool_use_id) return false;
  return message?.type === 'user' || message?.type === 'assistant';
});

/**
 * Where to cut a transcript so a fork keeps everything strictly BEFORE the
 * record the UI names — OpenCode's `fork({ before })`. The Agent SDK's
 * `forkSession` slices up to a message uuid INCLUSIVE, so the cut is the entry
 * right before the record's first entry.
 *
 * @param {Array} messages SessionMessage[] from the Agent SDK
 * @param {string} recordId a record id as {@link mapClaudeSessionMessages} built it,
 *   or one a live turn streamed: `msg_<API message id>` for an answer
 * @param {{ uuid?: string | null }} [options] the transcript uuid a prompt was
 *   sent with, for a prompt the UI still holds under its own client id
 * @returns {{ found: false } | { found: true, upToMessageId: string | null }}
 *   `upToMessageId: null` when the record is the first one: nothing precedes it.
 */
export const findForkCut = (messages, recordId, { uuid = null } = {}) => {
  const ordered = mainChain(messages);
  // A live turn streams its answer as `msg_<API message id>` (session-process.js).
  const apiMessageId = typeof recordId === 'string' && recordId.startsWith('msg_') ? recordId.slice(4) : '';
  const matches = (message, index) =>
    buildClaudeRecordId(toMillis(message.timestamp), index + 1, message.uuid) === recordId
    || (typeof uuid === 'string' && uuid !== '' && message.uuid === uuid)
    || (message.type === 'assistant' && apiMessageId !== '' && message.message?.id === apiMessageId);
  for (let index = 0; index < ordered.length; index += 1) {
    const message = ordered[index];
    if (!matches(message, index)) continue;
    for (let back = index - 1; back >= 0; back -= 1) {
      const uuid = ordered[back]?.uuid;
      if (typeof uuid === 'string' && uuid) return { found: true, upToMessageId: uuid };
    }
    return { found: true, upToMessageId: null };
  }
  return { found: false };
};

/**
 * The transcript uuid of the prompt a UI record names — the point Claude
 * Code's file checkpoints are taken at (`Query.rewindFiles`). Null when the
 * record is not a prompt of this transcript.
 *
 * @param {Array} messages SessionMessage[] from the Agent SDK
 * @param {string} recordId a record id as {@link mapClaudeSessionMessages} built it
 * @param {{ uuid?: string | null }} [options] the uuid a prompt sent from here went out with
 */
export const findPromptUuid = (messages, recordId, { uuid = null } = {}) => {
  const ordered = mainChain(messages);
  for (let index = 0; index < ordered.length; index += 1) {
    const message = ordered[index];
    if (message?.type !== 'user' || typeof message.uuid !== 'string' || !message.uuid) continue;
    if (buildClaudeRecordId(toMillis(message.timestamp), index + 1, message.uuid) === recordId) return message.uuid;
    if (typeof uuid === 'string' && uuid !== '' && message.uuid === uuid) return message.uuid;
  }
  return null;
};

/**
 * What a `type: 'user'` transcript entry really is. Claude Code records more
 * than prompts under that type, and read back as prompts they become the
 * user's own bubbles full of XML — and, being the last "user" message, make
 * the UI report a reply that never began:
 *
 * - `isMeta`: a caveat the CLI injects for the model (local-command notices);
 *   not the user's, never shown.
 * - `isCompactSummary`: the summary a compaction left behind.
 * - `<command-name>/x</command-name>…`: a local slash command the user ran.
 * - `<local-command-stdout>…`: that command's output — its answer.
 * - `<bash-input>…` / `<bash-stdout>…`: a `!command` run from the terminal or
 *   VS Code, and its output.
 */
const ANSI_ESCAPES = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

const tagContent = (text, tag) => {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  return match ? match[1] : null;
};

const joinOutputs = (...outputs) => outputs
  .filter((output) => typeof output === 'string' && output.trim())
  .map((output) => output.replace(ANSI_ESCAPES, '').trim())
  .join('\n');

export const classifyUserEntry = (message, blocks) => {
  if (message?.isMeta) return { kind: 'skip' };
  const text = asArray(blocks)
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
  if (message?.isCompactSummary) return { kind: 'compaction', summary: text };
  const commandName = tagContent(text, 'command-name');
  if (commandName !== null && commandName.trim()) {
    const name = commandName.trim().startsWith('/') ? commandName.trim() : `/${commandName.trim()}`;
    const args = (tagContent(text, 'command-args') || '').trim();
    return { kind: 'command', text: args ? `${name} ${args}` : name };
  }
  const stdout = tagContent(text, 'local-command-stdout');
  const stderr = tagContent(text, 'local-command-stderr');
  if (stdout !== null || stderr !== null) return { kind: 'command-output', text: joinOutputs(stdout, stderr) };
  const bashInput = tagContent(text, 'bash-input');
  if (bashInput !== null) return { kind: 'shell', command: bashInput.trim() };
  const bashStdout = tagContent(text, 'bash-stdout');
  const bashStderr = tagContent(text, 'bash-stderr');
  if (bashStdout !== null || bashStderr !== null) {
    return { kind: 'shell-output', output: joinOutputs(bashStdout, bashStderr), failed: Boolean(bashStderr && bashStderr.trim()) };
  }
  return { kind: 'prompt' };
};

export const mapClaudeSessionMessages = (messages, {
  sessionId = '',
  providerId = 'claude',
  toolResults = new Map(),
  subagents = new Map(),
  childSessionId = () => null,
  // The messages are one subagent's own transcript (a child session).
  subagent = false,
  // The id the UI already holds a sent prompt under, asked by transcript uuid.
  // A prompt echoes out live under an id the transcript cannot rebuild (its
  // ordinal is the position in the transcript, its seed the uuid), so a read
  // landed beside the echo and the UI kept both copies: the same question
  // painted twice. Measured 29-09-2026, session b00e8d06.
  promptRecordIdOf = () => null,
} = {}) => {
  const ordered = mainChain(messages, { subagent });

  const toolOutputs = collectToolOutputs(ordered);

  // Turn list in first-seen order: one entry per user message and per distinct
  // assistant message.id. Assistant blocks from later entries join their group.
  const turns = [];
  const assistantTurns = new Map();

  // The `!command` a `<bash-stdout>` entry belongs to (the entry before it).
  let openShell = null;

  ordered.forEach((message, index) => {
    const created = toMillis(message.timestamp);

    if (message.type === 'user') {
      const blocks = contentBlocks(message.message);
      if (blocks.length === 0 || isToolResultOnly(blocks)) return;
      // A prompt this server sent keeps the id its live echo used, so the read
      // supersedes that copy instead of adding a second bubble beside it.
      const id = promptRecordIdOf(message.uuid)
        || buildClaudeRecordId(created, index + 1, message.uuid);
      const entry = classifyUserEntry(message, blocks);
      if (entry.kind !== 'shell-output') openShell = null;
      switch (entry.kind) {
        case 'skip':
          return;
        case 'compaction': {
          // Run by `/compact` when that command follows it; otherwise the CLI
          // compacted on its own because the context ran out.
          const manual = ordered.slice(index + 1, index + 4).some((next) => next?.type === 'user'
            && classifyUserEntry(next, contentBlocks(next.message)).text === '/compact');
          turns.push({ kind: 'compaction', id, created, completed: created, summary: entry.summary, reason: manual ? 'manual' : 'auto' });
          return;
        }
        case 'command':
          turns.push({ kind: 'user', id, created, completed: created, blocks: [{ type: 'text', text: entry.text }] });
          return;
        case 'command-output':
          // The command's answer, so the turn reads as answered.
          turns.push({
            kind: 'assistant',
            id,
            created,
            completed: created,
            modelId: '',
            usage: undefined,
            blocks: entry.text ? [{ block: { type: 'text', text: entry.text } }] : [],
          });
          return;
        case 'shell':
          openShell = { kind: 'shell', id, created, completed: created, command: entry.command, output: '', failed: false };
          turns.push(openShell);
          return;
        case 'shell-output':
          if (openShell) {
            openShell.output = entry.output;
            openShell.failed = entry.failed;
            openShell.completed = created;
            openShell = null;
          }
          return;
        default:
          turns.push({ kind: 'user', id, created, completed: created, blocks });
          return;
      }
    }
    openShell = null;

    const messageId = typeof message.message?.id === 'string' ? message.message.id : '';
    const existing = messageId ? assistantTurns.get(messageId) : undefined;
    if (existing) {
      existing.completed = created;
      // Every entry of one API message repeats that message's usage: it is
      // counted once (the latest), never summed per content block.
      existing.usage = claudeUsage(message.message);
      existing.cacheTtlMs = cacheTtlOf(message.message) ?? existing.cacheTtlMs;
      existing.blocks.push(...contentBlocks(message.message).map((block) => ({ block })));
      return;
    }

    const turn = {
      kind: 'assistant',
      // The id a live turn streams this answer under (session-process.js:
      // `msg_<API message id>`), so a read of the transcript lands on the same
      // record instead of beside it. Two ids for one answer left the UI with
      // both copies, the live one still open — and marked interrupted once
      // the session read as idle (measured 28-09-2026, session 1a6b48b8).
      id: messageId ? `msg_${messageId}` : buildClaudeRecordId(created, index + 1, message.uuid),
      created,
      completed: created,
      modelId: typeof message.message?.model === 'string' ? message.message.model : '',
      usage: claudeUsage(message.message),
      cacheTtlMs: cacheTtlOf(message.message),
      blocks: contentBlocks(message.message).map((block) => ({ block })),
    };
    turns.push(turn);
    if (messageId) assistantTurns.set(messageId, turn);
  });

  // The shared timeline groups messages into turns by `info.parentID`: an
  // assistant record without it is orphaned and never renders. Claude has no
  // such field, so the parent is the user turn the transcript ran under.
  let lastUserRecordId = '';
  // A turn that only read the cache keeps the tier an earlier write set.
  let cacheTtlMs = null;

  return turns.map((turn) => {
    if (turn.kind === 'compaction') {
      return {
        info: {
          id: turn.id,
          sessionID: sessionId,
          role: 'compaction',
          time: { created: toIso(turn.created), completed: toIso(turn.completed) },
          status: 'completed',
          reason: turn.reason,
          summary: turn.summary,
        },
        parts: [],
      };
    }
    if (turn.kind === 'shell') {
      return {
        info: {
          id: turn.id,
          sessionID: sessionId,
          role: 'shell',
          time: { created: toIso(turn.created), completed: toIso(turn.completed) },
          command: turn.command,
          output: turn.output,
          exit: turn.failed ? 1 : 0,
        },
        parts: [],
      };
    }
    const isAssistant = turn.kind === 'assistant';
    const modelId = isAssistant ? turn.modelId : '';
    const parts = isAssistant
      ? buildAssistantParts(turn.blocks, toolOutputs, {
        sessionId,
        recordId: turn.id,
        startedAt: turn.created,
        toolResults,
        subagents,
        childSessionId,
      })
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
      if (turn.cacheTtlMs) cacheTtlMs = turn.cacheTtlMs;
      if (cacheTtlMs && turn.usage && (turn.usage.cache.read > 0 || turn.usage.cache.write > 0)) {
        info.metadata = { claude: { cacheTtlMs } };
      }
      if (lastUserRecordId) {
        info.parentID = lastUserRecordId;
      }
    } else {
      lastUserRecordId = turn.id;
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

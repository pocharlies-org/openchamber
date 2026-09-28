import { describe, expect, it } from 'vitest';

import {
  buildClaudeRecordId,
  deriveClaudeTitle,
  findForkCut,
  findPromptUuid,
  mapClaudeSessionMessages,
} from './claude-transcript.js';

const T0 = Date.parse('2026-09-12T10:00:00.000Z');
const at = (offsetMs) => new Date(T0 + offsetMs).toISOString();

const userText = (text, uuid, timestamp) => ({
  type: 'user',
  uuid,
  timestamp,
  message: { role: 'user', content: text },
});

const assistantBlock = (messageId, block, uuid, timestamp, model = 'claude-sonnet-4-5') => ({
  type: 'assistant',
  uuid,
  timestamp,
  message: { id: messageId, role: 'assistant', model, content: [block] },
});

const toolResultMessage = (toolUseId, content, uuid, timestamp, isError = false) => ({
  type: 'user',
  uuid,
  timestamp,
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }],
  },
});

describe('mapClaudeSessionMessages', () => {
  it('groups assistant blocks that share one API message id', () => {
    const records = mapClaudeSessionMessages([
      userText('hello', 'u1', at(0)),
      assistantBlock('msg_a', { type: 'text', text: 'thinking out ' }, 'a1', at(100)),
      assistantBlock('msg_a', { type: 'text', text: 'loud' }, 'a2', at(200)),
    ], { sessionId: 'sess-1' });

    const assistant = records.filter((record) => record.info.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0].parts).toHaveLength(2);
    expect(assistant[0].parts.map((part) => part.text)).toEqual(['thinking out ', 'loud']);
    expect(assistant[0].info.modelID).toBe('claude-sonnet-4-5');
    expect(assistant[0].info.time.created).toBe(at(100));
    expect(assistant[0].info.time.completed).toBe(at(200));
  });

  it('keeps separate API messages as separate records', () => {
    const records = mapClaudeSessionMessages([
      assistantBlock('msg_a', { type: 'text', text: 'first' }, 'a1', at(100)),
      assistantBlock('msg_b', { type: 'text', text: 'second' }, 'a2', at(300)),
    ], { sessionId: 'sess-1' });

    const assistant = records.filter((record) => record.info.role === 'assistant');
    expect(assistant).toHaveLength(2);
    expect(assistant[0].parts[0].text).toBe('first');
    expect(assistant[1].parts[0].text).toBe('second');
  });

  it('folds tool_result blocks back into the matching tool part', () => {
    const records = mapClaudeSessionMessages([
      userText('run it', 'u1', at(0)),
      assistantBlock('msg_a', {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'Bash',
        input: { command: 'ls' },
      }, 'a1', at(100)),
      toolResultMessage('toolu_1', 'file.txt', 'r1', at(200)),
      assistantBlock('msg_a', { type: 'text', text: 'done' }, 'a2', at(300)),
    ], { sessionId: 'sess-1' });

    const toolParts = records
      .flatMap((record) => record.parts)
      .filter((part) => part.type === 'tool');

    expect(toolParts).toHaveLength(1);
    expect(toolParts[0].callID).toBe('toolu_1');
    // Claude Code's `Bash` is OpenCode's `shell`: the UI's command renderer.
    expect(toolParts[0].tool).toBe('shell');
    expect(toolParts[0].state.status).toBe('completed');
    expect(toolParts[0].state.input).toEqual({ command: 'ls', description: undefined });
    expect(toolParts[0].state.output).toBe('file.txt');
  });

  it('marks tool parts without a result as running and errors as error', () => {
    const records = mapClaudeSessionMessages([
      assistantBlock('msg_a', { type: 'tool_use', id: 'toolu_open', name: 'Read', input: {} }, 'a1', at(100)),
      assistantBlock('msg_b', { type: 'tool_use', id: 'toolu_bad', name: 'Read', input: {} }, 'b1', at(200)),
      toolResultMessage('toolu_bad', 'boom', 'r1', at(300), true),
    ], { sessionId: 'sess-1' });

    const byCall = Object.fromEntries(
      records
        .flatMap((record) => record.parts)
        .filter((part) => part.type === 'tool')
        .map((part) => [part.callID, part]),
    );

    expect(byCall.toolu_open.state.status).toBe('running');
    expect(byCall.toolu_bad.state.status).toBe('error');
    expect(byCall.toolu_bad.state.error).toBe('boom');
  });

  it('drops tool-result-only user messages from the turn list', () => {
    const records = mapClaudeSessionMessages([
      userText('hi', 'u1', at(0)),
      toolResultMessage('toolu_1', 'ok', 'r1', at(100)),
    ], { sessionId: 'sess-1' });

    expect(records.filter((record) => record.info.role === 'user')).toHaveLength(1);
  });

  it('excludes subagent output and non-chat entries', () => {
    const records = mapClaudeSessionMessages([
      userText('hi', 'u1', at(0)),
      { ...assistantBlock('msg_sub', { type: 'text', text: 'from subagent' }, 's1', at(100)), parent_tool_use_id: 'toolu_1' },
      { type: 'system', uuid: 'sys1', timestamp: at(150), message: { content: [{ type: 'text', text: 'init' }] } },
    ], { sessionId: 'sess-1' });

    const texts = records.flatMap((record) => record.parts).filter((part) => part.type === 'text');
    expect(texts.map((part) => part.text)).toEqual(['hi']);
  });

  it('maps thinking blocks to reasoning parts', () => {
    const records = mapClaudeSessionMessages([
      assistantBlock('msg_a', { type: 'thinking', thinking: 'considering' }, 'a1', at(100)),
      assistantBlock('msg_a', { type: 'redacted_thinking', data: 'opaque' }, 'a2', at(150)),
      assistantBlock('msg_a', { type: 'thinking', thinking: '' }, 'a3', at(160)),
    ], { sessionId: 'sess-1' });

    const parts = records[0].parts;
    expect(parts.map((part) => part.type)).toEqual(['reasoning', 'reasoning']);
    expect(parts[0].text).toBe('considering');
  });

  it('keeps transcript order, and files an answer under the id its live turn streamed', () => {
    const records = mapClaudeSessionMessages([
      userText('one', 'u1', at(0)),
      assistantBlock('msg_a', { type: 'text', text: 'two' }, 'a1', at(1000)),
      assistantBlock('msg_a', { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }, 'a2', at(1500)),
      userText('three', 'u2', at(2000)),
    ], { sessionId: 'sess-1' });

    expect(records.map((record) => record.info.role)).toEqual(['user', 'assistant', 'user']);
    const created = records.map((record) => Date.parse(record.info.time.created));
    expect([...created].sort((a, b) => a - b)).toEqual(created);
    // session-process.js streams this answer as `msg_<API message id>`: the
    // same id, so the UI replaces its live copy instead of keeping both.
    expect(records[1].info.id).toBe('msg_msg_a');
    expect(records[1].info.time.completed).toBeDefined();
    // Prompts keep their own ids.
    expect(records[0].info.id).toMatch(/^msg_\d{14}_000001_u1$/);
  });

  it('keeps the positional id for an answer with no API message id', () => {
    const records = mapClaudeSessionMessages([
      userText('one', 'u1', at(0)),
      { type: 'assistant', uuid: 'a1', timestamp: at(1000), message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] } },
    ], { sessionId: 'sess-1' });
    expect(records[1].info.id).toMatch(/^msg_\d{14}_000002_a1$/);
  });

  it('converts image blocks into file parts with a data url', () => {
    const records = mapClaudeSessionMessages([
      {
        type: 'user',
        uuid: 'u1',
        timestamp: at(0),
        message: {
          role: 'user',
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }],
        },
      },
    ], { sessionId: 'sess-1' });

    const filePart = records[0].parts[0];
    expect(filePart.type).toBe('file');
    expect(filePart.mime).toBe('image/png');
    expect(filePart.url).toBe('data:image/png;base64,AAAA');
  });

  it('parents every assistant turn to the user turn it ran under', () => {
    const records = mapClaudeSessionMessages([
      userText('first prompt', 'u1', at(0)),
      assistantBlock('msg_a', { type: 'text', text: 'a1' }, 'a1', at(10)),
      assistantBlock('msg_a', { type: 'text', text: 'a2' }, 'a2', at(20)),
      assistantBlock('msg_a2', { type: 'text', text: 'a3' }, 'a3', at(25)),
      userText('second prompt', 'u2', at(30)),
      assistantBlock('msg_b', { type: 'text', text: 'b1' }, 'b4', at(40)),
    ], { sessionId: 'sess-1' });

    const [firstUser, mergedAssistant, secondAssistant, secondUser, lastAssistant] = records;
    expect(records.map((record) => record.info.role)).toEqual([
      'user', 'assistant', 'assistant', 'user', 'assistant',
    ]);

    // Blocks sharing one Claude message.id stay a single OpenChamber message.
    expect(mergedAssistant.parts.filter((part) => part.type === 'text')).toHaveLength(2);

    expect(mergedAssistant.info.parentID).toBe(firstUser.info.id);
    expect(secondAssistant.info.parentID).toBe(firstUser.info.id);
    expect(lastAssistant.info.parentID).toBe(secondUser.info.id);
    expect(firstUser.info.parentID).toBeUndefined();
  });

  it('omits parentID when an assistant turn precedes any user turn', () => {
    const records = mapClaudeSessionMessages([
      assistantBlock('msg_a', { type: 'text', text: 'orphan' }, 'a1', at(0)),
    ], { sessionId: 'sess-1' });

    expect(records).toHaveLength(1);
    expect(records[0].info.parentID).toBeUndefined();
  });

  it('gives a resolved tool part a time window so the timeline renders it', () => {
    const records = mapClaudeSessionMessages([
      userText('run it', 'u1', at(0)),
      assistantBlock('msg_a', { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } }, 'a1', at(1000)),
      toolResultMessage('tu_1', 'file1\nfile2', 'r1', at(4000)),
    ], { sessionId: 'sess-1' });

    const tool = records[1].parts.find((part) => part.type === 'tool');
    expect(tool.state.status).toBe('completed');
    expect(tool.state.time).toEqual({ start: T0 + 1000, end: T0 + 4000 });
    expect(tool.state.output).toBe('file1\nfile2');
  });

  it('leaves an unresolved tool call without a time window', () => {
    const records = mapClaudeSessionMessages([
      userText('run it', 'u1', at(0)),
      assistantBlock('msg_a', { type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} }, 'a1', at(1000)),
    ], { sessionId: 'sess-1' });

    const tool = records[1].parts.find((part) => part.type === 'tool');
    expect(tool.state.status).toBe('running');
    expect(tool.state.time).toBeUndefined();
  });
});

describe('buildClaudeRecordId', () => {
  it('pads millis and ordinal so ids sort by time', () => {
    expect(buildClaudeRecordId(T0, 1, 'uuid-abc')).toBe(`msg_${String(T0).padStart(14, '0')}_000001_uuidabc`);
    expect(buildClaudeRecordId(T0, 1, 'uuid-abc') < buildClaudeRecordId(T0 + 1, 1, 'uuid-abc')).toBe(true);
  });
});

describe('deriveClaudeTitle', () => {
  it('prefers customTitle, then summary, then firstPrompt', () => {
    expect(deriveClaudeTitle({ customTitle: ' Named ', summary: 's', firstPrompt: 'p' })).toBe('Named');
    expect(deriveClaudeTitle({ summary: 's', firstPrompt: 'p' })).toBe('s');
    expect(deriveClaudeTitle({ firstPrompt: 'p' })).toBe('p');
    expect(deriveClaudeTitle({})).toBe('Untitled session');
  });

  it('truncates long fallback titles', () => {
    expect(deriveClaudeTitle({ firstPrompt: 'x'.repeat(200) })).toHaveLength(120);
  });
});

describe('findForkCut', () => {
  // Timestamps and uuids chosen so the record ids are easy to rebuild.
  const entry = (type, uuid, at, extra = {}) => ({
    type,
    uuid,
    timestamp: new Date(at).toISOString(),
    message: type === 'user'
      ? { role: 'user', content: [{ type: 'text', text: `${uuid} text` }] }
      : { id: `api-${uuid}`, role: 'assistant', content: [{ type: 'text', text: `${uuid} answer` }] },
    ...extra,
  });
  const transcript = [
    entry('user', 'u1aaaaaa-0000', 1000),
    entry('assistant', 'a1aaaaaa-0000', 2000),
    // A subagent's line: not part of the main chain, never a cut point.
    entry('assistant', 'side0000-0000', 2500, { parent_tool_use_id: 'toolu_1' }),
    entry('user', 'u2aaaaaa-0000', 3000),
    entry('assistant', 'a2aaaaaa-0000', 4000),
  ];
  const idOf = (uuid) => mapClaudeSessionMessages(transcript).find((record) => record.info.id.endsWith(uuid.replace(/-/g, '').slice(0, 8)))?.info.id;

  it('cuts right before the named record: the previous main-chain entry is the inclusive end', () => {
    expect(findForkCut(transcript, idOf('u2aaaaaa-0000'))).toEqual({ found: true, upToMessageId: 'a1aaaaaa-0000' });
  });

  it('says there is nothing to keep when the record is the first one', () => {
    expect(findForkCut(transcript, idOf('u1aaaaaa-0000'))).toEqual({ found: true, upToMessageId: null });
  });

  it('does not find a record the transcript does not have', () => {
    expect(findForkCut(transcript, 'msg_00000000009999_000009_nothere')).toEqual({ found: false });
  });

  it('finds a prompt the UI still holds under its client id, through the uuid it was sent with', () => {
    expect(findForkCut(transcript, 'msg_client_1', { uuid: 'u2aaaaaa-0000' })).toEqual({ found: true, upToMessageId: 'a1aaaaaa-0000' });
  });

  it('finds an answer the UI holds under its live id, msg_<API message id>', () => {
    expect(findForkCut(transcript, 'msg_api-a2aaaaaa-0000')).toEqual({ found: true, upToMessageId: 'u2aaaaaa-0000' });
  });

  it('numbers records exactly as mapClaudeSessionMessages does', () => {
    for (const record of mapClaudeSessionMessages(transcript)) {
      expect(findForkCut(transcript, record.info.id).found).toBe(true);
    }
  });
});

describe('Claude Code bookkeeping entries under type "user"', () => {
  const at = (ms) => new Date(ms).toISOString();
  const user = (uuid, ms, text, extra = {}) => ({ type: 'user', uuid, timestamp: at(ms), message: { role: 'user', content: text }, ...extra });
  const answer = (uuid, ms, text) => ({ type: 'assistant', uuid, timestamp: at(ms), message: { id: `api-${uuid}`, role: 'assistant', model: 'claude-x', content: [{ type: 'text', text }] } });
  const transcript = [
    user('u1', 1000, 'hello'),
    answer('a1', 2000, 'hi'),
    user('s1', 3000, 'This session is being continued from a previous conversation...', { isCompactSummary: true }),
    user('m1', 3001, '<local-command-caveat>Caveat: generated by local commands</local-command-caveat>', { isMeta: true }),
    user('c1', 3002, '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>'),
    user('o1', 3003, '<local-command-stdout>\u001b[1mCompacted\u001b[22m </local-command-stdout>'),
    user('b1', 4000, '<bash-input>ls -la</bash-input>'),
    user('b2', 4001, '<bash-stdout>README.md</bash-stdout><bash-stderr></bash-stderr>'),
  ];
  const records = mapClaudeSessionMessages(transcript);
  const roles = records.map((record) => record.info.role);

  it('never shows the CLI\'s caveat, and reads the rest for what it is', () => {
    expect(roles).toEqual(['user', 'assistant', 'compaction', 'user', 'assistant', 'shell']);
  });

  it('a compaction is a compaction notice with its summary, manual when /compact ran it', () => {
    const compaction = records.find((record) => record.info.role === 'compaction');
    expect(compaction.info).toMatchObject({ status: 'completed', reason: 'manual', summary: 'This session is being continued from a previous conversation...' });
  });

  it('the command is the user\'s clean prompt and its output is the answer, without tags or ANSI', () => {
    const [command, output] = records.slice(3, 5);
    expect(command.parts.map((part) => part.text)).toEqual(['/compact']);
    expect(output.parts.map((part) => part.text)).toEqual(['Compacted']);
    expect(output.info.parentID).toBe(command.info.id);
  });

  it('a terminal `!command` is a shell record with its output', () => {
    const shell = records.at(-1);
    expect(shell.info).toMatchObject({ command: 'ls -la', output: 'README.md', exit: 0 });
  });

  it('a compaction the CLI ran on its own is automatic', () => {
    const auto = mapClaudeSessionMessages([user('u1', 1000, 'hello'), user('s1', 2000, 'summary', { isCompactSummary: true }), user('u2', 3000, 'next')]);
    expect(auto.find((record) => record.info.role === 'compaction').info.reason).toBe('auto');
  });

  it('keeps the record numbering a fork cut relies on', () => {
    for (const record of records.filter((entry) => entry.info.role === 'user' || entry.info.role === 'assistant')) {
      expect(findForkCut(transcript, record.info.id).found).toBe(true);
    }
  });
});

describe('findPromptUuid', () => {
  it('names the transcript uuid of the prompt a record stands for', () => {
    const messages = [
      userText('first', 'u-1', at(0)),
      assistantBlock('msg_a', { type: 'text', text: 'ok' }, 'a-1', at(100)),
      userText('second', 'u-2', at(200)),
    ];
    const records = mapClaudeSessionMessages(messages, { sessionId: 's' });
    const second = records.filter((record) => record.info.role === 'user')[1];
    expect(findPromptUuid(messages, second.info.id)).toBe('u-2');
    // A prompt the UI still holds under its client id, by the uuid it went out with.
    expect(findPromptUuid(messages, 'msg_client', { uuid: 'u-1' })).toBe('u-1');
    // An answer is not a prompt: no checkpoint is taken there.
    const answer = records.find((record) => record.info.role === 'assistant');
    expect(findPromptUuid(messages, answer.info.id)).toBeNull();
    expect(findPromptUuid(messages, 'msg_nope')).toBeNull();
  });
});

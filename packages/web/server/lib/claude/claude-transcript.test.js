import { describe, expect, it } from 'vitest';

import {
  buildClaudeRecordId,
  deriveClaudeTitle,
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
    expect(toolParts[0].tool).toBe('Bash');
    expect(toolParts[0].state.status).toBe('completed');
    expect(toolParts[0].state.input).toEqual({ command: 'ls' });
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

  it('emits ids that sort chronologically', () => {
    const records = mapClaudeSessionMessages([
      userText('one', 'u1', at(0)),
      assistantBlock('msg_a', { type: 'text', text: 'two' }, 'a1', at(1000)),
      userText('three', 'u2', at(2000)),
    ], { sessionId: 'sess-1' });

    const ids = records.map((record) => record.info.id);
    expect([...ids].sort()).toEqual(ids);
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

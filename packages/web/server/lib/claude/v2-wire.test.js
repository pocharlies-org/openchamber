import { describe, expect, it } from 'vitest';

import { createClaudeV2EventTranslator, pageOf, toV2Message, toV2Session } from './v2-wire.js';
import { createProjectResolver } from './routes.js';

const flush = () => new Promise((resolve) => queueMicrotask(resolve));

const translatorWithLog = () => {
  const events = [];
  let seq = 0;
  const translator = createClaudeV2EventTranslator({
    publish: (event) => events.push(event),
    toPublicId: (id) => `ses_ccc${id}`,
    toSession: (session) => toV2Session({ ...session, id: `ses_ccc${session.id}` }),
    createEventId: () => `evt_${seq += 1}`,
    now: () => 1_000,
  });
  return { events, translate: translator.translate, types: () => events.map((event) => event.type) };
};

describe('toV2Session', () => {
  it('presents a transcript at the project root that contains it, keeping the rest as subpath', () => {
    const resolve = createProjectResolver([{ id: 'p1', worktree: '/repo' }]);

    const session = toV2Session({ id: 'ses_ccc1', directory: '/repo/a/b', title: 'T', time: { created: 1, updated: 2, archived: 3 } }, resolve);

    expect(session).toMatchObject({
      id: 'ses_ccc1',
      projectID: 'p1',
      location: { directory: '/repo' },
      subpath: 'a/b',
      time: { created: 1, updated: 2, archived: 3 },
      metadata: { backend: 'claude', claude: { directory: '/repo/a/b' } },
    });
  });

  it('keeps its own directory when no project contains it', () => {
    const session = toV2Session({ id: 'ses_ccc1', directory: '/tmp/x', time: { created: 1, updated: 1 } }, createProjectResolver([]));

    expect(session.location).toEqual({ directory: '/tmp/x' });
    expect(session.projectID).toBe('global');
    expect(session.subpath).toBeUndefined();
  });
});

describe('toV2Message', () => {
  it('turns a user record into one text with its attachments', () => {
    const message = toV2Message({
      info: { id: 'msg_u', role: 'user', time: { created: '2026-09-25T10:00:00.000Z' } },
      parts: [
        { type: 'text', text: 'hola' },
        { type: 'file', mime: 'image/png', url: 'data:image/png;base64,AAA', filename: 'a.png' },
      ],
    });

    expect(message).toEqual({
      type: 'user',
      id: 'msg_u',
      time: { created: Date.parse('2026-09-25T10:00:00.000Z') },
      text: 'hola',
      files: [{ mime: 'image/png', name: 'a.png', source: { type: 'uri', uri: 'data:image/png;base64,AAA' } }],
    });
  });

  it('keeps reasoning apart from the answer and maps tool states', () => {
    const message = toV2Message({
      info: { id: 'msg_a', role: 'assistant', providerID: 'claude', modelID: 'claude-opus-5-5', time: { created: 10, completed: 20 } },
      parts: [
        { type: 'reasoning', text: 'pienso' },
        { type: 'tool', callID: 'call_1', tool: 'Bash', state: { status: 'completed', input: { command: 'ls' }, output: 'a', time: { start: 11, end: 12 } } },
        { type: 'tool', callID: 'call_2', tool: 'Read', state: { status: 'error', input: {}, error: 'no', time: { start: 13, end: 14 } } },
        { type: 'tool', callID: 'call_3', tool: 'Grep', state: { status: 'running', input: { q: 'x' } } },
        { type: 'text', text: 'respuesta' },
      ],
    });

    expect(message.type).toBe('assistant');
    expect(message.model).toEqual({ providerID: 'claude', id: 'claude-opus-5-5' });
    expect(message.finish).toBe('stop');
    expect(message.content.map((item) => item.type)).toEqual(['reasoning', 'tool', 'tool', 'tool', 'text']);
    expect(message.content[0]).toEqual({ type: 'reasoning', text: 'pienso' });
    expect(message.content[1]).toMatchObject({ id: 'call_1', name: 'Bash', state: { status: 'completed', content: [{ type: 'text', text: 'a' }] }, time: { created: 11, completed: 12 } });
    expect(message.content[2]).toMatchObject({ id: 'call_2', state: { status: 'error', error: { message: 'no' } } });
    expect(message.content[3]).toMatchObject({ id: 'call_3', state: { status: 'running', input: { q: 'x' } } });
  });
});

describe('pageOf', () => {
  const items = [1, 2, 3, 4, 5];

  it('serves newest first by default and walks older pages with the cursor alone', () => {
    const first = pageOf(items, { limit: 2 });
    expect(first.data).toEqual([5, 4]);
    const second = pageOf(items, { limit: 2, cursor: first.cursor.next });
    expect(second.data).toEqual([3, 2]);
    const last = pageOf(items, { limit: 2, cursor: second.cursor.next });
    expect(last.data).toEqual([1]);
    expect(last.cursor.next).toBeNull();
  });

  it('keeps ascending order across pages and refuses a cursor it did not issue', () => {
    const first = pageOf(items, { limit: 3, order: 'asc' });
    expect(pageOf(items, { limit: 3, cursor: first.cursor.next }).data).toEqual([4, 5]);
    expect(pageOf(items, { cursor: 'not-a-cursor' })).toBeNull();
  });
});

describe('createClaudeV2EventTranslator', () => {
  it('streams a turn as OpenCode 2 steps, with reasoning apart from text', async () => {
    const { events, translate, types } = translatorWithLog();
    const part = (type, index, text) => ({ id: `msg_x_${type}_${index}`, sessionID: 's1', messageID: 'msg_x', type, text });

    translate({ type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' }, directory: '/repo' } });
    translate({ type: 'message.updated', properties: { info: { id: 'msg_x', sessionID: 's1', role: 'assistant', modelID: 'claude-opus-5-5', time: { created: '2026-09-25T10:00:00Z' } }, directory: '/repo' } });
    translate({ type: 'message.part.updated', properties: { part: part('reasoning', 0, ''), directory: '/repo' } });
    translate({ type: 'message.part.delta', properties: { sessionID: 's1', messageID: 'msg_x', partID: 'msg_x_reasoning_0', field: 'text', delta: 'pien' } });
    translate({ type: 'message.part.updated', properties: { part: part('text', 1, ''), directory: '/repo' } });
    translate({ type: 'message.part.delta', properties: { sessionID: 's1', messageID: 'msg_x', partID: 'msg_x_text_1', field: 'text', delta: 'ho' } });
    // The settled block repeats the text: nothing new to show.
    translate({ type: 'message.part.updated', properties: { part: part('text', 1, 'ho'), directory: '/repo' } });
    // A settled block that grew arrives as the delta it adds.
    translate({ type: 'message.part.updated', properties: { part: part('reasoning', 0, 'pienso'), directory: '/repo' } });
    translate({ type: 'session.idle', properties: { sessionID: 's1', directory: '/repo' } });

    expect(types()).toEqual([
      'session.status',
      'session.step.started',
      'session.reasoning.started',
      'session.reasoning.delta',
      'session.text.started',
      'session.text.delta',
      'session.reasoning.delta',
      'session.text.ended',
      'session.reasoning.ended',
      'session.step.ended',
      'session.idle',
    ]);
    expect(events[1].data).toMatchObject({ sessionID: 'ses_cccs1', assistantMessageID: 'msg_x', model: { id: 'claude-opus-5-5' } });
    expect(events[2].data.ordinal).toBe(0);
    expect(events[4].data.ordinal).toBe(0);
    expect(events[6].data.delta).toBe('so');
    expect(events[7].data).toMatchObject({ ordinal: 0, text: 'ho' });
    expect(events[8].data).toMatchObject({ ordinal: 0, text: 'pienso' });
    expect(events.every((event) => event.location?.directory === '/repo')).toBe(true);
  });

  it('announces a tool before its transitions and settles it once', () => {
    const { events, translate, types } = translatorWithLog();
    const tool = (state) => ({ id: 'msg_x_tool_c1', sessionID: 's1', messageID: 'msg_x', type: 'tool', callID: 'c1', tool: 'Bash', state });

    translate({ type: 'message.updated', properties: { info: { id: 'msg_x', sessionID: 's1', role: 'assistant' } } });
    translate({ type: 'message.part.updated', properties: { part: tool({ status: 'running', input: { command: 'ls' } }) } });
    translate({ type: 'message.part.updated', properties: { part: tool({ status: 'completed', input: { command: 'ls' }, output: 'a\nb' }) } });
    translate({ type: 'message.part.updated', properties: { part: tool({ status: 'completed', input: { command: 'ls' }, output: 'a\nb' }) } });

    expect(types()).toEqual(['session.step.started', 'session.tool.input.started', 'session.tool.called', 'session.tool.success']);
    expect(events[2].data).toMatchObject({ id: 'c1', input: { command: 'ls' }, executed: true });
    expect(events[3].data.content).toEqual([{ type: 'text', text: 'a\nb' }]);
  });

  it('reports a failed tool with its error', () => {
    const { events, translate } = translatorWithLog();

    translate({ type: 'message.updated', properties: { info: { id: 'msg_x', sessionID: 's1', role: 'assistant' } } });
    translate({ type: 'message.part.updated', properties: { part: { id: 't', sessionID: 's1', messageID: 'msg_x', type: 'tool', callID: 'c1', tool: 'Read', state: { status: 'error', input: {}, error: 'boom' } } } });

    expect(events.at(-1)).toMatchObject({ type: 'session.tool.failed', data: { id: 'c1', error: { message: 'boom' } } });
  });

  it('makes a user record burst one inbox event under the record id', async () => {
    const { events, translate, types } = translatorWithLog();

    translate({ type: 'message.updated', properties: { info: { id: 'msg_client', sessionID: 's1', role: 'user' }, directory: '/repo' } });
    translate({ type: 'message.part.updated', properties: { part: { id: 'p0', sessionID: 's1', messageID: 'msg_client', type: 'text', text: 'hola' } } });
    translate({ type: 'message.part.updated', properties: { part: { id: 'p1', sessionID: 's1', messageID: 'msg_client', type: 'text', text: 'mundo' } } });
    expect(events).toEqual([]);
    await flush();

    expect(types()).toEqual(['session.inbox.enqueued', 'session.inbox.delivered']);
    expect(events[0].data).toEqual({
      sessionID: 'ses_cccs1',
      inboxID: 'msg_client',
      item: { type: 'user', payload: { text: 'hola\nmundo' }, delivery: 'queue' },
    });
  });

  it('closes a finished record read back from a transcript after its parts', async () => {
    const { translate, types } = translatorWithLog();

    translate({ type: 'message.updated', properties: { info: { id: 'msg_r', sessionID: 's1', role: 'assistant', time: { created: 5, completed: 9 } } } });
    translate({ type: 'message.part.updated', properties: { part: { id: 'r0', sessionID: 's1', messageID: 'msg_r', type: 'text', text: 'hecho' } } });
    await flush();

    expect(types()).toEqual(['session.step.started', 'session.text.started', 'session.text.delta', 'session.text.ended', 'session.step.ended']);
  });

  it('maps session lifecycle events', () => {
    const { events, translate } = translatorWithLog();

    translate({ type: 'session.created', properties: { info: { id: 's2', directory: '/repo', title: 'Nueva', time: { created: 1, updated: 1 } } } });
    translate({ type: 'session.updated', properties: { info: { id: 's2', directory: '/repo', title: 'Otra', time: { created: 1, updated: 2 }, metadata: { remoteControl: { url: 'https://claude.ai/code/x' } } } } });
    translate({ type: 'session.error', properties: { sessionID: 's2', error: { message: 'mal' } } });
    translate({ type: 'session.deleted', properties: { info: { id: 's2' } } });

    expect(events.map((event) => event.type)).toEqual([
      'session.created',
      'session.renamed',
      'session.metadata.updated',
      'session.execution.failed',
      'session.deleted',
    ]);
    expect(events[0].data).toMatchObject({ sessionID: 'ses_cccs2', location: { directory: '/repo' }, title: 'Nueva', agent: 'claude' });
    expect(events[2].data.metadata).toMatchObject({ backend: 'claude', remoteControl: { url: 'https://claude.ai/code/x' } });
    expect(events[3].data.error).toEqual({ type: 'ClaudeError', message: 'mal' });
    expect(events[4].data).toEqual({ sessionID: 'ses_cccs2' });
  });
});

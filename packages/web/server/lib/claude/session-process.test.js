import { describe, expect, it, vi } from 'vitest';
import nodeCrypto from 'crypto';

import { createClaudeSessionProcess, toCliContent } from './session-process.js';

/** A channel the fake CLI writes its output to. */
const createChannel = () => {
  const queued = [];
  const waiting = [];
  let ended = false;
  return {
    push(value) {
      const next = waiting.shift();
      if (next) next({ value, done: false });
      else queued.push(value);
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
      };
    },
  };
};

/**
 * A CLI that stays up across prompts, like the real one with a streamed
 * prompt: it echoes each prompt (`--replay-user-messages`), answers it and
 * closes the turn with `result`.
 */
const makeInteractiveSdk = () => {
  const handles = [];
  const sdk = {
    query: vi.fn(({ prompt }) => {
      const output = createChannel();
      (async () => {
        let turn = 0;
        for await (const message of prompt) {
          turn += 1;
          output.push({ ...message, isReplay: true });
          output.push({ type: 'assistant', message: { id: `api_${turn}`, content: [{ type: 'text', text: `answer ${turn}` }] } });
          output.push({ type: 'result', is_error: false });
        }
        output.end();
      })();
      const handle = Object.assign(output, {
        interrupt: vi.fn(async () => {}),
        close: vi.fn(() => output.end()),
        setModel: vi.fn(async () => {}),
        setPermissionMode: vi.fn(async () => {}),
        enableRemoteControl: vi.fn(async () => ({
          session_url: 'https://claude.ai/code/session_1',
          bridge_session_id: 'cse_1',
        })),
      });
      handles.push(handle);
      return handle;
    }),
  };
  return { sdk, handles };
};

const createProcess = (overrides = {}) => {
  const { sdk, handles } = overrides.sdkBundle || makeInteractiveSdk();
  const events = [];
  const statuses = [];
  const remotePrompts = [];
  const proc = createClaudeSessionProcess({
    sdk,
    sessionId: 'sess-1',
    directory: '/repo',
    options: { permissionMode: 'default', effort: 'high' },
    model: 'sonnet',
    emit: (payload) => events.push(payload),
    setStatus: (status) => statuses.push(status.type),
    onRemotePrompt: (text) => remotePrompts.push(text),
    createUuid: () => nodeCrypto.randomUUID(),
    ...overrides.dependencies,
  });
  return { proc, sdk, handles, events, statuses, remotePrompts };
};

const textParts = (events) => events
  .filter((payload) => payload.type === 'message.part.updated' && payload.properties.part.type === 'text')
  .map((payload) => payload.properties.part);

describe('claude session process', () => {
  it('keeps one CLI process across turns', async () => {
    const { proc, sdk, events, statuses } = createProcess();

    await expect(proc.send([{ type: 'text', text: 'one' }])).resolves.toEqual({ ok: true });
    await expect(proc.send([{ type: 'text', text: 'two' }])).resolves.toEqual({ ok: true });

    expect(sdk.query).toHaveBeenCalledTimes(1);
    expect(textParts(events).map((part) => part.text).filter(Boolean)).toEqual(['answer 1', 'answer 2']);
    expect(statuses).toEqual(['busy', 'idle', 'busy', 'idle']);
    expect(proc.hasExited()).toBe(false);
    await proc.close();
  });

  it('does not re-render its own prompt when the CLI echoes it', async () => {
    const { proc, remotePrompts } = createProcess();
    await proc.send([{ type: 'text', text: 'mine' }]);
    expect(remotePrompts).toEqual([]);
    await proc.close();
  });

  it('renders a prompt typed on another surface and treats its answer as a turn', async () => {
    const { proc, handles, statuses, remotePrompts, events } = createProcess();
    await vi.waitFor(() => expect(handles).toHaveLength(1));

    handles[0].push({ type: 'user', uuid: 'from-claude-ai', parent_tool_use_id: null, isReplay: true, message: { role: 'user', content: 'desde el movil' } });
    handles[0].push({ type: 'assistant', message: { id: 'api_remote', content: [{ type: 'text', text: 'hecho' }] } });
    handles[0].push({ type: 'result', is_error: false });

    await vi.waitFor(() => expect(statuses).toEqual(['busy', 'idle']));
    expect(remotePrompts).toEqual(['desde el movil']);
    expect(textParts(events).at(-1).text).toBe('hecho');
    await proc.close();
  });

  it('queues a prompt sent during a turn and answers it as the next turn', async () => {
    const { proc, sdk, statuses, events } = createProcess();
    const first = proc.send([{ type: 'text', text: 'one' }]);
    const second = proc.send([{ type: 'text', text: 'two' }]);

    await expect(first).resolves.toEqual({ ok: true });
    await expect(second).resolves.toEqual({ ok: true });

    expect(sdk.query).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual(['busy', 'idle', 'busy', 'idle']);
    expect(textParts(events).map((part) => part.text).filter(Boolean)).toEqual(['answer 1', 'answer 2']);
    await proc.close();
  });

  it('ends a prompt the CLI folded into the running turn together with that turn', async () => {
    const bundle = makeInteractiveSdk();
    // A CLI that takes every queued prompt into the turn already running.
    bundle.sdk.query = vi.fn(({ prompt }) => {
      const output = createChannel();
      (async () => {
        const iterator = prompt[Symbol.asyncIterator]();
        const one = (await iterator.next()).value;
        const two = (await iterator.next()).value;
        output.push({ ...one, isReplay: true });
        output.push({ ...two, isReplay: true });
        output.push({ type: 'assistant', message: { id: 'api_1', content: [{ type: 'text', text: 'both' }] } });
        output.push({ type: 'result', is_error: false });
      })();
      const handle = Object.assign(output, { interrupt: vi.fn(async () => {}), close: vi.fn(() => output.end()) });
      bundle.handles.push(handle);
      return handle;
    });
    const { proc, statuses } = createProcess({ sdkBundle: bundle });

    const first = proc.send([{ type: 'text', text: 'one' }]);
    const second = proc.send([{ type: 'text', text: 'two' }]);
    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(statuses).toEqual(['busy', 'idle']);
    await proc.close();
  });

  it('enables Remote Control on its own process and reports the link', async () => {
    const onRemoteControl = vi.fn();
    const { proc, handles } = createProcess({
      dependencies: { remoteControl: { name: 'Mi sesion' }, onRemoteControl },
    });

    await vi.waitFor(() => expect(onRemoteControl).toHaveBeenCalledTimes(1));
    expect(handles[0].enableRemoteControl).toHaveBeenCalledWith(true, 'Mi sesion');
    expect(proc.remoteControl()).toEqual({ url: 'https://claude.ai/code/session_1', bridgeSessionId: 'cse_1' });
    await proc.close();
  });

  it('leaves Remote Control off unless asked', async () => {
    const { proc, handles } = createProcess();
    await vi.waitFor(() => expect(handles).toHaveLength(1));
    expect(handles[0].enableRemoteControl).not.toHaveBeenCalled();
    await proc.close();
  });

  it('changes model and permission mode on the live process', async () => {
    const { proc, handles } = createProcess();
    await proc.applyModel('opus');
    await proc.applyModel('opus');
    await proc.applyPermissionMode('plan');
    expect(handles[0].setModel).toHaveBeenCalledTimes(1);
    expect(handles[0].setModel).toHaveBeenCalledWith('opus');
    expect(handles[0].setPermissionMode).toHaveBeenCalledWith('plan');
    await proc.close();
  });

  it('interrupting ends the turn but keeps the process', async () => {
    const bundle = makeInteractiveSdk();
    // A CLI that never answers, so the turn stays open until interrupted.
    bundle.sdk.query = vi.fn(() => {
      const output = createChannel();
      const handle = Object.assign(output, { interrupt: vi.fn(async () => {}), close: vi.fn(() => output.end()) });
      bundle.handles.push(handle);
      return handle;
    });
    const { proc, statuses } = createProcess({ sdkBundle: bundle });

    const turn = proc.send([{ type: 'text', text: 'long' }]);
    await proc.interrupt();

    await expect(turn).resolves.toEqual({ ok: true });
    expect(bundle.handles[0].interrupt).toHaveBeenCalled();
    expect(statuses).toEqual(['busy', 'idle']);
    expect(proc.hasExited()).toBe(false);
    await proc.close();
  });

  it('reports exit once the CLI stream ends', async () => {
    const onExit = vi.fn();
    const { proc } = createProcess({ dependencies: { onExit } });
    await proc.close();
    await proc.exited;
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(proc.hasExited()).toBe(true);
    await expect(proc.send([{ type: 'text', text: 'late' }])).rejects.toThrow(/exited/);
  });
});

/** A CLI that answers the first prompt with a fixed script of messages. */
const makeScriptedSdk = (script) => {
  const handles = [];
  const sdk = {
    query: vi.fn(({ prompt }) => {
      const output = createChannel();
      (async () => {
        for await (const message of prompt) {
          output.push({ ...message, isReplay: true });
          for (const entry of script) output.push(entry);
          output.push({ type: 'result', is_error: false, ...(script.result || {}) });
        }
        output.end();
      })();
      const handle = Object.assign(output, {
        interrupt: vi.fn(async () => {}),
        close: vi.fn(() => output.end()),
        stopTask: vi.fn(async () => {}),
        setPermissionMode: vi.fn(async () => {}),
      });
      handles.push(handle);
      return handle;
    }),
  };
  return { sdk, handles };
};

const toolUpdates = (events) => events
  .filter((payload) => payload.type === 'message.part.updated' && payload.properties.part.type === 'tool')
  .map((payload) => payload.properties.part);

describe('claude session process — Claude Code parity', () => {
  it('shows tool calls under OpenCode names, with the exact diff once the result is in', async () => {
    const script = [
      { type: 'assistant', message: { id: 'api_1', content: [{ type: 'tool_use', id: 'toolu_e', name: 'Edit', input: { file_path: '/repo/a.js', old_string: 'x', new_string: 'y' } }] } },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_e', content: 'ok' }] },
        tool_use_result: { structuredPatch: [{ oldStart: 7, oldLines: 1, newStart: 7, newLines: 1, lines: ['-x', '+y'] }] },
      },
    ];
    const { proc, events } = createProcess({ sdkBundle: makeScriptedSdk(script) });
    await proc.send([{ type: 'text', text: 'edit it' }]);

    const updates = toolUpdates(events);
    expect(updates[0]).toMatchObject({ tool: 'edit', state: { status: 'running', input: { filePath: '/repo/a.js' } } });
    expect(updates[0].state.metadata.files[0].patch).toContain('@@ -1,1 +1,1 @@');
    const done = updates.at(-1);
    expect(done).toMatchObject({ tool: 'edit', state: { status: 'completed', output: 'ok' } });
    expect(done.state.metadata.files[0].patch).toContain('@@ -7,1 +7,1 @@');
    // The raw Claude call the part was mapped from never leaves the process.
    expect(updates.every((part) => !('rawName' in part) && !('rawInput' in part))).toBe(true);
    await proc.close();
  });

  it('keeps a subagent out of the answer and links its call to the child session', async () => {
    const onSubagentStarted = vi.fn();
    const onSubagentEnded = vi.fn();
    const script = [
      { type: 'assistant', message: { id: 'api_1', content: [{ type: 'tool_use', id: 'toolu_a', name: 'Agent', input: { subagent_type: 'Explore', description: 'Find it', prompt: 'look' } }] } },
      { type: 'system', subtype: 'task_started', task_id: 'ag1', tool_use_id: 'toolu_a', description: 'Find it', subagent_type: 'Explore' },
      { type: 'stream_event', parent_tool_use_id: 'toolu_a', event: { type: 'message_start', message: { id: 'api_sub', usage: { input_tokens: 99 } } } },
      { type: 'user', parent_tool_use_id: 'toolu_a', uuid: 'sub-prompt', message: { content: 'look' } },
      { type: 'assistant', parent_tool_use_id: 'toolu_a', message: { id: 'api_sub', content: [{ type: 'text', text: 'inner work' }] } },
      { type: 'assistant', parent_tool_use_id: 'toolu_a', message: { id: 'api_sub', content: [{ type: 'tool_use', id: 'toolu_inner', name: 'Grep', input: { pattern: 'x' } }] } },
      { type: 'user', parent_tool_use_id: 'toolu_a', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_inner', content: 'x' }] } },
      { type: 'assistant', parent_tool_use_id: 'toolu_unknown', message: { id: 'api_lost', content: [{ type: 'text', text: 'orphan' }] } },
      { type: 'system', subtype: 'task_notification', task_id: 'ag1', status: 'completed', summary: 'found' },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'report' }] },
        tool_use_result: { agentId: 'ag1', status: 'completed' },
      },
    ];
    const { proc, events } = createProcess({
      sdkBundle: makeScriptedSdk(script),
      dependencies: { childSessionId: (agentId) => `pub~${agentId}`, onSubagentStarted, onSubagentEnded },
    });
    await proc.send([{ type: 'text', text: 'delegate' }]);

    // The subagent's own work streams into its child session, never the parent's answer.
    const parentTexts = textParts(events).filter((part) => part.sessionID === 'sess-1').map((part) => part.text);
    expect(parentTexts).not.toContain('inner work');
    const childTexts = textParts(events).filter((part) => part.sessionID === 'sess-1~ag1').map((part) => part.text);
    expect(childTexts).toContain('inner work');
    const childInfos = events.filter((payload) => payload.type === 'message.updated' && payload.properties.info.id === 'msg_api_sub');
    expect(childInfos.length).toBeGreaterThan(0);
    expect(childInfos.every((payload) => payload.properties.info.sessionID === 'sess-1~ag1')).toBe(true);
    const updates = toolUpdates(events).filter((part) => part.sessionID === 'sess-1');
    expect(updates[0]).toMatchObject({ tool: 'subagent', state: { status: 'running', input: { agent: 'Explore', description: 'Find it' } } });
    expect(updates[1].state.metadata).toEqual({ sessionID: 'pub~ag1' });
    expect(updates.at(-1)).toMatchObject({ state: { status: 'completed', output: 'report', metadata: { sessionID: 'pub~ag1' } } });
    // Its prompt is not replayed live (the transcript read has it under its own id).
    expect(textParts(events).some((part) => part.messageID === 'msg_sub-prompt')).toBe(false);
    // Its own calls settle in the child session.
    const childTool = toolUpdates(events).filter((part) => part.sessionID === 'sess-1~ag1');
    expect(childTool.at(-1)).toMatchObject({ tool: 'grep', state: { status: 'completed', output: 'x' } });
    // A frame no task_started linked is dropped, not shown in the parent.
    expect(textParts(events).some((part) => part.text === 'orphan')).toBe(false);
    expect(onSubagentStarted).toHaveBeenCalledWith({ agentId: 'ag1', toolUseId: 'toolu_a', description: 'Find it', agentType: 'Explore' });
    expect(onSubagentEnded).toHaveBeenCalledWith({ agentId: 'ag1', status: 'completed' });
    await proc.close();
  });

  it('publishes token usage as it streams, with the cache lifetime and context window it implies', async () => {
    const onUsage = vi.fn();
    const usage = { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 50, cache_creation: { ephemeral_1h_input_tokens: 50, ephemeral_5m_input_tokens: 0 } };
    const script = [
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'api_1', usage } } },
      { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 7 } } },
      { type: 'assistant', message: { id: 'api_1', content: [{ type: 'text', text: 'hi' }], usage: { ...usage, output_tokens: 7 } } },
    ];
    script.result = { modelUsage: { 'claude-opus': { contextWindow: 200000 } } };
    const { proc, events } = createProcess({ sdkBundle: makeScriptedSdk(script), dependencies: { onUsage } });
    await proc.send([{ type: 'text', text: 'hello' }]);

    const withTokens = events.filter((payload) => payload.type === 'message.updated' && payload.properties.info.tokens);
    expect(withTokens.at(-1).properties.info.tokens).toEqual({ input: 10, output: 7, reasoning: 0, cache: { read: 100, write: 50 } });
    // Counted once per API message, not once per content block.
    expect(new Set(withTokens.map((payload) => payload.properties.info.id))).toEqual(new Set(['msg_api_1']));
    expect(onUsage).toHaveBeenCalledWith({ cacheTtlMs: 3600000 });
    expect(onUsage).toHaveBeenCalledWith({ contextWindow: 200000 });
    await proc.close();
  });

  it('follows a mode the CLI switched to by itself (/plan, an approved plan)', async () => {
    const onModeReported = vi.fn();
    const script = [
      { type: 'system', subtype: 'init', permissionMode: 'default' },
      { type: 'system', subtype: 'status', status: null, permissionMode: 'plan' },
    ];
    const bundle = makeScriptedSdk(script);
    const { proc, handles } = createProcess({ sdkBundle: bundle, dependencies: { onModeReported } });
    await proc.send([{ type: 'text', text: '/plan' }]);
    expect(onModeReported).toHaveBeenCalledTimes(1);
    expect(onModeReported).toHaveBeenCalledWith('plan');
    expect(proc.permissionMode()).toBe('plan');
    // The menu's next pick of Manual is sent, not skipped as "already there".
    await proc.applyPermissionMode('default');
    expect(handles[0].setPermissionMode).toHaveBeenCalledWith('default');
    await proc.close();
  });

  it('stops one subagent and keeps its own idea of the mode after a plan approval', async () => {
    const bundle = makeScriptedSdk([]);
    const { proc, handles } = createProcess({ sdkBundle: bundle });
    await proc.send([{ type: 'text', text: 'go' }]);
    await expect(proc.stopTask('ag1')).resolves.toBe(true);
    expect(handles[0].stopTask).toHaveBeenCalledWith('ag1');

    proc.notePermissionMode('acceptEdits');
    expect(proc.permissionMode()).toBe('acceptEdits');
    // Already there: no second switch is sent to the CLI.
    await proc.applyPermissionMode('acceptEdits');
    expect(handles[0].setPermissionMode).not.toHaveBeenCalled();
    await proc.applyPermissionMode('plan');
    expect(handles[0].setPermissionMode).toHaveBeenCalledWith('plan');
    await proc.close();
    await proc.exited;
    await expect(proc.stopTask('ag1')).resolves.toBe(false);
  });
});

describe('toCliContent', () => {
  it('sends a command as the plain string Claude Code parses', () => {
    expect(toCliContent([{ type: 'text', text: '/compact' }], { asCommand: true })).toBe('/compact');
    expect(toCliContent([{ type: 'text', text: '/review src\n\nctx' }], { asCommand: true })).toBe('/review src\n\nctx');
  });

  it('keeps blocks for a prompt, even one starting with a slash: prose is never parsed as a command', () => {
    const path = [{ type: 'text', text: '/usr/local/bin/node --version shows 18, why?' }];
    expect(toCliContent(path)).toBe(path);
    expect(toCliContent(path, { asCommand: false })).toBe(path);
  });

  it('keeps blocks when a command somehow carries a non-text block', () => {
    const withImage = [{ type: 'text', text: '/review' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } }];
    expect(toCliContent(withImage, { asCommand: true })).toBe(withImage);
  });
});

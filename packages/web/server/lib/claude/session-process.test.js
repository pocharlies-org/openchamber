import { describe, expect, it, vi } from 'vitest';
import nodeCrypto from 'crypto';

import { createClaudeSessionProcess } from './session-process.js';

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

  it('refuses a second prompt while a turn is running', async () => {
    const { proc } = createProcess();
    const first = proc.send([{ type: 'text', text: 'one' }]);
    await expect(proc.send([{ type: 'text', text: 'two' }])).rejects.toThrow(/already running/);
    await first;
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

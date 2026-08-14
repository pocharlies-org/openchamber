import { describe, expect, test } from 'bun:test';
import type { Event, Message, Part } from '@opencode-ai/sdk/v2/client';
import {
  getLatestCompletedAssistantMessage,
  StreamMetricsTracker,
  type StreamMetricIdentity,
  type StreamMetricSnapshot,
} from './stream-metrics';

const identity: StreamMetricIdentity = {
  runtimeKey: 'runtime-a',
  directory: '/repo',
  sessionId: 'ses_1',
};

const begin = (tracker: StreamMetricsTracker, target = identity) => tracker.begin({
  ...target,
  turnId: 'msg_user_1',
  userMessageId: 'msg_user_1',
  providerId: 'provider-a',
  modelId: 'model-a',
});

const delta = (
  id: string,
  value: string,
  field = 'text',
  target = identity,
  messageID = 'msg_assistant_1',
  partID = 'prt_1',
): Event => ({
  id,
  type: 'message.part.delta',
  properties: { sessionID: target.sessionId, messageID, partID, field, delta: value },
}) as Event;

const partUpdated = (id: string, part: Part, target = identity): Event => ({
  id,
  type: 'message.part.updated',
  properties: { sessionID: target.sessionId, part, time: 0 },
}) as Event;

const textPart = (text: string, type: 'text' | 'reasoning' = 'text', id = 'prt_1'): Part => ({
  id,
  sessionID: identity.sessionId,
  messageID: 'msg_assistant_1',
  type,
  text,
  ...(type === 'reasoning' ? { time: { start: 0 } } : {}),
}) as Part;

const toolPart = (status: 'pending' | 'running'): Part => ({
  id: 'prt_tool',
  sessionID: identity.sessionId,
  messageID: 'msg_assistant_1',
  type: 'tool',
  callID: 'call_1',
  tool: 'read',
  state: status === 'pending'
    ? { status, input: {}, raw: '' }
    : { status, input: {}, title: 'Reading', metadata: {}, time: { start: 0 } },
}) as Part;

const assistantUpdated = (id: string, options: {
  completed?: number;
  output?: number;
  error?: boolean;
  parentID?: string;
  messageID?: string;
} = {}): Event => ({
  id,
  type: 'message.updated',
  properties: {
    sessionID: identity.sessionId,
    info: {
      id: options.messageID ?? 'msg_assistant_1',
      sessionID: identity.sessionId,
      role: 'assistant',
      parentID: options.parentID ?? 'msg_user_1',
      modelID: 'model-final',
      providerID: 'provider-final',
      mode: 'build',
      agent: 'agent',
      path: { cwd: '/repo', root: '/repo' },
      cost: 0,
      time: { created: 0, ...(options.completed === undefined ? {} : { completed: options.completed }) },
      ...(options.completed === undefined ? {} : { finish: 'stop' }),
      ...(options.error ? { error: { name: 'UnknownError', data: { message: 'failed' } } } : {}),
      tokens: {
        input: 120,
        output: options.output ?? 40,
        reasoning: 7,
        cache: { read: 11, write: 3 },
      },
    },
  },
}) as Event;

const lifecycle = (id: string, type: 'session.idle' | 'session.error', target = identity): Event => ({
  id,
  type,
  properties: { sessionID: target.sessionId },
}) as Event;

const expectMetric = (
  actual: StreamMetricSnapshot | null,
  expected: Partial<Omit<StreamMetricSnapshot, 'tokens'>> & { tokens?: Partial<StreamMetricSnapshot['tokens']> },
) => {
  expect(actual).not.toBeNull();
  for (const [key, value] of Object.entries(expected)) {
    if (key === 'tokens') {
      for (const [tokenKey, tokenValue] of Object.entries(value ?? {})) {
        expect(actual?.tokens[tokenKey as keyof StreamMetricSnapshot['tokens']]).toBe(tokenValue);
      }
      continue;
    }
    expect(actual?.[key as keyof StreamMetricSnapshot]).toBe(value);
  }
};

const createHarness = () => {
  let now = 0;
  let nextHandle = 1;
  const scheduled = new Map<number, { callback: () => void; dueAt: number }>();
  const tracker = new StreamMetricsTracker({
    now: () => now,
    schedule: (callback, delayMs) => {
      const handle = nextHandle++ as unknown as ReturnType<typeof setTimeout>;
      scheduled.set(handle as unknown as number, { callback, dueAt: now + delayMs });
      return handle;
    },
    cancelSchedule: (handle) => { scheduled.delete(handle as unknown as number); },
  });
  tracker.setEnabled(true, 250);
  return {
    tracker,
    setNow(value: number) { now = value; },
    runDue() {
      for (const [handle, task] of [...scheduled].sort((a, b) => a[1].dueAt - b[1].dueAt)) {
        if (task.dueAt > now) continue;
        scheduled.delete(handle);
        task.callback();
      }
    },
    scheduledCount: () => scheduled.size,
  };
};

describe('StreamMetricsTracker', () => {
  test('hydrates exact counters from the latest completed assistant message loaded by web', () => {
    const { tracker } = createHarness();
    const olderEvent = assistantUpdated('evt_older', { completed: 900, output: 12 });
    const latestEvent = assistantUpdated('evt_latest', {
      completed: 1_200,
      output: 40,
      messageID: 'msg_assistant_2',
    });
    const older = (olderEvent as Extract<Event, { type: 'message.updated' }>).properties.info;
    const latest = (latestEvent as Extract<Event, { type: 'message.updated' }>).properties.info;
    const messages = [
      { id: 'msg_user_1', sessionID: identity.sessionId, role: 'user', time: { created: 0 } } as Message,
      older,
      { id: 'msg_user_2', sessionID: identity.sessionId, role: 'user', time: { created: 1_000 } } as Message,
      latest,
    ];

    const completed = getLatestCompletedAssistantMessage(messages);
    expect(completed?.id).toBe('msg_assistant_2');
    tracker.hydrateCompleted(identity, completed!);

    expectMetric(tracker.getSnapshot(identity), {
      assistantMessageId: 'msg_assistant_2',
      status: 'completed',
      exact: true,
      ttftMs: null,
      durationMs: null,
      speedTokensPerSecond: null,
      tokens: { input: 120, output: 40, reasoning: 7, cacheRead: 11, cacheWrite: 3 },
      characters: 0,
      bytes: 0,
      modelId: 'model-final',
      providerId: 'provider-final',
    });
  });

  test('loaded history cannot replace a live turn started by this client', () => {
    const { tracker } = createHarness();
    begin(tracker);
    const historyEvent = assistantUpdated('evt_history', { completed: 900 });
    const history = (historyEvent as Extract<Event, { type: 'message.updated' }>).properties.info;
    tracker.hydrateCompleted(identity, history);

    expectMetric(tracker.getSnapshot(identity), {
      turnId: 'msg_user_1',
      status: 'live',
      exact: false,
      assistantMessageId: null,
    });
  });

  test('starts the TTFT clock at accepted send and ignores empty activity', () => {
    const { tracker, setNow } = createHarness();
    setNow(100);
    begin(tracker);
    setNow(250);
    tracker.ingest(identity.runtimeKey, identity.directory, delta('evt_empty', ''));
    tracker.ingest(identity.runtimeKey, identity.directory, partUpdated('evt_pending', toolPart('pending')));
    tracker.flush();
    expect(tracker.getSnapshot(identity)?.ttftMs).toBeNull();

    setNow(620);
    tracker.ingest(identity.runtimeKey, identity.directory, delta('evt_visible', 'hello'));
    setNow(900);
    tracker.ingest(identity.runtimeKey, identity.directory, delta('evt_later', ' world'));
    tracker.flush();
    expect(tracker.getSnapshot(identity)?.ttftMs).toBe(520);
  });

  const firstVisibleCases: Array<[string, Part]> = [
    ['text', textPart('visible')],
    ['reasoning', textPart('thinking', 'reasoning')],
    ['running tool', toolPart('running')],
  ];
  for (const [label, part] of firstVisibleCases) {
    test(`${label} content can establish TTFT exactly once`, () => {
      const { tracker, setNow } = createHarness();
      begin(tracker);
      setNow(125);
      tracker.ingest(identity.runtimeKey, identity.directory, partUpdated('evt_first', part));
      setNow(400);
      tracker.ingest(identity.runtimeKey, identity.directory, delta('evt_second', 'later', 'text', identity, 'msg_assistant_1', 'prt_2'));
      tracker.flush();
      expect(tracker.getSnapshot(identity)?.ttftMs).toBe(125);
    });
  }

  test('publishes estimated live counts, then authoritative final counters and speed', () => {
    const { tracker, setNow } = createHarness();
    begin(tracker);
    setNow(200);
    tracker.ingest(identity.runtimeKey, identity.directory, delta('evt_text', '12345678'));
    setNow(1_200);
    tracker.flush();
    expectMetric(tracker.getSnapshot(identity), {
      exact: false,
      ttftMs: 200,
      tokens: { output: 2 },
      characters: 8,
      bytes: 8,
    });
    expect(tracker.getSnapshot(identity)?.speedTokensPerSecond).toBe(2);

    tracker.ingest(identity.runtimeKey, identity.directory, assistantUpdated('evt_final', { completed: 1_200, output: 40 }));
    tracker.flush();
    expectMetric(tracker.getSnapshot(identity), {
      status: 'completed',
      exact: true,
      durationMs: 1_200,
      speedTokensPerSecond: 40,
      tokens: { input: 120, output: 40, reasoning: 7, cacheRead: 11, cacheWrite: 3 },
      modelId: 'model-final',
      providerId: 'provider-final',
    });
  });

  test('accepts authoritative counters that arrive after idle', () => {
    const { tracker, setNow } = createHarness();
    begin(tracker);
    setNow(100);
    tracker.ingest(identity.runtimeKey, identity.directory, delta('evt_text', 'hello'));
    setNow(600);
    tracker.ingest(identity.runtimeKey, identity.directory, lifecycle('evt_idle', 'session.idle'));
    setNow(700);
    tracker.ingest(identity.runtimeKey, identity.directory, assistantUpdated('evt_final', { output: 25 }));
    tracker.flush();
    expectMetric(tracker.getSnapshot(identity), {
      status: 'completed',
      exact: true,
      durationMs: 600,
      speedTokensPerSecond: 50,
      tokens: { output: 25 },
    });
  });

  test('settles cancellation and error without losing their final state', () => {
    const cancelled = createHarness();
    begin(cancelled.tracker);
    cancelled.setNow(300);
    cancelled.tracker.finish(identity, 'cancelled');
    cancelled.tracker.flush();
    expectMetric(cancelled.tracker.getSnapshot(identity), { status: 'cancelled', durationMs: 300 });

    const failed = createHarness();
    begin(failed.tracker);
    failed.setNow(450);
    failed.tracker.ingest(identity.runtimeKey, identity.directory, lifecycle('evt_error', 'session.error'));
    failed.setNow(500);
    failed.tracker.ingest(identity.runtimeKey, identity.directory, assistantUpdated('evt_late_final', { output: 12 }));
    failed.tracker.flush();
    expectMetric(failed.tracker.getSnapshot(identity), { status: 'error', durationMs: 450, exact: true });
  });

  test('deduplicates event IDs and ignores stale full-part snapshots', () => {
    const { tracker } = createHarness();
    begin(tracker);
    tracker.ingest(identity.runtimeKey, identity.directory, delta('evt_1', 'hello'));
    tracker.ingest(identity.runtimeKey, identity.directory, delta('evt_1', 'hello'));
    tracker.ingest(identity.runtimeKey, identity.directory, partUpdated('evt_2', textPart('hello world')));
    tracker.ingest(identity.runtimeKey, identity.directory, partUpdated('evt_3', textPart('hello')));
    tracker.flush();
    expectMetric(tracker.getSnapshot(identity), { characters: 11, bytes: 11, tokens: { output: 3 } });
  });

  test('does not infer duplicate deltas from repeated text', () => {
    const { tracker } = createHarness();
    begin(tracker);
    tracker.ingest(identity.runtimeKey, identity.directory, delta('evt_1', 'x'));
    tracker.ingest(identity.runtimeKey, identity.directory, delta('evt_2', 'x'));
    tracker.flush();
    expectMetric(tracker.getSnapshot(identity), { characters: 2, bytes: 2, tokens: { output: 1 } });
  });

  test('keeps UTF-8 byte counts exact when a surrogate pair is split across deltas', () => {
    const { tracker } = createHarness();
    begin(tracker);
    tracker.ingest(identity.runtimeKey, identity.directory, delta('evt_1', '\uD83D'));
    tracker.ingest(identity.runtimeKey, identity.directory, delta('evt_2', '\uDE00'));
    tracker.flush();
    expectMetric(tracker.getSnapshot(identity), { characters: 2, bytes: 4 });
  });

  test('updates counters incrementally when a part is replaced or removed', () => {
    const { tracker } = createHarness();
    begin(tracker);
    tracker.ingest(identity.runtimeKey, identity.directory, partUpdated('evt_1', textPart('hello')));
    tracker.ingest(identity.runtimeKey, identity.directory, partUpdated('evt_2', textPart('thinking', 'reasoning', 'prt_2')));
    tracker.ingest(identity.runtimeKey, identity.directory, partUpdated('evt_3', textPart('hello world')));
    tracker.ingest(identity.runtimeKey, identity.directory, {
      id: 'evt_4',
      type: 'message.part.removed',
      properties: { sessionID: identity.sessionId, messageID: 'msg_assistant_1', partID: 'prt_2' },
    } as Event);
    tracker.flush();
    expectMetric(tracker.getSnapshot(identity), { characters: 11, bytes: 11, tokens: { output: 3 } });
  });

  test('keeps reasoning deltas out of the live output-token estimate', () => {
    const { tracker } = createHarness();
    begin(tracker);
    tracker.ingest(identity.runtimeKey, identity.directory, partUpdated('evt_1', textPart('', 'reasoning')));
    tracker.ingest(identity.runtimeKey, identity.directory, delta('evt_2', 'thinking', 'text'));
    tracker.flush();
    expectMetric(tracker.getSnapshot(identity), { characters: 8, tokens: { output: 0 } });
  });

  test('retains the last completed measurement while a new turn is live', () => {
    const { tracker, setNow } = createHarness();
    begin(tracker);
    setNow(100);
    tracker.ingest(identity.runtimeKey, identity.directory, delta('evt_1', 'first'));
    setNow(500);
    tracker.ingest(identity.runtimeKey, identity.directory, lifecycle('evt_idle', 'session.idle'));
    tracker.flush();
    const completed = tracker.getLastCompletedSnapshot(identity);
    expectMetric(completed, { status: 'completed', characters: 5 });

    setNow(800);
    tracker.begin({ ...identity, turnId: 'msg_user_2', userMessageId: 'msg_user_2' });
    expectMetric(tracker.getSnapshot(identity), { status: 'live', characters: 0 });
    expect(tracker.getLastCompletedSnapshot(identity)).toBe(completed);
  });

  test('does not let late deltas from the previous turn establish the new turn TTFT', () => {
    const { tracker, setNow } = createHarness();
    begin(tracker);
    setNow(100);
    tracker.ingest(identity.runtimeKey, identity.directory, delta('evt_first_turn', 'first'));
    setNow(500);
    tracker.ingest(identity.runtimeKey, identity.directory, lifecycle('evt_idle', 'session.idle'));

    setNow(700);
    tracker.begin({ ...identity, turnId: 'msg_user_2', userMessageId: 'msg_user_2' });
    setNow(750);
    tracker.ingest(identity.runtimeKey, identity.directory, delta('evt_late', 'late'));
    tracker.flush();
    expectMetric(tracker.getSnapshot(identity), { ttftMs: null, characters: 0 });

    setNow(900);
    tracker.ingest(identity.runtimeKey, identity.directory, delta(
      'evt_new_turn',
      'new',
      'text',
      identity,
      'msg_assistant_2',
    ));
    tracker.flush();
    expectMetric(tracker.getSnapshot(identity), { ttftMs: 200, characters: 3 });
  });

  test('isolates runtime, normalized directory, and session identities', () => {
    const { tracker } = createHarness();
    begin(tracker);
    tracker.ingest('runtime-b', identity.directory, delta('evt_wrong_runtime', 'wrong'));
    tracker.ingest(identity.runtimeKey, '/other', delta('evt_wrong_dir', 'wrong'));
    tracker.ingest(identity.runtimeKey, identity.directory, delta('evt_right', 'right'));
    tracker.flush();
    expect(tracker.getSnapshot(identity)?.characters).toBe(5);
    expect(tracker.getSnapshot({ ...identity, directory: '/repo/' })?.characters).toBe(5);
    expect(tracker.getSnapshot({ ...identity, runtimeKey: 'runtime-b' })).toBeNull();
  });

  test('does not invent TTFT when observation starts in the middle of a response', () => {
    const { tracker, setNow } = createHarness();
    setNow(500);
    tracker.ingest(identity.runtimeKey, identity.directory, assistantUpdated('evt_message'));
    tracker.ingest(identity.runtimeKey, identity.directory, delta('evt_midstream', 'already running'));
    tracker.flush();
    expectMetric(tracker.getSnapshot(identity), { ttftMs: null, exact: false, characters: 15 });
  });

  test('does not treat echoed user-message parts as assistant visibility', () => {
    const { tracker, setNow } = createHarness();
    begin(tracker);
    setNow(100);
    tracker.ingest(identity.runtimeKey, identity.directory, delta(
      'evt_user_echo',
      'the prompt',
      'text',
      identity,
      'msg_user_1',
    ));
    tracker.flush();
    expectMetric(tracker.getSnapshot(identity), { ttftMs: null, characters: 0 });

    setNow(300);
    tracker.ingest(identity.runtimeKey, identity.directory, assistantUpdated('evt_assistant'));
    tracker.ingest(identity.runtimeKey, identity.directory, delta('evt_assistant_text', 'answer'));
    tracker.flush();
    expectMetric(tracker.getSnapshot(identity), { ttftMs: 300, characters: 6 });
  });

  test('does not create a mid-stream measurement from an unidentified part alone', () => {
    const { tracker } = createHarness();
    tracker.ingest(identity.runtimeKey, identity.directory, delta('evt_unknown_part', 'unknown role'));
    expect(tracker.getSnapshot(identity)).toBeNull();
  });

  test('invalidates live measurements and deletes session or message state', () => {
    const runtimeChange = createHarness();
    begin(runtimeChange.tracker);
    runtimeChange.tracker.invalidateLive(identity.runtimeKey);
    expect(runtimeChange.tracker.getSnapshot(identity)).toBeNull();

    const sessionDelete = createHarness();
    begin(sessionDelete.tracker);
    sessionDelete.tracker.ingest(identity.runtimeKey, identity.directory, {
      id: 'evt_delete', type: 'session.deleted', properties: { sessionID: identity.sessionId, info: { id: identity.sessionId } },
    } as Event);
    expect(sessionDelete.tracker.getSnapshot(identity)).toBeNull();

    const messageDelete = createHarness();
    begin(messageDelete.tracker);
    messageDelete.tracker.ingest(identity.runtimeKey, identity.directory, delta('evt_text', 'hello'));
    messageDelete.tracker.ingest(identity.runtimeKey, identity.directory, {
      id: 'evt_remove', type: 'message.removed', properties: { sessionID: identity.sessionId, messageID: 'msg_assistant_1' },
    } as Event);
    expect(messageDelete.tracker.getSnapshot(identity)).toBeNull();
  });

  test('coalesces UI notifications instead of publishing every delta', () => {
    const { tracker, setNow, runDue, scheduledCount } = createHarness();
    begin(tracker);
    let notifications = 0;
    const unsubscribe = tracker.subscribe(identity, () => { notifications += 1; });
    setNow(10);
    for (let index = 0; index < 100; index += 1) {
      tracker.ingest(identity.runtimeKey, identity.directory, delta(`evt_${index}`, 'x'));
    }
    expect(notifications).toBe(0);
    expect(scheduledCount()).toBe(1);
    setNow(250);
    runDue();
    expect(notifications).toBe(1);
    expect(tracker.getSnapshot(identity)?.characters).toBe(100);
    unsubscribe();
  });

  test('publishes only the session whose throttled snapshot is due', () => {
    const { tracker, setNow, runDue } = createHarness();
    const second = { ...identity, sessionId: 'ses_2' };
    begin(tracker, identity);
    setNow(100);
    begin(tracker, second);
    let firstNotifications = 0;
    let secondNotifications = 0;
    tracker.subscribe(identity, () => { firstNotifications += 1; });
    tracker.subscribe(second, () => { secondNotifications += 1; });
    setNow(110);
    tracker.ingest(identity.runtimeKey, identity.directory, delta('evt_first', 'a'));
    tracker.ingest(second.runtimeKey, second.directory, delta('evt_second', 'b', 'text', second));
    setNow(250);
    runDue();
    expect(firstNotifications).toBe(1);
    expect(secondNotifications).toBe(0);
    setNow(350);
    runDue();
    expect(secondNotifications).toBe(1);
  });
});

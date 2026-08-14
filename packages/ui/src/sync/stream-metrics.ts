import type { Event, Message, Part } from '@opencode-ai/sdk/v2/client';
import { subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';

export type StreamMetricStatus = 'live' | 'completed' | 'cancelled' | 'error';

export type StreamMetricIdentity = {
  runtimeKey: string;
  directory: string;
  sessionId: string;
};

export type StreamMetricSnapshot = StreamMetricIdentity & {
  turnId: string;
  assistantMessageId: string | null;
  status: StreamMetricStatus;
  exact: boolean;
  ttftMs: number | null;
  durationMs: number | null;
  speedTokensPerSecond: number | null;
  tokens: {
    input: number | null;
    output: number;
    reasoning: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
  };
  characters: number;
  bytes: number;
  modelId: string | null;
  providerId: string | null;
};

type PartCounter = {
  kind: 'text' | 'reasoning';
  text: string;
};

type MutableMetric = StreamMetricIdentity & {
  turnId: string;
  userMessageId: string | null;
  assistantMessageId: string | null;
  acceptedAt: number | null;
  firstVisibleAt: number | null;
  completedAt: number | null;
  status: StreamMetricStatus;
  exact: boolean;
  tokens: StreamMetricSnapshot['tokens'];
  characters: number;
  bytes: number;
  outputCharacters: number;
  estimatedOutputTokens: number;
  modelId: string | null;
  providerId: string | null;
  parts: Map<string, PartCounter>;
  ignoredAssistantMessageIds: Set<string>;
  processedEventIds: Set<string>;
  lastTouchedAt: number;
};

type TrackerOptions = {
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancelSchedule?: (handle: ReturnType<typeof setTimeout>) => void;
};

const DEFAULT_UPDATE_INTERVAL_MS = 250;
const MAX_SESSION_METRICS = 100;
const MAX_EVENT_IDS_PER_TURN = 2_048;
const encoder = typeof TextEncoder === 'undefined' ? null : new TextEncoder();

const normalizeDirectory = (directory: string): string => {
  const normalized = directory.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized || '/';
};

const identityKey = (identity: StreamMetricIdentity): string =>
  `${identity.runtimeKey}\u0000${normalizeDirectory(identity.directory)}\u0000${identity.sessionId}`;

const byteLength = (value: string): number => encoder?.encode(value).byteLength ?? value.length;
const estimatedTokens = (characters: number): number => characters <= 0 ? 0 : Math.max(1, Math.ceil(characters / 4));

const appendedByteLength = (existing: string, appended: string): number => {
  if (!appended) return 0;
  const previousLast = existing.charCodeAt(existing.length - 1);
  const nextFirst = appended.charCodeAt(0);
  const joinsSurrogatePair = previousLast >= 0xD800 && previousLast <= 0xDBFF
    && nextFirst >= 0xDC00 && nextFirst <= 0xDFFF;
  return byteLength(appended) - (joinsSurrogatePair ? 2 : 0);
};

const isAssistantMessage = (message: Message): message is Extract<Message, { role: 'assistant' }> =>
  message.role === 'assistant';

const isCompletedAssistantMessage = (
  message: Message,
): message is Extract<Message, { role: 'assistant' }> => isAssistantMessage(message)
  && (message.time.completed !== undefined || Boolean(message.finish) || Boolean(message.error));

export const getLatestCompletedAssistantMessage = (
  messages: readonly Message[],
): Extract<Message, { role: 'assistant' }> | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && isCompletedAssistantMessage(message)) return message;
  }
  return null;
};

const isVisiblePart = (part: Part): boolean => {
  if (part.type === 'text' || part.type === 'reasoning') return part.text.length > 0;
  return part.type === 'tool' && part.state.status !== 'pending';
};

const metricPart = (part: Part): { kind: PartCounter['kind']; text: string } | null => {
  if (part.type === 'text') return { kind: 'text', text: part.text };
  if (part.type === 'reasoning') return { kind: 'reasoning', text: part.text };
  return null;
};

export class StreamMetricsTracker {
  private readonly now: () => number;
  private readonly schedule: NonNullable<TrackerOptions['schedule']>;
  private readonly cancelSchedule: NonNullable<TrackerOptions['cancelSchedule']>;
  private readonly metrics = new Map<string, MutableMetric>();
  private readonly snapshots = new Map<string, StreamMetricSnapshot>();
  private readonly completedSnapshots = new Map<string, StreamMetricSnapshot>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly pendingPublishKeys = new Set<string>();
  private readonly lastPublishedAt = new Map<string, number>();
  private publishHandle: ReturnType<typeof setTimeout> | null = null;
  private publishDueAt = 0;
  private updateIntervalMs = DEFAULT_UPDATE_INTERVAL_MS;
  private enabled = false;

  constructor(options: TrackerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancelSchedule = options.cancelSchedule ?? ((handle) => clearTimeout(handle));
  }

  setEnabled(enabled: boolean, updateIntervalMs = DEFAULT_UPDATE_INTERVAL_MS): void {
    this.enabled = enabled;
    this.updateIntervalMs = Math.min(2_000, Math.max(100, Math.round(updateIntervalMs)));
    if (!enabled) this.clear();
  }

  begin(input: StreamMetricIdentity & {
    turnId: string;
    userMessageId: string;
    providerId?: string;
    modelId?: string;
  }): void {
    if (!this.enabled) return;
    const now = this.now();
    const key = identityKey(input);
    const previousAssistantMessageId = this.metrics.get(key)?.assistantMessageId;
    this.metrics.set(key, {
      runtimeKey: input.runtimeKey,
      directory: normalizeDirectory(input.directory),
      sessionId: input.sessionId,
      turnId: input.turnId,
      userMessageId: input.userMessageId,
      assistantMessageId: null,
      acceptedAt: now,
      firstVisibleAt: null,
      completedAt: null,
      status: 'live',
      exact: false,
      tokens: { input: null, output: 0, reasoning: null, cacheRead: null, cacheWrite: null },
      characters: 0,
      bytes: 0,
      outputCharacters: 0,
      estimatedOutputTokens: 0,
      modelId: input.modelId ?? null,
      providerId: input.providerId ?? null,
      parts: new Map(),
      ignoredAssistantMessageIds: previousAssistantMessageId ? new Set([previousAssistantMessageId]) : new Set(),
      processedEventIds: new Set(),
      lastTouchedAt: now,
    });
    this.publishNow(key);
    this.lastPublishedAt.set(key, now);
    this.trim();
  }

  hydrateCompleted(identity: StreamMetricIdentity, message: Message): void {
    if (!this.enabled || !isCompletedAssistantMessage(message) || message.sessionID !== identity.sessionId) return;
    const key = identityKey(identity);
    const existing = this.metrics.get(key);
    if (existing?.status === 'live') return;
    if (existing?.assistantMessageId === message.id && existing.exact) return;

    const now = this.now();
    const metric: MutableMetric = {
      ...identity,
      directory: normalizeDirectory(identity.directory),
      turnId: `loaded:${message.parentID}`,
      userMessageId: message.parentID,
      assistantMessageId: message.id,
      acceptedAt: null,
      firstVisibleAt: null,
      completedAt: message.time.completed ?? now,
      status: message.error ? 'error' : 'completed',
      exact: true,
      tokens: {
        input: message.tokens.input,
        output: message.tokens.output,
        reasoning: message.tokens.reasoning,
        cacheRead: message.tokens.cache.read,
        cacheWrite: message.tokens.cache.write,
      },
      characters: 0,
      bytes: 0,
      outputCharacters: 0,
      estimatedOutputTokens: 0,
      modelId: message.modelID,
      providerId: message.providerID,
      parts: new Map(),
      ignoredAssistantMessageIds: new Set(),
      processedEventIds: new Set(),
      lastTouchedAt: now,
    };
    this.metrics.set(key, metric);
    this.publishNow(key);
    this.lastPublishedAt.set(key, now);
    this.trim();
  }

  ingest(runtimeKey: string, directory: string, event: Event): void {
    if (!this.enabled) return;
    const sessionId = this.getSessionId(event);
    if (!sessionId) return;
    const identity = { runtimeKey, directory: normalizeDirectory(directory), sessionId };
    const key = identityKey(identity);
    let metric = this.metrics.get(key);

    if (!metric && event.type === 'message.updated' && isAssistantMessage(event.properties.info)) {
      const now = this.now();
      metric = {
        ...identity,
        turnId: `observed:${sessionId}:${now}`,
        userMessageId: null,
        assistantMessageId: null,
        acceptedAt: null,
        firstVisibleAt: null,
        completedAt: null,
        status: 'live',
        exact: false,
        tokens: { input: null, output: 0, reasoning: null, cacheRead: null, cacheWrite: null },
        characters: 0,
        bytes: 0,
        outputCharacters: 0,
        estimatedOutputTokens: 0,
        modelId: null,
        providerId: null,
        parts: new Map(),
        ignoredAssistantMessageIds: new Set(),
        processedEventIds: new Set(),
        lastTouchedAt: now,
      };
      this.metrics.set(key, metric);
    }
    if (!metric || metric.processedEventIds.has(event.id)) return;
    metric.processedEventIds.add(event.id);
    if (metric.processedEventIds.size > MAX_EVENT_IDS_PER_TURN) {
      const oldest = metric.processedEventIds.values().next().value as string | undefined;
      if (oldest) metric.processedEventIds.delete(oldest);
    }

    const now = this.now();
    metric.lastTouchedAt = now;
    let changed = false;

    if (event.type === 'message.updated') {
      const message = event.properties.info;
      if (isAssistantMessage(message)) {
        if (metric.userMessageId && message.parentID !== metric.userMessageId && metric.assistantMessageId !== message.id) return;
        metric.assistantMessageId = message.id;
        metric.modelId = message.modelID;
        metric.providerId = message.providerID;
        const tokens = message.tokens;
        if (tokens && (metric.status !== 'live' || message.time.completed || message.finish || message.error)) {
          metric.tokens = {
            input: tokens.input,
            output: tokens.output,
            reasoning: tokens.reasoning,
            cacheRead: tokens.cache.read,
            cacheWrite: tokens.cache.write,
          };
          metric.exact = true;
          metric.completedAt = message.time.completed ?? metric.completedAt ?? now;
          metric.status = message.error || metric.status === 'error'
            ? 'error'
            : metric.status === 'cancelled' ? 'cancelled' : 'completed';
        }
        changed = true;
      }
    } else if (event.type === 'message.part.updated') {
      const part = event.properties.part;
      if (part.messageID === metric.userMessageId) return;
      if (metric.ignoredAssistantMessageIds.has(part.messageID)) return;
      if (metric.assistantMessageId && part.messageID !== metric.assistantMessageId) return;
      metric.assistantMessageId ??= part.messageID;
      changed = this.applyPart(metric, part) || changed;
      if (isVisiblePart(part)) changed = this.markFirstVisible(metric, now) || changed;
    } else if (event.type === 'message.part.delta') {
      if (event.properties.messageID === metric.userMessageId) return;
      if (metric.ignoredAssistantMessageIds.has(event.properties.messageID)) return;
      if (metric.assistantMessageId && event.properties.messageID !== metric.assistantMessageId) return;
      metric.assistantMessageId ??= event.properties.messageID;
      changed = this.applyDelta(metric, event.properties.partID, event.properties.field, event.properties.delta) || changed;
      if ((event.properties.field === 'text' || event.properties.field === 'reasoning') && event.properties.delta.length > 0) {
        changed = this.markFirstVisible(metric, now) || changed;
      }
    } else if (event.type === 'message.part.removed') {
      if (metric.assistantMessageId && event.properties.messageID !== metric.assistantMessageId) return;
      changed = this.removePart(metric, event.properties.partID) || changed;
    } else if (event.type === 'message.removed') {
      if (!metric.assistantMessageId || event.properties.messageID === metric.assistantMessageId) {
        this.remove(key);
        return;
      }
    } else if (event.type === 'session.deleted') {
      this.remove(key);
      return;
    } else if (event.type === 'session.idle') {
      changed = this.finishMetric(metric, 'completed', now) || changed;
    } else if (event.type === 'session.error') {
      changed = this.finishMetric(metric, 'error', now) || changed;
    }

    if (changed) this.schedulePublish(key);
    this.trim();
  }

  finish(identity: StreamMetricIdentity, status: Extract<StreamMetricStatus, 'cancelled' | 'error'>): void {
    const key = identityKey(identity);
    const metric = this.metrics.get(key);
    if (!metric) return;
    if (this.finishMetric(metric, status, this.now())) this.schedulePublish(key);
  }

  invalidateLive(runtimeKey?: string): void {
    for (const [key, metric] of this.metrics) {
      if (metric.status === 'live' && (!runtimeKey || metric.runtimeKey === runtimeKey)) this.remove(key);
    }
  }

  clear(): void {
    if (this.publishHandle !== null) this.cancelSchedule(this.publishHandle);
    this.publishHandle = null;
    this.publishDueAt = 0;
    this.pendingPublishKeys.clear();
    this.lastPublishedAt.clear();
    const keys = new Set([...this.metrics.keys(), ...this.snapshots.keys(), ...this.completedSnapshots.keys()]);
    this.metrics.clear();
    this.snapshots.clear();
    this.completedSnapshots.clear();
    for (const key of keys) this.notify(key);
  }

  subscribe(identity: StreamMetricIdentity, listener: () => void): () => void {
    const key = identityKey(identity);
    const listeners = this.listeners.get(key) ?? new Set();
    listeners.add(listener);
    this.listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(key);
    };
  }

  getSnapshot(identity: StreamMetricIdentity): StreamMetricSnapshot | null {
    return this.snapshots.get(identityKey(identity)) ?? null;
  }

  getLastCompletedSnapshot(identity: StreamMetricIdentity): StreamMetricSnapshot | null {
    return this.completedSnapshots.get(identityKey(identity)) ?? null;
  }

  flush(): void {
    if (this.publishHandle !== null) this.cancelSchedule(this.publishHandle);
    this.publishHandle = null;
    this.publishDueAt = 0;
    this.pendingPublishKeys.clear();
    const now = this.now();
    for (const key of this.metrics.keys()) {
      this.publishNow(key);
      this.lastPublishedAt.set(key, now);
    }
  }

  private getSessionId(event: Event): string | null {
    const properties = event.properties as { sessionID?: unknown; info?: { sessionID?: unknown; id?: unknown } };
    if (typeof properties.sessionID === 'string') return properties.sessionID;
    if (typeof properties.info?.sessionID === 'string') return properties.info.sessionID;
    if (event.type === 'session.deleted' && typeof properties.info?.id === 'string') return properties.info.id;
    return null;
  }

  private applyPart(metric: MutableMetric, part: Part): boolean {
    const next = metricPart(part);
    if (!next) return false;
    const previous = metric.parts.get(part.id);
    if (previous?.kind === next.kind && previous.text === next.text) return false;
    // A shorter prefix is an older full-part replay. Preserve the newer text;
    // a longer snapshot is authoritative and replaces accumulated deltas.
    if (previous?.kind === next.kind && previous.text.startsWith(next.text)) return false;
    this.replacePart(metric, part.id, next);
    return true;
  }

  private applyDelta(metric: MutableMetric, partId: string, field: string, delta: string): boolean {
    if (delta.length === 0 || (field !== 'text' && field !== 'reasoning')) return false;
    const previous = metric.parts.get(partId);
    const kind = previous?.kind ?? field;
    if (previous?.kind !== kind) {
      this.replacePart(metric, partId, { kind, text: delta });
      return true;
    }
    metric.characters += delta.length;
    metric.bytes += appendedByteLength(previous?.text ?? '', delta);
    if (kind === 'text') metric.outputCharacters += delta.length;
    metric.parts.set(partId, { kind, text: `${previous?.text ?? ''}${delta}` });
    metric.estimatedOutputTokens = estimatedTokens(metric.outputCharacters);
    if (!metric.exact) metric.tokens.output = metric.estimatedOutputTokens;
    return true;
  }

  private replacePart(metric: MutableMetric, partId: string, next: PartCounter): void {
    const previous = metric.parts.get(partId);
    metric.characters += next.text.length - (previous?.text.length ?? 0);
    metric.bytes += byteLength(next.text) - (previous ? byteLength(previous.text) : 0);
    metric.outputCharacters += (next.kind === 'text' ? next.text.length : 0)
      - (previous?.kind === 'text' ? previous.text.length : 0);
    metric.parts.set(partId, next);
    metric.estimatedOutputTokens = estimatedTokens(metric.outputCharacters);
    if (!metric.exact) metric.tokens.output = metric.estimatedOutputTokens;
  }

  private removePart(metric: MutableMetric, partId: string): boolean {
    const previous = metric.parts.get(partId);
    if (!previous) return false;
    metric.characters -= previous.text.length;
    metric.bytes -= byteLength(previous.text);
    if (previous.kind === 'text') metric.outputCharacters -= previous.text.length;
    metric.parts.delete(partId);
    metric.estimatedOutputTokens = estimatedTokens(metric.outputCharacters);
    if (!metric.exact) metric.tokens.output = metric.estimatedOutputTokens;
    return true;
  }

  private markFirstVisible(metric: MutableMetric, now: number): boolean {
    if (metric.firstVisibleAt !== null) return false;
    metric.firstVisibleAt = now;
    return true;
  }

  private finishMetric(metric: MutableMetric, status: StreamMetricStatus, now: number): boolean {
    if (metric.status !== 'live' && metric.completedAt !== null) return false;
    metric.status = status;
    metric.completedAt = now;
    return true;
  }

  private schedulePublish(key: string): void {
    const now = this.now();
    const keyDueAt = (this.lastPublishedAt.get(key) ?? Number.NEGATIVE_INFINITY) + this.updateIntervalMs;
    if (now >= keyDueAt) {
      this.publishNow(key);
      this.lastPublishedAt.set(key, now);
      this.pendingPublishKeys.delete(key);
      return;
    }
    this.pendingPublishKeys.add(key);
    this.armPublishTimer();
  }

  private armPublishTimer(): void {
    let earliestDueAt = Number.POSITIVE_INFINITY;
    for (const key of this.pendingPublishKeys) {
      earliestDueAt = Math.min(
        earliestDueAt,
        (this.lastPublishedAt.get(key) ?? Number.NEGATIVE_INFINITY) + this.updateIntervalMs,
      );
    }
    if (!Number.isFinite(earliestDueAt)) return;
    if (this.publishHandle !== null && this.publishDueAt <= earliestDueAt) return;
    if (this.publishHandle !== null) this.cancelSchedule(this.publishHandle);
    this.publishDueAt = earliestDueAt;
    const now = this.now();
    this.publishHandle = this.schedule(() => {
      this.publishHandle = null;
      this.publishDueAt = 0;
      const publishAt = this.now();
      for (const pendingKey of [...this.pendingPublishKeys]) {
        const dueAt = (this.lastPublishedAt.get(pendingKey) ?? Number.NEGATIVE_INFINITY) + this.updateIntervalMs;
        if (dueAt > publishAt) continue;
        this.pendingPublishKeys.delete(pendingKey);
        this.publishNow(pendingKey);
        this.lastPublishedAt.set(pendingKey, publishAt);
      }
      this.armPublishTimer();
    }, Math.max(0, earliestDueAt - now));
  }

  private publishNow(key: string): void {
    const metric = this.metrics.get(key);
    if (!metric) return;
    const endAt = metric.completedAt ?? this.now();
    const generationMs = metric.firstVisibleAt === null ? null : Math.max(0, endAt - metric.firstVisibleAt);
    const outputTokens = metric.exact ? metric.tokens.output : metric.estimatedOutputTokens;
    const snapshot: StreamMetricSnapshot = {
      runtimeKey: metric.runtimeKey,
      directory: metric.directory,
      sessionId: metric.sessionId,
      turnId: metric.turnId,
      assistantMessageId: metric.assistantMessageId,
      status: metric.status,
      exact: metric.exact,
      ttftMs: metric.acceptedAt !== null && metric.firstVisibleAt !== null
        ? Math.max(0, metric.firstVisibleAt - metric.acceptedAt)
        : null,
      durationMs: metric.acceptedAt !== null && metric.completedAt !== null
        ? Math.max(0, metric.completedAt - metric.acceptedAt)
        : null,
      speedTokensPerSecond: generationMs && outputTokens > 0
        ? outputTokens / (generationMs / 1_000)
        : null,
      tokens: { ...metric.tokens, output: outputTokens },
      characters: metric.characters,
      bytes: metric.bytes,
      modelId: metric.modelId,
      providerId: metric.providerId,
    };
    this.snapshots.set(key, snapshot);
    if (snapshot.status === 'completed') this.completedSnapshots.set(key, snapshot);
    this.notify(key);
  }

  private remove(key: string): void {
    this.metrics.delete(key);
    this.pendingPublishKeys.delete(key);
    this.lastPublishedAt.delete(key);
    this.completedSnapshots.delete(key);
    if (this.snapshots.delete(key)) this.notify(key);
    if (this.pendingPublishKeys.size === 0 && this.publishHandle !== null) {
      this.cancelSchedule(this.publishHandle);
      this.publishHandle = null;
      this.publishDueAt = 0;
    }
  }

  private notify(key: string): void {
    for (const listener of this.listeners.get(key) ?? []) listener();
  }

  private trim(): void {
    if (this.metrics.size <= MAX_SESSION_METRICS) return;
    const removable = [...this.metrics.entries()].sort((left, right) => {
      const leftLive = left[1].status === 'live' ? 1 : 0;
      const rightLive = right[1].status === 'live' ? 1 : 0;
      return leftLive - rightLive || left[1].lastTouchedAt - right[1].lastTouchedAt;
    });
    while (this.metrics.size > MAX_SESSION_METRICS) {
      const [key] = removable.shift()!;
      this.remove(key);
    }
  }
}

export const streamMetrics = new StreamMetricsTracker();

subscribeRuntimeEndpointWillChange(({ previousRuntimeKey }) => {
  streamMetrics.invalidateLive(previousRuntimeKey);
});

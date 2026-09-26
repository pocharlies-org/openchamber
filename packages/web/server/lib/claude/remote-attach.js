/**
 * Write to a Claude Code session another process holds, the way Claude
 * Desktop and the Claude app do: as a client of its Remote Control bridge.
 *
 * A session live in a terminal, VS Code or a Remote Control server is linked
 * to claude.ai (`bridgeSessionId` in Claude Code's registry). The Agent SDK's
 * browser client (`@anthropic-ai/claude-agent-sdk/browser`) attaches to that
 * bridge — SSE to read, POST to send — and the owning process runs the turn.
 * Nobody is stopped and no second process opens the transcript: it keeps one
 * writer. The transcript itself is still followed from disk by the runtime.
 *
 * One attachment per bridge session, closed after `idleMs` without sends.
 */

const BROWSER_SDK_IMPORT_PATH = '@anthropic-ai/claude-agent-sdk/browser';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_IDLE_MS = 10 * 60 * 1000;
const DEFAULT_DELIVERY_TIMEOUT_MS = 30 * 1000;
// The SDK cannot tell which surface it runs in and asks the host to say so.
// A desktop client's message reaches the session as the user's own
// (origin human); an undeclared one is demoted to a peer notice.
const DEFAULT_CLIENT_PLATFORM = 'desktop_app';

export class ClaudeRemoteAttachError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ClaudeRemoteAttachError';
    this.code = 'CLAUDE_REMOTE_ATTACH_FAILED';
  }
}

/** `session_…` (claude.ai link) and `cse_…` (bridge API) name the same session. */
const toBridgeId = (bridgeSessionId) => bridgeSessionId.replace(/^session_/, 'cse_');

const createPromptStream = () => {
  const queued = [];
  const waiters = [];
  let ended = false;
  return {
    push(message) {
      const waiter = waiters.shift();
      if (waiter) waiter({ value: message, done: false });
      else queued.push(message);
    },
    end() {
      ended = true;
      while (waiters.length) waiters.shift()({ value: undefined, done: true });
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (queued.length) return Promise.resolve({ value: queued.shift(), done: false });
          if (ended) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
  };
};

/**
 * @param {object} dependencies
 * @param {() => Promise<string>} dependencies.readAccessToken claude.ai OAuth token
 * @param {() => Promise<object>} [dependencies.loadBrowserSdk]
 * @param {() => string} [dependencies.randomUUID]
 * @param {string} [dependencies.baseUrl]
 * @param {string} [dependencies.clientPlatform]
 * @param {number} [dependencies.idleMs]
 * @param {number} [dependencies.deliveryTimeoutMs]
 */
export const createRemoteAttachments = ({
  readAccessToken,
  loadBrowserSdk = () => import(BROWSER_SDK_IMPORT_PATH),
  randomUUID = () => globalThis.crypto.randomUUID(),
  baseUrl = DEFAULT_BASE_URL,
  clientPlatform = DEFAULT_CLIENT_PLATFORM,
  idleMs = DEFAULT_IDLE_MS,
  deliveryTimeoutMs = DEFAULT_DELIVERY_TIMEOUT_MS,
}) => {
  /** Map<cse id, attachment> */
  const attachments = new Map();

  const close = (bridgeId) => {
    const attachment = attachments.get(bridgeId);
    if (!attachment) return;
    attachments.delete(bridgeId);
    clearTimeout(attachment.idleTimer);
    attachment.prompts.end();
    attachment.abort.abort();
    for (const pending of attachment.pending.values()) {
      pending.reject(new ClaudeRemoteAttachError('The connection to the live session closed before it took the message'));
    }
    attachment.pending.clear();
  };

  const open = async (bridgeId) => {
    const { query } = await loadBrowserSdk();
    const token = await readAccessToken();
    if (!token) throw new ClaudeRemoteAttachError('No claude.ai credentials to reach the live session');

    const prompts = createPromptStream();
    const abort = new AbortController();
    /** Map<event id, { resolve, reject }> of sends waiting for the worker. */
    const pending = new Map();
    const attachment = { prompts, abort, pending, idleTimer: null, stream: null, model: null };

    const stream = query({
      prompt: prompts,
      abortController: abort,
      sse: {
        streamUrl: `${baseUrl}/v1/code/sessions/${bridgeId}/events/stream`,
        sendUrl: `${baseUrl}/v1/code/sessions/${bridgeId}/events`,
        sessionId: bridgeId,
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-version': '2023-06-01',
          'anthropic-client-platform': clientPlatform,
        },
        onDeliveryUpdate: ({ event_id: eventId }) => {
          const waiting = pending.get(eventId);
          if (!waiting) return;
          pending.delete(eventId);
          waiting.resolve();
        },
      },
    });
    attachment.stream = stream;
    // The owner's messages reach OpenChamber through its transcript on disk;
    // the stream is drained only to keep the connection flowing.
    void (async () => {
      try {
        for await (const message of stream) void message;
      } catch (error) {
        if (!abort.signal.aborted) console.warn(`[claude-backend] live session ${bridgeId} stream ended:`, error?.message || error);
      } finally {
        if (attachments.get(bridgeId) === attachment) close(bridgeId);
      }
    })();
    return attachment;
  };

  /** The attachment to `bridgeSessionId`, opened if needed, its idle timer restarted. */
  const attach = async (bridgeSessionId) => {
    const bridgeId = toBridgeId(bridgeSessionId);
    let attachment = attachments.get(bridgeId);
    if (!attachment) {
      attachment = await open(bridgeId);
      attachments.set(bridgeId, attachment);
    }
    clearTimeout(attachment.idleTimer);
    attachment.idleTimer = setTimeout(() => close(bridgeId), idleMs);
    attachment.idleTimer.unref?.();
    return { bridgeId, attachment };
  };

  /**
   * Put the live session behind `bridgeSessionId` on `model` for its next
   * turns, as Claude Desktop's model picker does (a `set_model` control
   * request its owning process applies). A model already set through this
   * attachment is not sent again.
   */
  const setModel = async (bridgeSessionId, model) => {
    const { attachment } = await attach(bridgeSessionId);
    if (!model || attachment.model === model) return;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new ClaudeRemoteAttachError('The live session did not acknowledge the model change')), deliveryTimeoutMs);
      timer.unref?.();
    });
    try {
      await Promise.race([attachment.stream.setModel(model), timeout]);
    } finally {
      clearTimeout(timer);
    }
    attachment.model = model;
  };

  /**
   * Send a user message to the live session behind `bridgeSessionId`.
   * Resolves once its owning process has received it.
   */
  const send = async (bridgeSessionId, content) => {
    const { bridgeId, attachment } = await attach(bridgeSessionId);

    const uuid = randomUUID();
    const delivered = new Promise((resolve, reject) => {
      attachment.pending.set(uuid, { resolve, reject });
    });
    const timeout = new Promise((_, reject) => {
      const timer = setTimeout(() => {
        attachment.pending.delete(uuid);
        reject(new ClaudeRemoteAttachError('The live session did not acknowledge the message'));
      }, deliveryTimeoutMs);
      timer.unref?.();
      delivered.finally(() => clearTimeout(timer)).catch(() => {});
    });
    attachment.prompts.push({
      type: 'user',
      uuid,
      session_id: bridgeId,
      parent_tool_use_id: null,
      message: { role: 'user', content },
    });
    await Promise.race([delivered, timeout]);
  };

  const closeAll = () => {
    for (const bridgeId of Array.from(attachments.keys())) close(bridgeId);
  };

  return { send, setModel, closeAll };
};

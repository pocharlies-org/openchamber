import { createHmac } from 'node:crypto';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_STATE_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Signs heartbeats pushed OUT to a Forge web trigger.
 *
 * The call direction is deliberate: Atlassian hosts the HTTPS endpoint and this
 * host only makes outbound requests, so no private address is ever exposed and
 * there is no inbound attack surface to defend.
 *
 * The scheme is the ordinary webhook one — HMAC-SHA256 over `timestamp.body`,
 * with the timestamp inside the signed material so a captured request cannot be
 * replayed later against a different clock.
 */
export const signHeartbeat = ({ body, secret, timestampSec }) => {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new Error('Forge heartbeat secret must be at least 32 characters');
  }
  if (!Number.isInteger(timestampSec)) throw new Error('Forge heartbeat timestamp must be an integer');
  const signature = createHmac('sha256', secret).update(`${timestampSec}.${body}`).digest('hex');
  return `t=${timestampSec},v1=${signature}`;
};

/**
 * Sends one agent report to the comment-relay web trigger, where the app
 * publishes it in Jira `asApp()` with the role attributed in the body. Same
 * signed outbound channel as the heartbeat: the agent never holds a Jira
 * credential and never talks to Atlassian directly.
 */
export const createForgeCommentRelay = ({
  webTriggerUrl,
  secret,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) => {
  const url = new URL(webTriggerUrl);
  if (url.protocol !== 'https:') throw new Error('Forge web trigger URL must use HTTPS');

  return {
    send: async ({ ticketKey, role, body }) => {
      const payload = JSON.stringify({ schemaVersion: 1, ticketKey, role, body });
      if (Buffer.byteLength(payload, 'utf8') > MAX_BODY_BYTES) {
        return { state: 'error', reason: 'comment_too_large' };
      }
      const timestampSec = Math.floor(now() / 1000);
      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Company-Office-Signature': signHeartbeat({ body: payload, secret, timestampSec }),
          },
          body: payload,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) return { state: 'error', reason: `status_${response.status}` };
        const created = await response.json().catch(() => null);
        return { state: 'ready', commentId: created?.commentId ?? null };
      } catch (error) {
        return { state: 'error', reason: error?.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
      }
    },
  };
};

export const createForgeHeartbeatPublisher = ({
  webTriggerUrl,
  secret,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) => {
  const url = new URL(webTriggerUrl);
  if (url.protocol !== 'https:') throw new Error('Forge web trigger URL must use HTTPS');

  return {
    /**
     * Publishes one bounded heartbeat. Failure is reported, never thrown into the
     * dispatch loop: losing visibility must not stop work from being dispatched.
     */
    publish: async (heartbeat) => {
      const body = JSON.stringify(heartbeat);
      if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
        return { state: 'error', reason: 'heartbeat_too_large' };
      }
      const timestampSec = Math.floor(now() / 1000);
      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Company-Office-Signature': signHeartbeat({ body, secret, timestampSec }),
          },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) return { state: 'error', reason: `status_${response.status}` };
        return { state: 'ready' };
      } catch (error) {
        return { state: 'error', reason: error?.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
      }
    },
  };
};

/** Publishes the bounded company snapshot consumed by the Jira company view. */
export const createCompanyStatePublisher = ({
  webTriggerUrl,
  secret,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) => {
  const url = new URL(webTriggerUrl);
  if (url.protocol !== 'https:') throw new Error('Forge web trigger URL must use HTTPS');

  return {
    publish: async (state) => {
      const body = JSON.stringify(state);
      if (Buffer.byteLength(body, 'utf8') > MAX_STATE_BYTES) {
        return { state: 'error', reason: 'company_state_too_large' };
      }
      const timestampSec = Math.floor(now() / 1000);
      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Company-Office-Signature': signHeartbeat({ body, secret, timestampSec }),
          },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) return { state: 'error', reason: `status_${response.status}` };
        return { state: 'ready' };
      } catch (error) {
        return { state: 'error', reason: error?.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
      }
    },
  };
};

/** Pulls the installation-owned role rules over Forge's signed webtrigger. */
export const createForgeRolesLoader = ({
  webTriggerUrl,
  secret,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) => {
  const url = new URL(webTriggerUrl);
  if (url.protocol !== 'https:') throw new Error('Forge web trigger URL must use HTTPS');

  return async () => {
    const body = '{}';
    const timestampSec = Math.floor(now() / 1000);
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Company-Office-Signature': signHeartbeat({ body, secret, timestampSec }),
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`Forge roles pull failed (${response.status})`);
    return response.json();
  };
};

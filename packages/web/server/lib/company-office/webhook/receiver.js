import crypto from 'node:crypto';
import express from 'express';

const MAX_BODY_BYTES = 64 * 1024;
const DEDUPE_TTL_MS = 6 * 60 * 60 * 1000;
const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;

const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const optionalString = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

const timingSafeEqualHex = (aHex, bHex) => {
  const a = Buffer.from(aHex, 'utf8');
  const b = Buffer.from(bHex, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};

/**
 * Verifies the Jira Automation webhook signature over the raw body.
 *
 * Jira Automation signs the exact request body with the rule's webhook secret
 * and sends `sha256=<hex>` in the configured header. The comparison is over the
 * raw bytes, before any JSON parsing, and timing-safe: a signature checked after
 * re-serialization, or with `===`, is a signature that can be forged by a body
 * that round-trips differently.
 */
export const verifySignature = ({ rawBody, secret, header }) => {
  if (!secret) return false;
  const provided = optionalString(header);
  if (!provided) return false;
  const providedHex = provided.startsWith('sha256=') ? provided.slice('sha256='.length) : provided;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return timingSafeEqualHex(expected, providedHex);
};

/**
 * Extracts the issue key from a Jira issue event payload.
 *
 * Only issue events carry a key we can act on; anything else returns null and is
 * acknowledged without dispatch. The key is validated before it reaches the
 * tracker, which re-validates it — a webhook never names an endpoint directly.
 */
export const extractIssueKey = (payload) => {
  if (!isRecord(payload)) return null;
  const issue = payload.issue ?? (isRecord(payload.issue_updated) ? payload.issue_updated?.issue : null);
  return optionalString(issue?.key) ?? null;
};

const isIssueUpdated = (payload) => {
  if (!isRecord(payload)) return false;
  const webhookEvent = optionalString(payload.webhookEvent);
  if (webhookEvent && webhookEvent !== 'jira:issue_updated') return false;
  return true;
};

/**
 * Bounded in-memory dedupe.
 *
 * Jira guarantees the webhook identifier only within a tenant, so the key is
 * `(installationId, identifier)`. A process restart loses the window, which is
 * acceptable: the event dispatcher is idempotent (a ticket that owns a session is
 * adopted, not duplicated), so a replay that slips past the window is harmless.
 */
export const createDeduper = ({ ttlMs = DEDUPE_TTL_MS, now = () => Date.now() } = {}) => {
  const seen = new Map();
  const sweep = () => {
    const cutoff = now() - ttlMs;
    for (const [key, at] of seen) if (at < cutoff) seen.delete(key);
  };
  return {
    isDuplicate(key) {
      sweep();
      if (seen.has(key)) return true;
      seen.set(key, now());
      return false;
    },
    size: () => seen.size,
  };
};

/**
 * Serializes dispatch per issue so two events for the same ticket cannot both
 * read "no session" and spawn twice. Different tickets run concurrently.
 */
export const createTicketQueue = () => {
  const tail = new Map();
  return {
    enqueue(ticketKey, task) {
      const previous = tail.get(ticketKey) ?? Promise.resolve();
      const next = previous.then(task, task).finally(() => {
        if (tail.get(ticketKey) === next) tail.delete(ticketKey);
      });
      tail.set(ticketKey, next);
      return next;
    },
  };
};

/**
 * Public Jira webhook receiver.
 *
 * Lives under `/integrations`, outside the authenticated `/api` namespace, so it
 * is not reachable by the browser API by accident. It acknowledges fast and hands
 * the work to an in-process queue; the worker re-reads the issue from Jira before
 * acting. A webhook payload is never authorization.
 *
 * `deps`:
 *   - secret: the shared HMAC secret (string). Missing secret = refuse everything.
 *   - installationId: the :installationId this deployment serves.
 *   - allowedProjectKeys: Set/array of project keys to accept.
 *   - dispatch(ticketKey): async fn that runs the authoritative dispatch.
 *   - report(result): optional sink for dispatch outcomes (logging/metrics).
 */
export const registerJiraWebhookRoutes = (app, deps) => {
  const {
    secret = null,
    installationId,
    allowedProjectKeys = [],
    dispatch,
    report = () => {},
    deduper = createDeduper(),
    queue = createTicketQueue(),
    readSecretFile = null,
  } = deps;

  const resolveSecret = () => {
    if (secret) return secret;
    if (readSecretFile) {
      try { return readSecretFile().trim(); } catch { return null; }
    }
    return null;
  };

  const allowed = new Set((Array.isArray(allowedProjectKeys) ? allowedProjectKeys : [allowedProjectKeys])
    .map((key) => optionalString(key)).filter(Boolean));

  const enqueueDispatch = (ticketKey) => {
    queue.enqueue(ticketKey, async () => {
      try {
        const result = await dispatch(ticketKey);
        report(result);
      } catch (error) {
        report({ ticketKey, action: 'error', error: String(error?.message ?? error) });
      }
    });
  };

  app.post(
    `/integrations/jira/v1/webhook/${encodeURIComponent(installationId)}`,
    express.raw({ type: 'application/json', limit: `${MAX_BODY_BYTES}b` }),
    (req, res) => {
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? '', 'utf8');
      const activeSecret = resolveSecret();
      if (!activeSecret) {
        res.status(503).json({ error: 'webhook_not_configured' });
        return;
      }
      const signatureHeader = req.get('X-Hub-Signature') ?? req.get('X-Automation-Webhook-Signature');
      if (!verifySignature({ rawBody, secret: activeSecret, header: signatureHeader })) {
        res.status(401).json({ error: 'invalid_signature' });
        return;
      }

      let payload;
      try {
        payload = rawBody.length ? JSON.parse(rawBody.toString('utf8')) : null;
      } catch {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }

      const identifier = optionalString(req.get('X-Atlassian-Webhook-Identifier'));
      const dedupeKey = `${installationId}\0${identifier ?? 'no-id'}`;
      if (identifier && deduper.isDuplicate(dedupeKey)) {
        res.status(200).json({ status: 'duplicate' });
        return;
      }

      if (!isIssueUpdated(payload)) {
        res.status(200).json({ status: 'ignored', reason: 'not_issue_updated' });
        return;
      }

      const ticketKey = extractIssueKey(payload);
      if (!ticketKey || !ISSUE_KEY.test(ticketKey)) {
        res.status(200).json({ status: 'ignored', reason: 'no_issue_key' });
        return;
      }
      const projectKey = ticketKey.split('-')[0];
      if (allowed.size > 0 && !allowed.has(projectKey)) {
        res.status(200).json({ status: 'ignored', reason: 'project_not_allowed' });
        return;
      }

      enqueueDispatch(ticketKey);
      res.status(202).json({ status: 'accepted', ticketKey });
    },
  );
};

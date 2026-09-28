/**
 * Folding the Claude engine's state into OpenCode's answers, for the proxy
 * routes the UI reconciles from (lib/opencode/proxy.js).
 *
 * OpenCode 2 wraps these payloads in `{ data }` (the SDK client reads
 * `.data`); an older bare shape is kept as it came. Entries merged next to
 * `data` instead of inside it are invisible to the UI — measured 28-09-2026:
 * the active snapshot carried the Claude sessions at the top level, so every
 * poll cleared their running state.
 */

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * The active-session snapshot with the busy Claude sessions added. The SDK's
 * snapshot schema accepts only `{ type: 'running' }` entries.
 */
export const mergeActiveSnapshot = (payload, claude) => {
  const base = isRecord(payload) ? payload : {};
  const wrapped = isRecord(base.data);
  const snapshot = { ...(wrapped ? base.data : base) };
  for (const [sessionId, status] of Object.entries(isRecord(claude) ? claude : {})) {
    if (status?.type === 'busy' || status?.type === 'retry') snapshot[sessionId] = { type: 'running' };
  }
  return wrapped ? { ...base, data: snapshot } : snapshot;
};

/** A pending-request list (`/api/permission/request`, `/api/form`) with Claude's open ones appended. */
export const mergePendingList = (payload, claude) => {
  const extra = Array.isArray(claude) ? claude : [];
  const list = Array.isArray(payload) ? payload : (isRecord(payload) && Array.isArray(payload.data) ? payload.data : null);
  if (!list) return null;
  const seen = new Set(list.map((entry) => entry?.id).filter(Boolean));
  const merged = [...list, ...extra.filter((entry) => entry?.id && !seen.has(entry.id))];
  return Array.isArray(payload) ? merged : { ...payload, data: merged };
};

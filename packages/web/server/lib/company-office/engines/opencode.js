/**
 * Engine that works a ticket as an OpenCode session over HTTP.
 *
 * This is the original dispatch path, moved behind the engine contract without
 * changing its behaviour. It stays the right choice for a local LLM: the server
 * already holds the model, so a turn is a request rather than a process, and
 * sessions are listable, adoptable and archivable through the same API.
 *
 * Where it differs from the CLI engines, and why the contract has to allow both:
 *
 *   - The claim is the session TITLE, written in the same request that creates
 *     the session, so no window exists in which work has no owner.
 *   - Liveness is a remote status map, not a child process.
 *   - Archiving is real, and subagents are separate sessions linked by
 *     `parentID`, so retiring a worker has to walk that tree.
 */

const SESSION_PAGE_SIZE = 200;
const MAX_SESSION_PAGES = 20;

const TICKET_IN_TITLE = /^\[(?<ticket>[A-Z][A-Z0-9_]*-\d+)\]/;

const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const optionalString = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

/**
 * The two OpenCode endpoints disagree on how a model is named, so normalise.
 *
 * `POST /session` wants `{id, providerID}`; `POST …/prompt_async` wants
 * `{providerID, modelID}`. Both reject the other shape with a bare 400, and the
 * dispatch path only ever sends a model on the prompt — the session is created
 * without one. This accepts either spelling and emits the prompt shape, so a
 * role configured from Jira with `{providerID, modelID}` works and one carrying
 * OpenCode's own `id` works too.
 */
export const toPromptModel = (value) => {
  if (!isRecord(value)) return null;
  const providerID = optionalString(value.providerID);
  const modelID = optionalString(value.modelID) ?? optionalString(value.id);
  if (!providerID || !modelID) return null;
  return { providerID, modelID };
};

const postJson = async (fetchImpl, url, body, headers, label) => {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${label} failed (${response.status})`);
  return response;
};

export const createOpenCodeEngine = ({
  fetchImpl = globalThis.fetch,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders = () => ({}),
  model = null,
  now = () => Date.now(),
}) => {
  const url = (path) => {
    const built = new URL(buildOpenCodeUrl('/session', ''));
    built.pathname = path;
    return built;
  };

  const promptBody = (plan) => ({
    ...(plan.agent ? { agent: plan.agent } : {}),
    ...(toPromptModel(plan.model ?? model) ? { model: toPromptModel(plan.model ?? model) } : {}),
    parts: [{ type: 'text', text: plan.prompt }],
  });

  return {
    kind: 'opencode',

    /**
     * Finds the live session already claiming each ticket.
     *
     * This is what makes dispatch idempotent. A crash between creating a session
     * and recording its pointer used to leave the ticket looking free, so the next
     * cycle created a second session. The title carries the ticket from the moment
     * the session exists, so the session itself is the durable claim and Jira's
     * pointer becomes a repairable copy rather than the only record.
     */
    async findSessionsByTicket() {
      const byTicket = new Map();
      const duplicates = new Set();
      let cursor;
      let complete = true;

      for (let page = 0; page < MAX_SESSION_PAGES; page += 1) {
        const target = url('/experimental/session');
        target.searchParams.set('roots', 'true');
        target.searchParams.set('archived', 'true');
        target.searchParams.set('limit', String(SESSION_PAGE_SIZE));
        if (cursor) target.searchParams.set('cursor', cursor);

        const response = await fetchImpl(target, { headers: getOpenCodeAuthHeaders() });
        if (!response.ok) throw new Error(`Dispatch session scan failed (${response.status})`);
        const payload = await response.json();
        const rows = Array.isArray(payload) ? payload : payload?.data;
        if (!Array.isArray(rows)) throw new Error('Dispatch session scan returned an unusable list');

        for (const row of rows) {
          if (!isRecord(row) || row.parentID || row.time?.archived) continue;
          const id = optionalString(row.id);
          const ticket = TICKET_IN_TITLE.exec(optionalString(row.title) ?? '')?.groups?.ticket;
          if (!id || !ticket) continue;
          const existing = byTicket.get(ticket);
          if (existing && existing.sessionId !== id) {
            // Never pick one arbitrarily: choosing wrong resumes the wrong history.
            duplicates.add(ticket);
            continue;
          }
          const phase = /^\[[^\]]+\]\[(?<phase>[^\]]+)\]/.exec(row.title)?.groups?.phase ?? null;
          byTicket.set(ticket, {
            ticketKey: ticket,
            sessionId: id,
            title: row.title,
            agent: optionalString(row.agent),
            phase,
            startedAt: row.time?.updated ?? null,
          });
        }

        if (rows.length < SESSION_PAGE_SIZE) break;
        const next = rows.at(-1)?.time?.updated;
        if (!Number.isFinite(next) || next === cursor) { complete = false; break; }
        cursor = next;
        if (page === MAX_SESSION_PAGES - 1) complete = false;
      }

      for (const ticket of duplicates) byTicket.delete(ticket);
      return { byTicket, duplicates: [...duplicates], state: complete && duplicates.size === 0 ? 'ready' : 'partial' };
    },

    /** Lists bounded session metadata for the company view; transcripts are never requested. */
    async listSessions() {
      const sessions = [];
      let cursor;

      for (let page = 0; page < MAX_SESSION_PAGES; page += 1) {
        const target = url('/experimental/session');
        target.searchParams.set('roots', 'true');
        target.searchParams.set('archived', 'true');
        target.searchParams.set('limit', String(SESSION_PAGE_SIZE));
        if (cursor) target.searchParams.set('cursor', cursor);

        const response = await fetchImpl(target, { headers: getOpenCodeAuthHeaders() });
        if (!response.ok) throw new Error(`Company session scan failed (${response.status})`);
        const payload = await response.json();
        const rows = Array.isArray(payload) ? payload : payload?.data;
        if (!Array.isArray(rows)) throw new Error('Company session scan returned an unusable list');
        sessions.push(...rows.filter((row) => isRecord(row) && !row.parentID));

        if (rows.length < SESSION_PAGE_SIZE) return sessions;
        const next = rows.at(-1)?.time?.updated;
        if (!Number.isFinite(next) || next === cursor) break;
        cursor = next;
      }
      return sessions;
    },

    /**
     * Creates the session already bound to its role agent and dispatches without
     * waiting for the turn. The agent MUST travel in the message body: setting it
     * on the session record alone is silently ignored by the dispatch path.
     */
    async spawn(plan) {
      const headers = getOpenCodeAuthHeaders();
      const created = await postJson(fetchImpl, url('/session'), {
        title: plan.title,
        ...(plan.agent ? { agent: plan.agent } : {}),
        ...(plan.permission ? { permission: plan.permission } : {}),
        location: { directory: plan.directory },
      }, headers, `Dispatch create for ${plan.ticketKey}`);
      const payload = await created.json();
      const sessionId = optionalString(payload?.id) ?? optionalString(payload?.data?.id);
      if (!sessionId) throw new Error(`Dispatch create for ${plan.ticketKey} returned no session id`);

      await postJson(fetchImpl, url(`/session/${sessionId}/prompt_async`), promptBody(plan), headers, `Dispatch prompt for ${plan.ticketKey}`);
      return { ticketKey: plan.ticketKey, sessionId, agent: plan.agent, startedAt: now() };
    },

    /**
     * Reuses the session a ticket already owns instead of creating a second one.
     * One ticket keeps one session and therefore one continuous history.
     */
    async adopt(plan, existing) {
      await postJson(
        fetchImpl,
        url(`/session/${existing.sessionId}/prompt_async`),
        promptBody(plan),
        getOpenCodeAuthHeaders(),
        `Dispatch prompt for ${plan.ticketKey}`,
      );
      return {
        ticketKey: plan.ticketKey,
        sessionId: existing.sessionId,
        agent: plan.agent,
        startedAt: now(),
        reused: true,
      };
    },

    /**
     * A hung worker is the failure this design exists to contain: it can only
     * stall its own ticket, and the watchdog reclaims its slot.
     */
    async readStatuses() {
      const response = await fetchImpl(url('/session/status'), { headers: getOpenCodeAuthHeaders() });
      if (!response.ok) throw new Error(`Dispatch supervise failed (${response.status})`);
      const raw = await response.json();
      const statuses = isRecord(raw?.data) ? raw.data : (isRecord(raw) ? raw : null);
      if (!statuses) throw new Error('Dispatch supervise returned an unusable status map');
      return statuses;
    },

    async abort(sessionId) {
      await postJson(fetchImpl, url(`/session/${sessionId}/abort`), {}, getOpenCodeAuthHeaders(), `Abort ${sessionId}`);
    },

    async archive(sessionId) {
      const response = await fetchImpl(url(`/session/${sessionId}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...getOpenCodeAuthHeaders() },
        body: JSON.stringify({ time: { archived: now() } }),
      });
      if (!response.ok) throw new Error(`Retire ${sessionId} failed (${response.status})`);
      return { archived: true, sessionId };
    },

    /**
     * Every session a worker spawned, to any depth.
     *
     * Archiving a parent does NOT archive the subagents it launched: they stay open
     * and invisible unless something goes looking. The link is `parentID` — never
     * the title, which a subagent can set to anything.
     */
    descendantsOf(sessionIds, allSessions = []) {
      const found = new Set();
      let frontier = new Set(sessionIds);
      while (frontier.size > 0) {
        const next = new Set();
        for (const session of allSessions) {
          const id = optionalString(session?.id);
          if (!id || found.has(id) || frontier.has(id)) continue;
          if (frontier.has(optionalString(session?.parentID))) next.add(id);
        }
        for (const id of next) found.add(id);
        frontier = next;
      }
      return [...found];
    },
  };
};

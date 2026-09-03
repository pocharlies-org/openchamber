import { planDispatch } from './dispatcher.js';
import { parseRoleConfig } from './roles.js';
import { parseAiopsRouting } from './aiops-routing.js';

const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const optionalString = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

const DEFAULT_DISPATCHABLE = ['To Do', 'In Progress'];

/**
 * Dispatch triggered by a single Jira event instead of a polling cycle.
 *
 * The polling loop rebuilds the whole world every tick and creates anything that
 * is free. That is the right shape for reconciliation but the wrong shape for
 * "the CEO just assigned this epic to the CTO, start it now": a full scan for one
 * event is slow and, once the webhook owns creation, would race with it.
 *
 * So this resolves ONE issue and, when it routes to a role, spawns or reuses its
 * session. It reuses the exact same primitives as the loop — the AIOPS route, the
 * pure planner, and the dispatcher's spawn/adopt — so a webhook dispatch and a
 * polling dispatch cannot disagree about what a ticket means.
 *
 * The payload is a hint. The caller reads the issue back from the tracker before
 * calling `dispatchIssue`, so this only ever acts on authoritative state.
 */
export const createEventDispatcher = ({
  tracker,
  dispatcher,
  loadRoles = null,
  employeesById,
  dispatchableStatuses = DEFAULT_DISPATCHABLE,
  now = () => Date.now(),
}) => {
  const loadRouting = async () => {
    if (!loadRoles) return { rolesById: null, aiopsRouting: null, defaultModel: null };
    const loaded = await loadRoles();
    const roleConfig = parseRoleConfig(loaded);
    const aiopsRouting = loaded?.aiops
      ? parseAiopsRouting(loaded.aiops, { roleIds: new Set(roleConfig.byId.keys()) })
      : null;
    return { rolesById: roleConfig.byId, aiopsRouting, defaultModel: roleConfig.defaultModel ?? null };
  };

  const resolveEmployees = async (issue) => {
    if (typeof employeesById === 'function') return employeesById([issue]);
    return employeesById ?? new Map();
  };

  return {
    /**
     * Reads the issue back from the tracker (authoritative) and dispatches it.
     *
     * Returns a compact report; never throws for an expected no-op. A failure to
     * create is reported, not swallowed, so the caller can log or retry.
     */
    handleEvent: async (ticketKey) => {
      const at = now();
      const report = { at, ticketKey, action: 'noop', reason: null, sessionId: null, error: null };

      let issue;
      try {
        issue = await tracker.loadIssue(ticketKey);
      } catch (error) {
        report.action = 'error';
        report.error = String(error?.message ?? error);
        return report;
      }
      if (!issue) {
        report.reason = 'issue_not_found';
        return report;
      }

      let routing;
      try {
        routing = await loadRouting();
      } catch (error) {
        // Dispatching with an unreadable role config means dispatching without a
        // permission boundary. Refuse, exactly as the loop does.
        report.action = 'error';
        report.error = String(error?.message ?? error);
        return report;
      }

      const employees = await resolveEmployees(issue);

      // Reuse the loop's reconcile so a ticket that already owns a session is
      // adopted, not duplicated. A failed scan cannot prove the ticket is free,
      // so nothing is created — the same safety property the loop carries.
      let existing = new Map();
      let canCreate = true;
      try {
        const found = await dispatcher.findSessionsByTicket([ticketKey]);
        existing = found.byTicket ?? new Map();
        if (found.duplicates?.includes(ticketKey)) {
          report.reason = 'ambiguous_session';
          return report;
        }
      } catch (error) {
        canCreate = false;
        report.error = String(error?.message ?? error);
      }

      // Unlike the polling loop, an event for a ticket that already owns a
      // session is not skipped as "already running": the event is a deliberate
      // nudge, so it re-feeds the existing session (adopt) rather than starting
      // a second one. Only the pool-capacity guard is kept, and it is measured
      // over the OTHER busy tickets, not this one.
      const { plans, skipped } = planDispatch({
        issues: [issue],
        employeesById: employees,
        runningByTicket: new Set(),
        dispatchableStatuses,
        rolesById: routing.rolesById,
        defaultModel: routing.defaultModel,
        aiopsRouting: routing.aiopsRouting,
      });

      if (plans.length === 0) {
        report.reason = skipped[0]?.reason ?? 'no_plan';
        return report;
      }

      const plan = plans[0];
      const existingForTicket = existing.get(ticketKey);
      if (!canCreate && !existingForTicket) {
        report.reason = 'scan_failed_cannot_create';
        return report;
      }

      try {
        const result = await dispatcher.spawnAll([plan], existing);
        const started = result.started?.[0] ?? null;
        if (!started) {
          report.action = 'error';
          report.error = result.failed?.[0]?.error ?? 'spawn returned no worker';
          return report;
        }
        report.action = started.reused ? 'reused' : 'spawned';
        report.sessionId = started.sessionId;
        if (started.recorded === false) report.reason = 'session_pointer_unrecorded';
        if (result.state !== 'ready' && !report.reason) report.reason = 'dispatch_partial';
      } catch (error) {
        report.action = 'error';
        report.error = String(error?.message ?? error);
      }
      return report;
    },
  };
};

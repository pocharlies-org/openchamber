import { planDispatch } from './dispatcher.js';
import { parseRoleConfig } from './roles.js';
import { toHeartbeat } from './forge-auth.js';
import { findReadyToAdvance } from './workflow.js';
import { parseAiopsRouting } from './aiops-routing.js';

const DEFAULT_DISPATCHABLE = ['To Do', 'In Progress'];

const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));

/**
 * One dispatch cycle.
 *
 * The loop holds no authoritative state of its own. Everything it needs to
 * resume after a restart is read back from Jira (the recorded session pointer)
 * and from OpenCode (live status), so a crash mid-cycle cannot orphan a worker
 * or double-dispatch a ticket.
 *
 * A tick never throws. Each stage degrades to a reported state, because the
 * caller is a service loop: an exception would stop dispatching every other
 * ticket for one bad source.
 */
export const createDispatchLoop = ({
  tracker,
  dispatcher,
  loadRoles = null,
  publishHeartbeat = null,
  publishCompanyState = null,
  employeesById,
  workflow = null,
  dispatchableStatuses = DEFAULT_DISPATCHABLE,
  closedStatuses = ['Done', 'Closed'],
  // When a webhook owns session creation, the loop keeps reconciling — the
  // watchdog, retire-on-close, workflow hand-off and heartbeats have no event
  // that triggers them — but it must not create, or it would race the webhook.
  create = true,
  now = () => Date.now(),
}) => {
  const closed = new Set(closedStatuses.map((status) => status.toLowerCase()));

  /**
   * Rebuilds the live worker set from durable evidence: a ticket claims a
   * session, and OpenCode says whether that session is still busy.
   */
  const reconcile = async (issues) => {
    // The live session list is the primary source, because a session's title
    // carries its ticket and is written atomically at creation. The Jira pointer
    // is a convenience for humans and can lag; it is never the only evidence.
    let existing = new Map();
    let scanState = 'ready';
    let scanReason = null;
    let ambiguous = [];
    try {
      const found = await dispatcher.findSessionsByTicket();
      existing = found.byTicket ?? new Map();
      ambiguous = found.duplicates ?? [];
      if (found.state !== 'ready') scanState = 'partial';
    } catch (error) {
      // Without the scan we cannot prove a ticket has no session, and creating
      // one anyway is exactly how duplicates appear. Fall back to the recorded
      // pointers and dispatch nothing that is not provably free.
      scanState = 'error';
      scanReason = String(error?.message ?? error);
    }

    const workers = new Map();
    for (const [ticketKey, session] of existing) {
      workers.set(ticketKey, { ticketKey, sessionId: session.sessionId, startedAt: null });
    }
    for (const issue of issues) {
      if (typeof issue.sessionId !== 'string' || !issue.sessionId) continue;
      if (!workers.has(issue.key)) {
        workers.set(issue.key, { ticketKey: issue.key, sessionId: issue.sessionId, startedAt: null });
      }
    }

    const list = [...workers.values()];
    if (list.length === 0 && scanState === 'ready') {
      return { workers: [], existing, ambiguous, statuses: {}, state: 'ready' };
    }
    try {
      const statuses = await dispatcher.readStatuses();
      return { workers: list, existing, ambiguous, statuses, state: scanState, reason: scanReason };
    } catch (error) {
      // Without status we cannot tell running from finished. Treat every claimed
      // ticket as running: over-counting delays work, under-counting duplicates it.
      return {
        workers: list, existing, ambiguous, statuses: null,
        state: 'partial', reason: scanReason ?? String(error?.message ?? error),
      };
    }
  };

  return {
    tick: async () => {
      const report = {
        at: now(),
        sources: {
          tracker: 'ready', roles: 'ready', reconcile: 'ready', dispatch: 'ready',
          heartbeat: 'ready', companyState: 'ready',
        },
        started: [], reused: [], skipped: [], aborted: [], retired: [], unrecorded: [], ambiguous: [],
        advanced: [], blocked: [], errors: [],
      };

      let rolesById = null;
      let aiopsRouting = null;
      let enabledProjectKeys = null;
      // Kept whole, not just the index: the company view reports the roles this
      // installation configured, and an index cannot be listed in order.
      let roleConfig = null;
      if (loadRoles) {
        try {
          const loaded = await loadRoles();
          roleConfig = parseRoleConfig(loaded);
          rolesById = roleConfig.byId;
          if (loaded?.aiops) aiopsRouting = parseAiopsRouting(loaded.aiops, { roleIds: new Set(roleConfig.byId.keys()) });
          if (loaded?.aiops?.configured === true) enabledProjectKeys = loaded.aiops.enabledProjectKeys;
        } catch (error) {
          // Dispatching with an unreadable role config would mean dispatching
          // without a permission boundary. Refuse instead.
          report.sources.roles = 'error';
          report.errors.push({ stage: 'roles', error: String(error?.message ?? error) });
          return report;
        }
      }

      let snapshot;
      try {
        snapshot = await tracker.loadSnapshot({ projectKeys: enabledProjectKeys });
      } catch (error) {
        report.sources.tracker = 'error';
        report.errors.push({ stage: 'tracker', error: String(error?.message ?? error) });
        return report;
      }
      if (snapshot.state !== 'ready') report.sources.tracker = snapshot.state;
      const issues = snapshot.issues ?? [];
      const employees = typeof employeesById === 'function' ? employeesById(issues) : employeesById;

      const { workers, existing, ambiguous, statuses, state: reconcileState, reason } = await reconcile(issues);
      report.sources.reconcile = reconcileState;
      if (reason) report.errors.push({ stage: 'reconcile', error: reason });
      report.ambiguous = ambiguous;
      for (const ticketKey of ambiguous) {
        report.skipped.push({ key: ticketKey, reason: 'ambiguous_session' });
      }
      // A failed scan cannot prove any ticket is free, so nothing new is created.
      const canCreate = reconcileState !== 'error';

      const busy = statuses
        ? workers.filter((worker) => isRecord(statuses[worker.sessionId]) && statuses[worker.sessionId].type === 'busy')
        : workers;
      const runningByTicket = new Set([...busy.map((worker) => worker.ticketKey), ...ambiguous]);

      if (create) {
        const { plans, skipped } = planDispatch({
          issues,
          employeesById: employees,
          runningByTicket,
          dispatchableStatuses,
          rolesById,
          defaultModel: roleConfig?.defaultModel ?? null,
          aiopsRouting,
        });
        // concat, never assign: the ambiguous entries recorded above must survive
        report.skipped = [...report.skipped, ...skipped];

        if (plans.length > 0) {
          try {
            const dispatchable = canCreate ? plans : plans.filter((plan) => existing.has(plan.ticketKey));
            const result = await dispatcher.spawnAll(dispatchable, existing);
            report.started = result.started;
            report.reused = result.reused ?? [];
            report.unrecorded = result.unrecorded ?? [];
            if (result.state !== 'ready') report.sources.dispatch = 'partial';
            for (const failure of result.failed ?? []) report.errors.push({ stage: 'dispatch', ...failure });
          } catch (error) {
            report.sources.dispatch = 'error';
            report.errors.push({ stage: 'dispatch', error: String(error?.message ?? error) });
          }
        }
      }

      if (busy.length > 0) {
        try {
          const supervised = await dispatcher.supervise(busy);
          report.aborted = supervised.aborted ?? [];
        } catch (error) {
          report.errors.push({ stage: 'supervise', error: String(error?.message ?? error) });
        }
      }

      const finished = issues.filter(
        (issue) => issue.sessionId && closed.has((issue.status ?? '').toLowerCase()),
      );
      if (finished.length > 0) {
        try {
          const result = await dispatcher.retire(
            finished.map((issue) => ({ ticketKey: issue.key, sessionId: issue.sessionId })),
          );
          report.retired = result.retired ?? [];
        } catch (error) {
          report.errors.push({ stage: 'retire', error: String(error?.message ?? error) });
        }
      }

      // Whoever finished their part hands it on: a parent whose children are all
      // done moves to the status that its validating role picks up. The move is
      // recorded as a Jira comment so the handover is visible without opening a
      // session.
      if (workflow) {
        const { ready, blocked } = findReadyToAdvance(workflow, issues);
        report.blocked = blocked;
        for (const move of ready) {
          try {
            await tracker.transitionTo(move.key, move.to);
            report.advanced.push(move);
            if (tracker.addComment) {
              const who = move.validatedBy ? ` Pasa a ${move.validatedBy} para validar.` : '';
              await tracker.addComment(
                move.key,
                `Todas las tareas hijas están terminadas (${move.children.join(', ')}). ` +
                `Movido de ${move.from} a ${move.to}.${who}`,
              ).catch(() => {});
            }
          } catch (error) {
            // A refused transition usually means the workflow does not allow that
            // move from here. Report it; never force the ticket by another route.
            report.errors.push({ stage: 'advance', key: move.key, error: String(error?.message ?? error) });
          }
        }
      }

      if (publishHeartbeat) {
        const seen = [...report.started, ...busy];
        const results = await Promise.all(seen.map((worker) => publishHeartbeat(toHeartbeat({
          ticketKey: worker.ticketKey,
          sessionId: worker.sessionId,
          agent: worker.agent ?? null,
          status: statuses?.[worker.sessionId] ?? { type: 'busy' },
          startedAt: worker.startedAt,
          now: now(),
        })).catch((error) => ({ state: 'error', reason: String(error?.message ?? error) }))));
        // Visibility is not the job. Losing a heartbeat must never stop dispatch.
        if (results.some((result) => result?.state !== 'ready')) report.sources.heartbeat = 'partial';
      }

      // The whole-company picture for the Jira admin view. Forge cannot reach
      // this host, so the view is fed on each cycle or it goes stale — which is
      // exactly what it will say. Same rule as the heartbeat: a failure here
      // degrades visibility, never the dispatch.
      if (publishCompanyState) {
        try {
          const result = await publishCompanyState({ roles: roleConfig, statuses, issues, now: now() });
          if (result?.state !== 'ready') report.sources.companyState = 'partial';
        } catch (error) {
          report.sources.companyState = 'error';
          report.errors.push({ stage: 'companyState', error: String(error?.message ?? error) });
        }
      }

      return report;
    },
  };
};

import { createOpenCodeEngine, toPromptModel } from './engines/opencode.js';
import { resolveEngine } from './engines/routing.js';

// Moved to the OpenCode engine, re-exported so the module contract is unchanged.
export { toPromptModel };

const DEFAULT_MAX_CONCURRENT = 8;
const DEFAULT_TURN_DEADLINE_MS = 15 * 60 * 1000;
const SPAWN_CONCURRENCY = 4;
const MAX_PROMPT_CHARS = 4000;


const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const optionalString = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;

/**
 * A worker is a session bound to a role agent for exactly one ticket.
 * Roles are stateless configuration, so one role can run on many tickets at
 * once; the ticket, not the employee, is the unit of parallelism.
 */
// Roster shorthand: the registry says `dev`, the agent on disk is `developer`.
const ROLE_AGENT_ALIASES = { dev: 'developer' };
const ACTION_LABELS = {
  plan: 'planificar alcance y criterios de aceptación',
  design: 'definir la solución técnica y sus riesgos',
  implement: 'implementar el trabajo y sus pruebas',
  review: 'revisar el cambio sin implementarlo',
  validate: 'validar los criterios de aceptación',
  deploy: 'preparar y ejecutar el despliegue por la vía autorizada',
  approve: 'evaluar y aceptar o rechazar el resultado',
  observe: 'observar producción y documentar el resultado',
};

export const agentForRole = (role) => {
  const normalized = optionalString(role)?.toLowerCase();
  if (!normalized) return null;
  return `company/${ROLE_AGENT_ALIASES[normalized] ?? normalized}`;
};

export const sessionTitleForTicket = (issue) => {
  const summary = optionalString(issue.summary) ?? issue.key;
  const phase = optionalString(issue.phase);
  return `[${issue.key}]${phase ? `[${phase}]` : ''} ${summary}`.slice(0, 240);
};

const buildPrompt = ({ issue, employee, role = null, action = null }) => {
  const lines = [
    `Ticket ${issue.key}: ${optionalString(issue.summary) ?? '(sin resumen)'}`,
    `Estado en Jira: ${optionalString(issue.status) ?? 'desconocido'}`,
    `Rol asignado: ${role?.title ?? employee.role}`,
    ...(action ? [`Fase AIOPS: ${action}. Objetivo: ${ACTION_LABELS[action]}.`] : []),
    '',
    ...(role?.promptHint ? [role.promptHint, ''] : []),
  ];
  if (optionalString(issue.acceptanceCriteria)) {
    lines.push('Criterios de aceptación (Jira es la autoridad, no los reescribas):');
    lines.push(issue.acceptanceCriteria);
    lines.push('');
  }
  lines.push(
    'Trabaja solo en este ticket. Si necesitas algo fuera de su alcance, dilo y para.',
    'No hagas nada de esto sin que te lo pidan: desplegar, reiniciar servicios, hacer push,',
    'ni transicionar el ticket en Jira. Reporta con la salida de los comandos pegada.',
  );
  return lines.join('\n').slice(0, MAX_PROMPT_CHARS);
};

/**
 * Decides what to spawn. Pure: no transport, no clock beyond what is passed in.
 * Never returns more work than the pool allows, and never returns a ticket that
 * already has a live worker.
 */
export const planDispatch = ({
  issues,
  employeesById,
  runningByTicket,
  dispatchableStatuses,
  maxConcurrent = DEFAULT_MAX_CONCURRENT,
  // When the installation configures roles as data, the ruleset travels with the
  // session instead of depending on an agent file on the OpenCode host. That is
  // what lets a customer change a role without editing files or restarting.
  rolesById = null,
  defaultModel = null,
  aiopsRouting = null,
}) => {
  const statuses = new Set(dispatchableStatuses.map((status) => status.toLowerCase()));
  const capacity = Math.max(0, maxConcurrent - runningByTicket.size);
  const plans = [];
  const skipped = [];

  for (const issue of issues) {
    // Status first: a ticket that was never dispatchable must not be reported
    // as a capacity problem, or a full pool masks the real reasons.
    const route = aiopsRouting?.resolve(issue) ?? null;
    if (!aiopsRouting && !statuses.has((optionalString(issue.status) ?? '').toLowerCase())) {
      skipped.push({ key: issue.key, reason: 'status_not_dispatchable' });
      continue;
    }
    if (aiopsRouting && !route) {
      skipped.push({ key: issue.key, reason: 'no_aiops_route' });
      continue;
    }
    if (runningByTicket.has(issue.key)) {
      skipped.push({ key: issue.key, reason: 'already_running' });
      continue;
    }
    if (plans.length >= capacity) {
      skipped.push({ key: issue.key, reason: 'pool_full' });
      continue;
    }
    // The Jira tracker emits `assigneeAccountId`; synthetic issues in tests and
    // other trackers may carry `assigneeId`. Accept both — this seam already
    // shipped one silent zero-dispatch when only the stubbed name was read.
    const assigneeId = optionalString(issue.assigneeId) ?? optionalString(issue.assigneeAccountId);
    const employee = assigneeId ? employeesById.get(assigneeId) : null;
    if (!employee) {
      skipped.push({ key: issue.key, reason: 'unassigned' });
      continue;
    }
    const configuredRole = route?.role ?? null;
    const roleId = optionalString(configuredRole ?? employee.role)?.toLowerCase() ?? null;
    const role = rolesById ? rolesById.get(roleId) ?? null : null;
    if (rolesById && !role) {
      skipped.push({ key: issue.key, reason: 'role_not_configured' });
      continue;
    }
    const agent = agentForRole(roleId);
    if (!agent && !role) {
      skipped.push({ key: issue.key, reason: 'no_agent_for_role' });
      continue;
    }
    // The ticket says where it is worked; the roster directory is only a fallback
    // for installations that have not configured `repoField` yet.
    const directory = optionalString(issue.repo) ?? optionalString(employee.directory);
    if (!directory) {
      skipped.push({ key: issue.key, reason: 'no_repo' });
      continue;
    }
    plans.push({
      ticketKey: issue.key,
      agent,
      directory,
      phase: route?.action ?? null,
      title: sessionTitleForTicket({ ...issue, phase: route?.action ?? null }),
      prompt: buildPrompt({ issue, employee: { ...employee, role: roleId }, role, action: route?.action ?? null }),
      model: defaultModel,
    });
  }

  return { plans, skipped, capacity };
};

const settleWithConcurrency = async (items, concurrency, mapper) => {
  const results = [];
  for (let index = 0; index < items.length; index += concurrency) {
    const batch = items.slice(index, index + concurrency);
    results.push(...await Promise.allSettled(batch.map((item) => mapper(item))));
  }
  return results;
};

/**
 * Orchestrates dispatch across the engines the company is configured with.
 *
 * An engine owns how a session is created, found, resumed and ended; this owns
 * what the company does with it: one session per ticket, a bounded number at a
 * time, a deadline, and a Jira pointer that is repaired rather than trusted.
 *
 * WHY THE ENGINE IS PER TICKET AND NOT PER DEPLOYMENT
 * --------------------------------------------------
 * The company does not have one kind of worker. A role reviewing a change can be
 * worth a subscription turn on Claude or Codex, while triage belongs on the local
 * resident behind LiteLLM. The role already chooses its model, so the model
 * chooses the engine (see `engines/routing.js`) and the operator configures one
 * thing, in the place they already configure roles.
 *
 * The consequence is that a worker must remember which engine started it. A
 * session id only means something to the engine that minted it, so supervising
 * or retiring a worker has to go back to that same engine -- asking the wrong
 * one reports a live ticket as finished.
 */
export const createTicketDispatcher = ({
  engine = null,
  engines = null,
  roleDirectory = null,
  mode = 'normal',
  fetchImpl = globalThis.fetch,
  buildOpenCodeUrl = null,
  getOpenCodeAuthHeaders = () => ({}),
  model,
  now = () => Date.now(),
  maxConcurrent = DEFAULT_MAX_CONCURRENT,
  turnDeadlineMs = DEFAULT_TURN_DEADLINE_MS,
  recordSession = null,
}) => {
  // Callers that predate engines keep working: a single engine, or an OpenCode
  // URL, still serves every ticket exactly as it always did.
  const available = engines ?? {
    opencode: engine ?? (buildOpenCodeUrl
      ? createOpenCodeEngine({ fetchImpl, buildOpenCodeUrl, getOpenCodeAuthHeaders, model, now })
      : null),
    ...(engine && engine.kind && engine.kind !== 'opencode' ? { [engine.kind]: engine } : {}),
  };
  const single = engines ? null : engine;

  /**
   * The engine that serves this plan, and the model spelled the way it wants.
   *
   * A configured engine that is missing is an error, never a fallback: sending a
   * ticket to a different runtime silently bills a different account and writes
   * the session somewhere the operator will not look for it.
   */
  const routeFor = (plan) => {
    if (single) return { kind: single.kind ?? 'opencode', engine: single, model: plan.model ?? model };
    const route = resolveEngine(plan.model ?? model);
    const target = available[route.kind];
    if (!target) {
      throw new Error(
        `Ticket ${plan.ticketKey} is configured for the "${route.kind}" engine, which is not enabled.`,
      );
    }
    return { kind: route.kind, engine: target, model: route.model };
  };

  const enabled = () => Object.entries(available).filter(([, value]) => Boolean(value));

  /**
   * Recording the pointer is what makes the ticket->session link real data
   * instead of a title guess. A failure here loses the pointer, not the work,
   * so the worker survives and the caller is told the link is missing.
   */
  const withPointer = async (worker) => {
    if (!recordSession) return { ...worker, recorded: null };
    try {
      await recordSession(worker.ticketKey, worker.sessionId);
      return { ...worker, recorded: true };
    } catch {
      return { ...worker, recorded: false };
    }
  };

  /**
   * The role folder for this plan, in the cycle's mode.
   *
   * A boundary that cannot be read is not a boundary. Refusing here keeps the
   * old safety property under its new owner: before, an unreadable role config
   * stopped dispatch because the ruleset travelled with the session; now the
   * folder carries it, and an unreadable folder must stop dispatch for exactly
   * the same reason -- the alternative is an unattended turn with no limits.
   */
  const boundaryFor = async (plan) => {
    if (!roleDirectory) return null;
    const roleId = plan.roleId ?? plan.agent?.split('/').at(-1);
    if (!roleId) throw new Error(`Ticket ${plan.ticketKey} has no role to resolve a boundary from.`);
    return roleDirectory.load(roleId, plan.mode ?? mode);
  };

  const prepare = async (plan) => {
    const route = routeFor(plan);
    const roleConfig = await boundaryFor(plan);
    return { route, ready: { ...plan, model: route.model, ...(roleConfig ? { roleConfig } : {}) } };
  };

  const spawn = async (plan) => {
    const { route, ready } = await prepare(plan);
    const worker = await route.engine.spawn(ready);
    return withPointer({ ...worker, engine: route.kind, mode: ready.roleConfig?.mode ?? null });
  };

  const adopt = async (plan, existing) => {
    const { route, ready } = await prepare(plan);
    const worker = await route.engine.adopt(ready, existing);
    return withPointer({ ...worker, engine: route.kind, mode: ready.roleConfig?.mode ?? null });
  };

  /** A worker is ended by the engine that started it, never by another one. */
  const engineOf = (worker) => (single ?? available[worker.engine ?? 'opencode'] ?? null);

  const spawnAll = async (plans, existingByTicket = null) => {
    const settled = await settleWithConcurrency(plans, SPAWN_CONCURRENCY, (plan) => {
      const existing = existingByTicket?.get(plan.ticketKey);
      if (!existing) return spawn(plan);
      if (existing.agent === plan.agent && existing.phase === plan.phase) return adopt(plan, existing);
      const owner = engineOf(existing) ?? routeFor(plan).engine;
      return owner.archive(existing.sessionId).then(() => spawn(plan));
    });
    const started = [];
    const failed = [];
    settled.forEach((result, index) => {
      if (result.status === 'fulfilled') started.push(result.value);
      else failed.push({ ticketKey: plans[index].ticketKey, error: String(result.reason?.message ?? result.reason) });
    });
    const unrecorded = started.filter((worker) => worker.recorded === false);
    return {
      started,
      failed,
      unrecorded,
      reused: started.filter((worker) => worker.reused),
      state: failed.length || unrecorded.length ? 'partial' : 'ready',
    };
  };

  /**
   * Which tickets already own a session, across every enabled engine.
   *
   * A ticket can only be claimed once, so a claim found on two engines is the
   * same ambiguity as two sessions on one: refuse both rather than resume an
   * arbitrary half of the history.
   */
  const findSessionsByTicket = async (ticketKeys = []) => {
    const byTicket = new Map();
    const duplicates = new Set();
    let complete = true;

    for (const [kind, target] of enabled()) {
      const found = await target.findSessionsByTicket(ticketKeys);
      if (found.state !== 'ready') complete = false;
      for (const duplicate of found.duplicates ?? []) duplicates.add(duplicate);
      for (const [ticket, claim] of found.byTicket) {
        if (byTicket.has(ticket)) { duplicates.add(ticket); continue; }
        byTicket.set(ticket, { ...claim, engine: kind });
      }
    }

    for (const ticket of duplicates) byTicket.delete(ticket);
    return { byTicket, duplicates: [...duplicates], state: complete && duplicates.size === 0 ? 'ready' : 'partial' };
  };

  /** Merged busy map. Session ids are engine-scoped, so they cannot collide. */
  const readStatuses = async () => {
    const merged = {};
    for (const [, target] of enabled()) Object.assign(merged, await target.readStatuses());
    return merged;
  };

  const supervise = async (workers) => {
    const statuses = await readStatuses();

    const busy = [];
    const finished = [];
    const overdue = [];
    for (const worker of workers) {
      const status = statuses[worker.sessionId];
      if (status && typeof status === 'object' && status.type === 'busy') {
        if (now() - worker.startedAt > turnDeadlineMs) overdue.push(worker);
        else busy.push(worker);
        continue;
      }
      finished.push(worker);
    }

    const settled = await settleWithConcurrency(overdue, SPAWN_CONCURRENCY, async (worker) => {
      await (engineOf(worker) ?? { abort: async () => {} }).abort(worker.sessionId);
      return worker;
    });
    const aborted = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    const abortFailed = settled.length - aborted.length;

    return { busy, finished, aborted, state: abortFailed ? 'partial' : 'ready' };
  };

  /**
   * Ends the workers of a finished cycle.
   *
   * An engine whose sessions are files reports `archived: false`: the transcript
   * is the operator's copy and the ticket's claim, so removing it is not a
   * tidier version of this operation, it is data loss. Those workers are done
   * once their turn ended, and `retire` must not call that a leak.
   */
  const retire = async (workers, allSessions = []) => {
    const settled = await settleWithConcurrency(workers, SPAWN_CONCURRENCY, async (worker) => {
      const owner = engineOf(worker);
      if (!owner) throw new Error(`No engine owns session ${worker.sessionId}`);
      const roots = [worker.sessionId];
      const children = owner.descendantsOf(roots, allSessions);
      const outcomes = await Promise.all(
        [...roots, ...children].map(async (sessionId) => ({ sessionId, ...(await owner.archive(sessionId)) })),
      );
      return { worker, children, outcomes };
    });

    const retired = [];
    const descendants = [];
    let leaked = 0;
    for (const result of settled) {
      if (result.status !== 'fulfilled') { leaked += 1; continue; }
      const { worker, outcomes } = result.value;
      // `archived: false` is a deliberate retention, not a failure to close.
      retired.push(worker);
      for (const outcome of outcomes) {
        if (outcome.sessionId !== worker.sessionId && outcome.archived !== false) descendants.push(outcome.sessionId);
      }
    }

    return { retired, descendants, state: leaked ? 'partial' : 'ready' };
  };

  return {
    mode,
    engines: Object.fromEntries(enabled()),
    routeFor,
    spawn,
    spawnAll,
    supervise,
    retire,
    findSessionsByTicket,
    readStatuses,
    abort: async (sessionId, worker = null) => {
      const owner = worker ? engineOf(worker) : (single ?? available.opencode);
      if (owner) await owner.abort(sessionId);
    },
    listSessions: async () => {
      const all = [];
      for (const [, target] of enabled()) all.push(...(await target.listSessions?.() ?? []));
      return all;
    },
    maxConcurrent,
    turnDeadlineMs,
  };
};

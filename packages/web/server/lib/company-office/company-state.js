const MAX_LIVE = 100;
const MAX_HISTORY = 100;
const MAX_SKILLS = 100;
const MAX_SKILL_DESCRIPTION = 200;
const MAX_MODELS = 200;

/**
 * Company-wide procedures, listed as such.
 *
 * Skills are NOT scoped per role the way MCP tools are: OpenCode serves one
 * catalogue and every agent sees all of it. They are reported as a company-wide
 * list on purpose — rendering them under each role would invent a separation
 * that does not exist. Only name and description travel: `location` is a path
 * on the private host and `content` is the whole runbook.
 */
const summariseSkills = (skills) => {
  if (!Array.isArray(skills)) return null;
  return skills
    .map((skill) => ({
      name: optionalString(skill?.name),
      description: optionalString(skill?.description)?.slice(0, MAX_SKILL_DESCRIPTION) ?? null,
    }))
    .filter((skill) => skill.name)
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_SKILLS);
};
const TICKET_IN_TITLE = /^\[(?<ticket>[A-Z][A-Z0-9_]*-\d+)\]/;

const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const optionalString = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const finite = (value) => (Number.isFinite(value) ? value : 0);
const round = (value) => Math.round(value * 10000) / 10000;

/** Safe projection of OpenCode's configured LiteLLM provider catalogue. */
export const summariseLiteLLMModels = (providers) => {
  const list = Array.isArray(providers?.all) ? providers.all : [];
  const provider = list.find((entry) => entry?.id === 'litellm-auto');
  if (!provider || !isRecord(provider.models)) return null;
  return Object.values(provider.models)
    .map((model) => ({
      providerID: 'litellm-auto',
      modelID: optionalString(model?.id),
      name: optionalString(model?.name) ?? optionalString(model?.id),
      status: optionalString(model?.status) ?? 'unknown',
      reasoning: Boolean(model?.capabilities?.reasoning),
      attachments: Boolean(model?.capabilities?.attachment),
      toolcall: Boolean(model?.capabilities?.toolcall),
    }))
    .filter((model) => model.modelID)
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_MODELS);
};

/**
 * The company as one bounded, read-only picture for the Jira view.
 *
 * Two rules shape what goes in. First, a role has two halves and only one of
 * them is data: `model` and `permission` travel inline on session creation so
 * the plugin owns them, while `tools` (MCP/skill gating) is not accepted by
 * `POST /session` and therefore only exists in the agent file on the host. Each
 * field says which half it came from, because an operator must never believe
 * they can change an MCP from Jira when they cannot.
 *
 * Second, this payload leaves the private host: no directories, no prompts, no
 * transcripts, no tokens. What Atlassian's cloud holds has a wider audience than
 * the authenticated panel, and it is designed for that audience.
 */
const agentFor = (inventory, roleId) => {
  const agents = Array.isArray(inventory?.agents) ? inventory.agents : [];
  return agents.find((agent) => agent.id === roleId) ?? null;
};

const roleView = (role, inventory) => {
  const agent = agentFor(inventory, role.id);
  const rules = Array.isArray(role.permission) ? role.permission : [];
  const fallback = rules.find((rule) => rule.permission === '*' && rule.pattern === '*');
  const model = isRecord(role.model)
    ? { providerID: role.model.providerID, modelID: role.model.modelID }
    : null;
  return {
    id: role.id,
    title: role.title ?? role.id,
    // Configurable from Jira, because it travels with the session.
    model,
    modelSource: model ? 'plugin' : (agent?.fileModel ? 'agent-file' : 'host-default'),
    fileModel: agent?.fileModel ?? null,
    rules: rules.length,
    defaultAction: fallback?.action ?? 'ask',
    hasOwnDefault: Boolean(fallback),
    github: isRecord(role.github)
      ? { appId: role.github.appId, installationId: role.github.installationId, slug: role.github.slug ?? null }
      : null,
    // File-owned, read-only here: needs an edit on the host and an OpenCode reload.
    agent: agent
      ? {
        loaded: Boolean(agent.readable),
        mode: agent.mode ?? null,
        description: agent.description ?? null,
        disabledTools: agent.disabledTools ?? [],
        edit: agent.permission?.edit ?? null,
        bashDefault: agent.permission?.bashDefault ?? null,
        denied: agent.permission?.denied ?? [],
        reason: agent.readable === false ? agent.reason ?? 'unreadable' : null,
      }
      : { loaded: false, reason: 'no_agent_file' },
  };
};

/** A live session is one a ticket currently owns; the ticket is the unit of work. */
const sessionsByTicket = (sessions) => {
  const byTicket = new Map();
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const ticket = TICKET_IN_TITLE.exec(optionalString(session?.title) ?? '')?.groups?.ticket;
    if (!ticket) continue;
    const list = byTicket.get(ticket) ?? [];
    list.push(session);
    byTicket.set(ticket, list);
  }
  return byTicket;
};

const roleOfAgent = (agent) => optionalString(agent)?.replace(/^company\//, '') ?? null;

const usageOf = (session) => ({
  cost: round(finite(session?.cost)),
  tokens: finite(session?.tokens?.input) + finite(session?.tokens?.output),
});

export const buildCompanyState = ({
  roles = null,
  inventory = null,
  sessions = null,
  issues = null,
  statuses = null,
  skills = null,
  providers = null,
  now = () => Date.now(),
} = {}) => {
  const at = now();
  const configured = Array.isArray(roles?.roles) ? roles.roles : [];
  const known = new Set(configured.map((role) => role.id));
  const views = configured.map((role) => roleView(role, inventory));

  // An agent file with no configured role is not noise: it is a role the
  // installation forgot to declare, and the dispatcher will refuse its tickets.
  for (const agent of Array.isArray(inventory?.agents) ? inventory.agents : []) {
    if (known.has(agent.id)) continue;
    views.push({
      ...roleView({ id: agent.id, title: agent.id, permission: [] }, inventory),
      unconfigured: true,
      modelSource: agent.fileModel ? 'agent-file' : 'host-default',
    });
  }

  const byTicket = sessionsByTicket(sessions);
  const issueByKey = new Map(
    (Array.isArray(issues) ? issues : []).map((issue) => [issue.key, issue]),
  );

  const live = [];
  const history = [];
  for (const [ticketKey, list] of byTicket) {
    for (const session of list) {
      const archived = Number.isFinite(session?.time?.archived) ? session.time.archived : null;
      const startedAt = Number.isFinite(session?.time?.created) ? session.time.created : null;
      const runtime = statuses?.[session.id]?.type;
      const entry = {
        ticketKey,
        sessionId: session.id,
        role: roleOfAgent(session?.agent),
        ticketStatus: issueByKey.get(ticketKey)?.status ?? null,
        ticketType: issueByKey.get(ticketKey)?.type ?? null,
        startedAt,
        ...usageOf(session),
      };
      if (archived) {
        history.push({ ...entry, endedAt: archived });
      } else {
        live.push({
          ...entry,
          // No runtime status read is not idleness: say so rather than imply calm.
          state: runtime ?? 'unknown',
          runningForMs: startedAt ? Math.max(0, at - startedAt) : null,
        });
      }
    }
  }

  live.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  history.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));

  const byRole = new Map();
  for (const entry of [...live, ...history]) {
    const key = entry.role ?? 'sin-rol';
    const acc = byRole.get(key) ?? { role: key, sessions: 0, cost: 0, tokens: 0 };
    acc.sessions += 1;
    acc.cost = round(acc.cost + entry.cost);
    acc.tokens += entry.tokens;
    byRole.set(key, acc);
  }

  const totalCost = round([...byRole.values()].reduce((sum, entry) => sum + entry.cost, 0));

  return {
    schemaVersion: 1,
    generatedAt: at,
    defaultModel: isRecord(roles?.defaultModel)
      ? { providerID: roles.defaultModel.providerID, modelID: roles.defaultModel.modelID }
      : null,
    sources: {
      roles: roles ? 'ready' : 'unavailable',
      agents: inventory?.state ?? 'unavailable',
      sessions: Array.isArray(sessions) ? 'ready' : 'unavailable',
      tracker: Array.isArray(issues) ? 'ready' : 'unavailable',
      skills: Array.isArray(skills) ? 'ready' : 'unavailable',
      models: providers ? 'ready' : 'unavailable',
    },
    roles: views,
    skills: summariseSkills(skills),
    models: summariseLiteLLMModels(providers),
    live: live.slice(0, MAX_LIVE),
    history: history.slice(0, MAX_HISTORY),
    usage: {
      totalCost,
      byRole: [...byRole.values()].sort((a, b) => b.cost - a.cost),
    },
    counts: {
      rolesConfigured: configured.length,
      agentsLoaded: (inventory?.agents ?? []).filter((agent) => agent.readable).length,
      live: live.length,
      finished: history.length,
      liveTruncated: live.length > MAX_LIVE,
    },
  };
};

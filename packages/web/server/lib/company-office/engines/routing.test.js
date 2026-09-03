import { describe, expect, test, vi } from 'vitest';
import { resolveEngine } from './routing.js';
import { createTicketDispatcher } from '../dispatcher.js';

const plan = (overrides = {}) => ({
  ticketKey: 'SC-1',
  directory: '/srv/repo-a',
  title: '[SC-1] Work',
  prompt: 'do the work',
  agent: 'company/developer',
  ...overrides,
});

/** An engine that records what it was asked to do, shaped like the real ones. */
const fakeEngine = (kind, overrides = {}) => ({
  kind,
  spawned: [],
  aborted: [],
  archived: [],
  spawn: vi.fn(async function (received) {
    this.spawned.push(received);
    return { ticketKey: received.ticketKey, sessionId: `${kind}-session`, agent: received.agent, startedAt: 1 };
  }),
  adopt: vi.fn(async (received, existing) => ({
    ticketKey: received.ticketKey, sessionId: existing.sessionId, agent: received.agent, startedAt: 1, reused: true,
  })),
  findSessionsByTicket: vi.fn(async () => ({ byTicket: new Map(), duplicates: [], state: 'ready' })),
  readStatuses: vi.fn(async () => ({})),
  abort: vi.fn(async function (id) { this.aborted.push(id); }),
  archive: vi.fn(async function (id) { this.archived.push(id); return { archived: true, sessionId: id }; }),
  descendantsOf: () => [],
  listSessions: async () => [],
  ...overrides,
});

describe('engine routing', () => {
  test('the provider segment of the role model picks the runtime', () => {
    expect(resolveEngine('claude/opus')).toEqual({ kind: 'claude', model: 'opus' });
    expect(resolveEngine('codex/gpt-5.6-sol')).toEqual({ kind: 'codex', model: 'gpt-5.6-sol' });
    expect(resolveEngine({ providerID: 'claude', modelID: 'sonnet' })).toEqual({ kind: 'claude', model: 'sonnet' });
  });

  test('everything else stays on OpenCode, which is where the local models live', () => {
    // The house default must keep behaving exactly as it does today.
    const local = { providerID: 'litellm-auto', modelID: 'deepseek-v4-flash-0731' };
    expect(resolveEngine(local)).toEqual({ kind: 'opencode', model: local });
    expect(resolveEngine('litellm-auto/deepseek-v4-flash-0731').kind).toBe('opencode');
    expect(resolveEngine(null)).toEqual({ kind: 'opencode', model: null });
    expect(resolveEngine('bare-name').kind).toBe('opencode');
  });
});

describe('dispatching across engines', () => {
  const engines = () => ({
    opencode: fakeEngine('opencode'),
    claude: fakeEngine('claude'),
    codex: fakeEngine('codex'),
  });

  test('two roles on two runtimes run on their own engine, in one cycle', async () => {
    const available = engines();
    const dispatcher = createTicketDispatcher({ engines: available });

    const { started, failed } = await dispatcher.spawnAll([
      plan({ ticketKey: 'SC-1', model: 'claude/opus' }),
      plan({ ticketKey: 'SC-2', model: 'codex/gpt-5.6-sol' }),
      plan({ ticketKey: 'SC-3', model: { providerID: 'litellm-auto', modelID: 'deepseek-v4-flash-0731' } }),
    ]);

    expect(failed).toEqual([]);
    expect(available.claude.spawned).toHaveLength(1);
    expect(available.codex.spawned).toHaveLength(1);
    expect(available.opencode.spawned).toHaveLength(1);

    // Each engine is handed the model in the spelling it understands.
    expect(available.claude.spawned[0].model).toBe('opus');
    expect(available.codex.spawned[0].model).toBe('gpt-5.6-sol');
    expect(available.opencode.spawned[0].model).toMatchObject({ providerID: 'litellm-auto' });

    // The worker remembers its runtime, or supervising it later asks the wrong one.
    expect(started.map((worker) => worker.engine).sort()).toEqual(['claude', 'codex', 'opencode']);
  });

  test('a role configured for an engine that is not enabled fails that ticket only', async () => {
    const dispatcher = createTicketDispatcher({ engines: { opencode: fakeEngine('opencode') } });

    const { started, failed } = await dispatcher.spawnAll([
      plan({ ticketKey: 'SC-1', model: 'claude/opus' }),
      plan({ ticketKey: 'SC-2', model: { providerID: 'litellm-auto', modelID: 'deepseek-v4-flash-0731' } }),
    ]);

    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ ticketKey: 'SC-1' });
    expect(failed[0].error).toMatch(/"claude" engine, which is not enabled/);
    // One misconfigured role must not stop the tickets that are fine.
    expect(started).toHaveLength(1);
  });

  test('a hung worker is aborted on the engine that started it', async () => {
    const available = engines();
    const dispatcher = createTicketDispatcher({
      engines: available,
      now: () => 10_000,
      turnDeadlineMs: 1,
    });
    available.claude.readStatuses = vi.fn(async () => ({ 'claude-session': { type: 'busy' } }));

    const { aborted } = await dispatcher.supervise([
      { ticketKey: 'SC-1', sessionId: 'claude-session', engine: 'claude', startedAt: 0 },
    ]);

    expect(aborted).toHaveLength(1);
    expect(available.claude.aborted).toEqual(['claude-session']);
    expect(available.opencode.aborted).toEqual([]);
    expect(available.codex.aborted).toEqual([]);
  });

  test('claims are merged across engines, and a ticket claimed twice resumes neither', async () => {
    const available = engines();
    available.claude.findSessionsByTicket = vi.fn(async () => ({
      byTicket: new Map([['SC-1', { ticketKey: 'SC-1', sessionId: 'claude-1' }]]),
      duplicates: [], state: 'ready',
    }));
    available.codex.findSessionsByTicket = vi.fn(async () => ({
      byTicket: new Map([
        ['SC-1', { ticketKey: 'SC-1', sessionId: 'codex-1' }],
        ['SC-2', { ticketKey: 'SC-2', sessionId: 'codex-2' }],
      ]),
      duplicates: [], state: 'ready',
    }));
    const dispatcher = createTicketDispatcher({ engines: available });

    const found = await dispatcher.findSessionsByTicket(['SC-1', 'SC-2']);

    expect(found.byTicket.has('SC-1')).toBe(false);
    expect(found.duplicates).toEqual(['SC-1']);
    expect(found.byTicket.get('SC-2')).toMatchObject({ sessionId: 'codex-2', engine: 'codex' });
    expect(found.state).toBe('partial');
  });

  test('a partial scan on one engine downgrades the whole cycle', async () => {
    const available = engines();
    available.codex.findSessionsByTicket = vi.fn(async () => ({
      byTicket: new Map(), duplicates: [], state: 'partial',
    }));
    const dispatcher = createTicketDispatcher({ engines: available });

    // Creating on an incomplete picture is how a ticket gets a second session.
    expect((await dispatcher.findSessionsByTicket(['SC-1'])).state).toBe('partial');
  });

  test('a CLI worker retires without its transcript being deleted', async () => {
    const available = engines();
    available.claude.archive = vi.fn(async () => ({ archived: false, reason: 'claude_sessions_are_not_archivable' }));
    const dispatcher = createTicketDispatcher({ engines: available });

    const { retired, state } = await dispatcher.retire([
      { ticketKey: 'SC-1', sessionId: 'claude-session', engine: 'claude', startedAt: 0 },
    ]);

    // Retained on purpose: the session must stay openable with `claude --resume`.
    expect(retired).toHaveLength(1);
    expect(state).toBe('ready');
  });
});

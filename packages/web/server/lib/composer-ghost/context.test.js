import { describe, expect, it, vi } from 'vitest';
import {
  GHOST_COMPACT_TARGET_BYTES,
  GHOST_FIRST_USER_MAX_BYTES,
  GHOST_PROMPT_VERSION,
  buildGhostPrompt,
  createGhostContextStore,
  projectGhostTurns,
  reconcileGhostContext,
} from './context.js';

const turn = (id, role, text) => ({ id, role, text });

describe('ghost context', () => {
  it('projects only user and assistant text, excluding tool output and synthetic text', () => {
    expect(projectGhostTurns([
      { info: { id: 'u1', role: 'user' }, parts: [{ type: 'text', text: 'Hazlo' }] },
      { info: { id: 'a1', role: 'assistant', time: { completed: 2 } }, parts: [{ type: 'tool', output: 'huge' }, { type: 'text', text: 'Hecho.' }] },
      { info: { id: 'a2', role: 'assistant' }, parts: [{ type: 'text', text: 'hidden', synthetic: true }] },
      { info: { id: 'a3', role: 'assistant', summary: true, time: { completed: 3 } }, parts: [{ type: 'text', text: 'summary' }] },
    ])).toEqual([turn('u1', 'user', 'Hazlo'), turn('a1', 'assistant', 'Hecho.')]);
  });

  it('excludes incomplete assistant messages until their text is authoritative', () => {
    expect(projectGhostTurns([
      { info: { id: 'a1', role: 'assistant', time: {} }, parts: [{ type: 'text', text: 'partial' }] },
      { info: { id: 'a2', role: 'assistant', time: { completed: 3 } }, parts: [{ type: 'text', text: 'complete' }] },
    ])).toEqual([turn('a2', 'assistant', 'complete')]);
  });

  it('keeps the old prefix byte-identical when appending one turn', () => {
    const initial = reconcileGhostContext(null, {
      sessionId: 'ses_1', directory: '/repo', turns: [turn('u1', 'user', 'Objetivo'), turn('a1', 'assistant', 'Listo.')],
    });
    const before = buildGhostPrompt(initial, '').messages.slice(0, -2);
    const next = reconcileGhostContext(initial, {
      sessionId: 'ses_1', directory: '/repo', turns: [turn('u1', 'user', 'Objetivo'), turn('a1', 'assistant', 'Listo.'), turn('u2', 'user', 'Sigue')],
    });
    const after = buildGhostPrompt(next, '').messages.slice(0, -2);
    expect(after.slice(0, before.length)).toEqual(before);
  });

  it('rebuilds byte-identically after process loss', () => {
    const turns = [turn('u1', 'user', 'Objetivo'), turn('a1', 'assistant', 'Listo.'), turn('u2', 'user', 'Sigue')];
    const first = reconcileGhostContext(null, { sessionId: 'ses_1', directory: '/repo', turns });
    const rebuilt = reconcileGhostContext(null, { sessionId: 'ses_1', directory: '/repo', turns });
    expect(buildGhostPrompt(rebuilt, '').messages).toEqual(buildGhostPrompt(first, '').messages);
    expect(buildGhostPrompt(rebuilt, '').prefixHash).toBe(buildGhostPrompt(first, '').prefixHash);
  });

  it('rebuilds a compacted history byte-identically after process loss', () => {
    const turns = [turn('u1', 'user', 'Objective')];
    for (let index = 0; index < 32; index += 1) {
      turns.push(turn(`a${index}`, 'assistant', `Sentence ${index}. ${'detail '.repeat(80)}`));
      turns.push(turn(`u${index + 2}`, 'user', `User ${index} intent`));
    }
    const first = reconcileGhostContext(null, { sessionId: 'ses_1', directory: '/repo', turns });
    const rebuilt = reconcileGhostContext(null, { sessionId: 'ses_1', directory: '/repo', turns });
    expect(buildGhostPrompt(rebuilt, '')).toEqual(buildGhostPrompt(first, ''));
  });

  it('rebases when completed history is rewritten instead of appending', () => {
    const initial = reconcileGhostContext(null, {
      sessionId: 'ses_1', directory: '/repo', turns: [turn('u1', 'user', 'Objetivo'), turn('a1', 'assistant', 'Old')],
    });
    const rebuilt = reconcileGhostContext(initial, {
      sessionId: 'ses_1', directory: '/repo', turns: [turn('u1', 'user', 'Objetivo'), turn('a2', 'assistant', 'New')],
    });
    expect(buildGhostPrompt(rebuilt, '').prefixHash).not.toBe(buildGhostPrompt(initial, '').prefixHash);
    expect(rebuilt.ledger.map((entry) => entry.id)).toEqual(['a2']);
  });

  it('keeps the prefix hash stable without a new turn and changes once on append', () => {
    const base = [turn('u1', 'user', 'Objetivo'), turn('a1', 'assistant', 'Listo.')];
    const first = reconcileGhostContext(null, { sessionId: 'ses_1', directory: '/repo', turns: base });
    const hash1 = buildGhostPrompt(first, '').prefixHash;
    expect(buildGhostPrompt(reconcileGhostContext(first, { sessionId: 'ses_1', directory: '/repo', turns: base }), '').prefixHash).toBe(hash1);
    const appended = reconcileGhostContext(first, { sessionId: 'ses_1', directory: '/repo', turns: [...base, turn('u2', 'user', 'Sigue')] });
    expect(buildGhostPrompt(appended, '').prefixHash).not.toBe(hash1);
    expect(buildGhostPrompt(reconcileGhostContext(appended, { sessionId: 'ses_1', directory: '/repo', turns: [...base, turn('u2', 'user', 'Sigue')] }), '').prefixHash)
      .toBe(buildGhostPrompt(appended, '').prefixHash);
  });

  it('truncates the first user message to 2 KB', () => {
    const state = reconcileGhostContext(null, { sessionId: 'ses_1', directory: '/repo', turns: [turn('u1', 'user', 'x'.repeat(5000))] });
    expect(Buffer.byteLength(state.firstUser)).toBe(GHOST_FIRST_USER_MAX_BYTES);
  });

  it('compacts below 8 KB on turn boundaries and preserves base', () => {
    const turns = [turn('u1', 'user', 'Original objective')];
    for (let index = 0; index < 32; index += 1) {
      turns.push(turn(`a${index}`, 'assistant', `Sentence ${index}. ${'detail '.repeat(80)}`));
      turns.push(turn(`u${index + 2}`, 'user', `User ${index} intent`));
    }
    const state = reconcileGhostContext(null, { sessionId: 'ses_1', directory: '/repo', turns });
    const prompt = buildGhostPrompt(state, '');
    expect(prompt.generation).toBeGreaterThan(GHOST_PROMPT_VERSION);
    expect(prompt.prefixBytes).toBeLessThanOrEqual(GHOST_COMPACT_TARGET_BYTES);
    expect(prompt.messages[1]).toEqual({ role: 'user', content: 'Original objective' });
    expect(state.ledger.filter((entry) => entry.role === 'user').map((entry) => entry.id))
      .toEqual(turns.slice(1).filter((entry) => entry.role === 'user').map((entry) => entry.id));
    expect(state.ledger.at(-1).text).toBe(turns.at(-1).text);
    expect(state.ledger.every((entry) => entry.text.length > 0)).toBe(true);
  });

  it('fails explicitly when user messages alone cannot fit the 8 KB target', () => {
    const turns = [turn('u1', 'user', 'Objective')];
    for (let index = 0; index < 40; index += 1) turns.push(turn(`u${index + 2}`, 'user', 'x'.repeat(600)));
    expect(() => reconcileGhostContext(null, { sessionId: 'ses_1', directory: '/repo', turns }))
      .toThrow('Ghost user context exceeds the deterministic compaction budget');
  });

  it('evicts server entries by LRU capacity and TTL', () => {
    let clock = 0;
    const store = createGhostContextStore({ maxEntries: 1, ttlMs: 10, now: () => clock });
    store.reconcile({ sessionId: 'one', directory: '/repo', turns: [turn('u1', 'user', 'One')] });
    store.reconcile({ sessionId: 'two', directory: '/repo', turns: [turn('u2', 'user', 'Two')] });
    expect(store.size()).toBe(1);
    clock = 20;
    store.reconcile({ sessionId: 'three', directory: '/repo', turns: [turn('u3', 'user', 'Three')] });
    expect(store.size()).toBe(1);
  });

  it('reports a prefix change exactly when a turn is appended', () => {
    const store = createGhostContextStore();
    const base = [turn('u1', 'user', 'One')];
    expect(store.reconcile({ sessionId: 'one', directory: '/repo', turns: base }).changed).toBe(true);
    expect(store.reconcile({ sessionId: 'one', directory: '/repo', turns: base }).changed).toBe(false);
    expect(store.reconcile({ sessionId: 'one', directory: '/repo', turns: [...base, turn('a1', 'assistant', 'Done.')] }).changed).toBe(true);
    expect(store.reconcile({ sessionId: 'one', directory: '/repo', turns: [...base, turn('a1', 'assistant', 'Done.')] }).changed).toBe(false);
  });

  it('retains a completion only while the reconciled prefix is unchanged', async () => {
    const store = createGhostContextStore();
    const base = [turn('u1', 'user', 'One')];
    store.reconcile({ sessionId: 'one', directory: '/repo', turns: base });
    await store.getOrCreateCompletion('one', '/repo', 'key', async () => ({ text: 'next' }));
    store.reconcile({ sessionId: 'one', directory: '/repo', turns: base });
    expect(store.getCompletion('one', '/repo', 'key')).toEqual({ text: 'next' });
    store.reconcile({ sessionId: 'one', directory: '/repo', turns: [...base, turn('a1', 'assistant', 'Done.')] });
    expect(store.getCompletion('one', '/repo', 'key')).toBeNull();
  });

  it('coalesces concurrent completions for the same prefix and draft', async () => {
    const store = createGhostContextStore();
    store.reconcile({ sessionId: 'one', directory: '/repo', turns: [turn('u1', 'user', 'One')] });
    let resolve;
    const create = vi.fn(() => new Promise((done) => { resolve = done; }));
    const first = store.getOrCreateCompletion('one', '/repo', 'key', create);
    const second = store.getOrCreateCompletion('one', '/repo', 'key', create);
    await Promise.resolve();
    resolve({ text: 'next' });
    await expect(Promise.all([first, second])).resolves.toEqual([{ text: 'next' }, { text: 'next' }]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('isolates equal session IDs in different directories', () => {
    const store = createGhostContextStore();
    store.reconcile({ sessionId: 'same', directory: '/one', turns: [turn('u1', 'user', 'One')] });
    store.reconcile({ sessionId: 'same', directory: '/two', turns: [turn('u2', 'user', 'Two')] });
    expect(store.get('same', '/one').firstUser).toBe('One');
    expect(store.get('same', '/two').firstUser).toBe('Two');
  });
});

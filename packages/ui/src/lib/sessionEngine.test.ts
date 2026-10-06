import { describe, expect, test } from 'bun:test';
import { getSessionEngineInfo, mergeDeclaredEngine, resolveSessionEngine, SESSION_ENGINE_INFO } from './sessionEngine';

describe('resolveSessionEngine', () => {
  test('el motor declarado por el servidor manda sobre el id', () => {
    // Un registro Claude cuyo id no lleva el prefijo público (UUID desnudo, un
    // id reescrito, un subagente): antes caía en opencode y el composer
    // mandaba el mensaje al motor equivocado.
    expect(resolveSessionEngine({ id: '0b1e16d4-d15a-4616-b6d9-42db61f876f3', metadata: { backend: 'claude' } })).toBe('claude');
    expect(resolveSessionEngine({ id: 'ses_ccc0b1e16d4d15a4616b6d942db61f876f3', metadata: { backend: 'opencode' } })).toBe('opencode');
  });

  test('sin backend declarado, el prefijo del id es el respaldo', () => {
    expect(resolveSessionEngine({ id: 'ses_ccc0b1e16d4d15a4616b6d942db61f876f3' })).toBe('claude');
    expect(resolveSessionEngine({ id: 'ses_ccsa6ffcff7eb8fa7a61' })).toBe('claude');
    expect(resolveSessionEngine({ id: 'ses_fdbc3860bffehV4vp2SZOhrusN' })).toBe('opencode');
  });

  test('un backend desconocido no inventa motor: cae al id', () => {
    expect(resolveSessionEngine({ id: 'ses_fdbc3860bffehV4vp2SZOhrusN', metadata: { backend: 'codex' } })).toBe('opencode');
    expect(resolveSessionEngine({ id: 'ses_ccc01', metadata: 'claude' })).toBe('claude');
  });

  test('sin sesión, opencode', () => {
    expect(resolveSessionEngine(null)).toBe('opencode');
    expect(resolveSessionEngine(undefined)).toBe('opencode');
  });
});

describe('getSessionEngineInfo', () => {
  test('una sesión Claude no ofrece el estado de OpenCode y usa su propio catálogo', () => {
    const info = getSessionEngineInfo({ id: 'x', metadata: { backend: 'claude' } });
    expect(info.label).toBe('Claude Code');
    expect(info.hasOpenCodeStatus).toBe(false);
    expect(info.ownModelCatalog).toBe(true);
  });

  test('Claude espera más que OpenCode antes de dar un turno por no empezado', () => {
    expect(SESSION_ENGINE_INFO.claude.unansweredAfterMs).toBeGreaterThan(SESSION_ENGINE_INFO.opencode.unansweredAfterMs);
  });
});

describe('capabilities', () => {
  test('the fallback mirrors the server: Claude Code forks, compacts and keeps metadata; no shell, revert, move or goals', () => {
    const claude = SESSION_ENGINE_INFO.claude.capabilities;
    expect(claude).toMatchObject({ fork: true, forkAtMessage: true, compact: true, metadata: true, prompt: true });
    expect(claude).toMatchObject({ shell: false, revert: false, move: false, goals: false, generate: false });
    expect(claude.commands).toBe('prompt');
    expect(SESSION_ENGINE_INFO.claude.ownModelCatalog).toBe(true);
    expect(Object.values(SESSION_ENGINE_INFO.opencode.capabilities).filter((value) => value === false)).toEqual([]);
  });

  test('what the server declares wins, field by field, and junk is ignored', () => {
    const merged = mergeDeclaredEngine(SESSION_ENGINE_INFO.claude, {
      label: 'Claude Code (canary)',
      available: false,
      capabilities: { shell: true, revert: 'yes', unknownOperation: true, models: 'providers', commands: 'nonsense' },
    });
    expect(merged.label).toBe('Claude Code (canary)');
    expect(merged.available).toBe(false);
    expect(merged.capabilities.shell).toBe(true);
    expect(merged.capabilities.revert).toBe(false);
    expect(merged.capabilities.models).toBe('providers');
    expect(merged.ownModelCatalog).toBe(false);
    expect(merged.capabilities.commands).toBe('prompt');
    expect('unknownOperation' in merged.capabilities).toBe(false);
  });

  test('an answer that is not an object leaves the fallback as it is', () => {
    expect(mergeDeclaredEngine(SESSION_ENGINE_INFO.claude, null)).toBe(SESSION_ENGINE_INFO.claude);
    expect(mergeDeclaredEngine(SESSION_ENGINE_INFO.claude, 'claude')).toBe(SESSION_ENGINE_INFO.claude);
  });
});

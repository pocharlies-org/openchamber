import { describe, expect, test } from 'bun:test';
import { getSessionEngineInfo, resolveSessionEngine, SESSION_ENGINE_INFO } from './sessionEngine';

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

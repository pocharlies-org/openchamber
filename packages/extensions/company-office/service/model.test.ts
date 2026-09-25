import { describe, expect, it } from 'bun:test';

import { parseRoleDefinition, toCompanyStatus, toEpicRows, toIssueSummaries } from './model.ts';

const state = {
  encendida: true,
  dry_run: false,
  llm_parado: false,
  max_activas: 3,
  tope_dinamico: 2,
  activas: ['DGX-1'],
  activas_it: [{ key: 'INFRA-9' }],
  en_cola: ['SC-2', 'SC-1'],
  en_cola_it: [],
  barrido_at: '2026-09-25T21:00:00+00:00',
};

const epics = {
  epics: [
    { key: 'SC-1', estado: 'sin hueco', sid: null, cola_pos: 2, pregunta_pendiente: false },
    { key: 'SC-10', estado: 'aparcada hasta 26-09 03:00Z', sid: 'b', motivo: 'sesión muerta', reanudaciones_24h: 3 },
    { key: 'DGX-1', estado: 'lanzada (aaaa) [M]', sid: 'aaaa', dificultad: 'media', dificultad_letra: 'M' },
    { key: 'SC-2', estado: 'esperando hueco', cola_pos: 1, pregunta_pendiente: true },
    { key: 'INFRA-9', estado: 'Operador IT trabajando', sid: 'c' },
    { estado: 'sin clave' },
  ],
};

describe('toCompanyStatus', () => {
  it('reads the dynamic limit and counts both kinds of running sessions', () => {
    expect(toCompanyStatus(state)).toEqual({
      on: true, dryRun: false, llmStopped: false, running: 1, runningIt: 1, limit: 2, queued: 2,
      sweptAt: '2026-09-25T21:00:00+00:00',
    });
  });

  it('falls back to the base limit and answers null without a state', () => {
    expect(toCompanyStatus({ ...state, tope_dinamico: null })?.limit).toBe(3);
    expect(toCompanyStatus(null)).toBeNull();
  });
});

describe('toEpicRows', () => {
  it('puts live epics first, then the queue in order, then the rest by key', () => {
    const rows = toEpicRows(state, epics, new Map());
    expect(rows.map((row) => row.key)).toEqual(['DGX-1', 'INFRA-9', 'SC-2', 'SC-1', 'SC-10']);
    expect(rows[0]).toMatchObject({ live: true, sessionId: 'aaaa', difficulty: 'M' });
    expect(rows.find((row) => row.key === 'SC-2')).toMatchObject({ questionPending: true, queuePosition: 1, live: false });
    expect(rows.find((row) => row.key === 'SC-10')).toMatchObject({ resumes24h: 3, reason: 'sesión muerta' });
  });

  it('joins Jira titles and status when known', () => {
    const issues = toIssueSummaries({
      issues: [{ key: 'SC-1', fields: { summary: 'Título', status: { name: 'To Do', statusCategory: { key: 'new' } } } }],
    });
    const row = toEpicRows(state, epics, issues).find((entry) => entry.key === 'SC-1');
    expect(row).toMatchObject({ title: 'Título', jiraStatus: 'To Do', jiraStatusCategory: 'new' });
  });

  it('survives an unreachable supervisor', () => {
    expect(toEpicRows(null, null, new Map())).toEqual([]);
  });
});

describe('parseRoleDefinition', () => {
  it('reads name, description and model from the agent frontmatter', () => {
    const text = '---\nname: company-cto\ndescription: "Validates architecture."\nmodel: claude-opus-5-5\neffort: high\n---\n# body';
    expect(parseRoleDefinition('company-cto.md', text)).toEqual({
      id: 'company-cto', name: 'cto', description: 'Validates architecture.', model: 'claude-opus-5-5',
    });
  });

  it('skips files that are not company roles or have no frontmatter', () => {
    expect(parseRoleDefinition('helper.md', '---\nname: helper\n---\n')).toBeNull();
    expect(parseRoleDefinition('company-x.md', '# no frontmatter')).toBeNull();
  });
});

import { describe, expect, test } from 'bun:test';
import {
  filterSessionsBySource,
  hasMultipleSessionSources,
  resolveSessionSource,
} from './sessionSourceFilter';

describe('resolveSessionSource', () => {
  test('reconoce un rollout de Codex por su prefijo', () => {
    expect(resolveSessionSource({ id: 'ses_cdx01a02461ad4a755090aae4d440a84090' })).toBe('codex');
  });

  test('reconoce una sesión de Claude Code y también sus subagentes', () => {
    expect(resolveSessionSource({ id: 'ses_ccc8647ab8d1bdb4afd9c08ec1644a5bed4' })).toBe('claude');
    expect(resolveSessionSource({ id: 'ses_ccsa6ffcff7eb8fa7a61' })).toBe('claude');
  });

  test('trata como opencode cualquier id nativo', () => {
    expect(resolveSessionSource({ id: 'ses_fdbc3860bffehV4vp2SZOhrusN' })).toBe('opencode');
  });

  test('no clasifica por modelo: una sesión de opencode servida por claude-code sigue siendo de opencode', () => {
    // El id manda. Es lo que distingue "de quién es la sesión" de "con qué
    // modelo corre", que es lo que responde resolveSessionModelBadge.
    expect(resolveSessionSource({ id: 'ses_fdbc3860bffehV4vp2SZOhrusN' })).toBe('opencode');
  });

  test('sin id, opencode: es el caso de una sesión aún sin sincronizar y no puede desaparecer del listado', () => {
    expect(resolveSessionSource({})).toBe('opencode');
    expect(resolveSessionSource(null)).toBe('opencode');
  });

  test('exige el prefijo completo: `ses_cc` a secas no basta', () => {
    // Discriminar con 6 caracteres colaría cualquier id nativo que empiece por
    // `ses_cc`, y son ids aleatorios: pasa antes o después.
    expect(resolveSessionSource({ id: 'ses_ccffeX520w9wkbyx6Rf' })).toBe('opencode');
  });
});

describe('filterSessionsBySource', () => {
  const sessions = [
    { id: 'ses_cdx0001' },
    { id: 'ses_ccc0002' },
    { id: 'ses_ccs0003' },
    { id: 'ses_native0004' },
  ];

  test('devuelve la lista intacta con `all`', () => {
    expect(filterSessionsBySource(sessions, 'all')).toHaveLength(4);
  });

  test('filtra por herramienta', () => {
    expect(filterSessionsBySource(sessions, 'codex').map((s) => s.id)).toEqual(['ses_cdx0001']);
    expect(filterSessionsBySource(sessions, 'claude').map((s) => s.id)).toEqual(['ses_ccc0002', 'ses_ccs0003']);
    expect(filterSessionsBySource(sessions, 'opencode').map((s) => s.id)).toEqual(['ses_native0004']);
  });
});

describe('hasMultipleSessionSources', () => {
  test('es falso contra un opencode pelado, que es cuando el control debe esconderse', () => {
    expect(hasMultipleSessionSources([{ id: 'ses_a' }, { id: 'ses_b' }])).toBe(false);
  });

  test('es falso con la lista vacía', () => {
    expect(hasMultipleSessionSources([])).toBe(false);
  });

  test('es cierto en cuanto convive una espejada con una nativa', () => {
    expect(hasMultipleSessionSources([{ id: 'ses_a' }, { id: 'ses_cdx1' }])).toBe(true);
  });
});

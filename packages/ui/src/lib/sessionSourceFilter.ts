export type SessionSource = 'opencode' | 'codex' | 'claude';

export type SessionSourceFilter = SessionSource | 'all';

type SessionLike = { id?: string | null };

// Los ids que fabrica agent-session-mirror para las transcripciones que espeja:
// `ses_cdx…` es un rollout de Codex, `ses_ccc…` una sesión de Claude Code y
// `ses_ccs…` uno de sus subagentes. Cualquier otro id es una sesión nativa de
// opencode.
//
// Se clasifica por el id y NO por el modelo a propósito: lo que se filtra aquí
// es QUÉ HERRAMIENTA es dueña de la sesión, no con qué modelo corre. Una sesión
// de opencode servida por el proveedor `claude-code` sigue siendo de opencode:
// se continúa desde opencode y vive en su base de datos. Para lo otro —la
// familia de LLM— ya está `resolveSessionModelBadge`, y son preguntas distintas.
const CODEX_ID_PREFIX = 'ses_cdx';
const CLAUDE_ID_PREFIXES = ['ses_ccc', 'ses_ccs'] as const;

export function resolveSessionSource(session: SessionLike | undefined | null): SessionSource {
  const id = session?.id ?? '';
  if (id.startsWith(CODEX_ID_PREFIX)) {
    return 'codex';
  }
  if (CLAUDE_ID_PREFIXES.some((prefix) => id.startsWith(prefix))) {
    return 'claude';
  }
  return 'opencode';
}

/**
 * Whether the list carries sessions from more than one tool.
 *
 * El control de filtro se esconde cuando la respuesta es `false`. Contra un
 * opencode pelado —sin el espejo delante— todas las sesiones son de opencode y
 * un filtro de tres opciones donde dos siempre dan vacío es ruido, no función.
 */
export function hasMultipleSessionSources(sessions: readonly SessionLike[]): boolean {
  let first: SessionSource | null = null;
  for (const session of sessions) {
    const source = resolveSessionSource(session);
    if (first === null) {
      first = source;
      continue;
    }
    if (source !== first) {
      return true;
    }
  }
  return false;
}

export function filterSessionsBySource<T extends SessionLike>(
  sessions: readonly T[],
  filter: SessionSourceFilter,
): T[] {
  if (filter === 'all') {
    return sessions as T[];
  }
  return sessions.filter((session) => resolveSessionSource(session) === filter);
}

export const SESSION_SOURCE_FILTERS: readonly SessionSourceFilter[] = ['all', 'opencode', 'codex', 'claude'];

// `as const` no es cosmetico: `t()` esta tipado contra la union de claves de
// mensajes, y un Record<..., string> le llega como `string` y no compila.
export const SESSION_SOURCE_LABEL_KEYS = {
  all: 'sessions.sidebar.header.sourceFilter.all',
  opencode: 'sessions.sidebar.header.sourceFilter.opencode',
  codex: 'sessions.sidebar.header.sourceFilter.codex',
  claude: 'sessions.sidebar.header.sourceFilter.claude',
} as const satisfies Record<SessionSourceFilter, string>;

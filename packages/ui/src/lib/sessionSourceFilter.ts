import type { IconName } from '@/components/icon/icons';

export type SessionSource = 'opencode' | 'claude';

export type SessionSourceFilter = SessionSource | 'all';

type SessionLike = { id?: string | null };

// `ses_ccc…` es una sesión de Claude Code y `ses_ccs…` uno de sus subagentes
// (los ids que publica el backend Claude de lib/claude/routes.js). Cualquier
// otro id es una sesión nativa de opencode.
//
// Se clasifica por el id y NO por el modelo a propósito: lo que se filtra aquí
// es QUÉ HERRAMIENTA es dueña de la sesión, no con qué modelo corre. Una sesión
// de opencode servida por el proveedor `claude-code` sigue siendo de opencode:
// se continúa desde opencode y vive en su base de datos. Para lo otro —la
// familia de LLM— ya está `resolveSessionModelBadge`, y son preguntas distintas.
const CLAUDE_ID_PREFIXES = ['ses_ccc', 'ses_ccs'] as const;

export function resolveSessionSource(session: SessionLike | undefined | null): SessionSource {
  const id = session?.id ?? '';
  if (CLAUDE_ID_PREFIXES.some((prefix) => id.startsWith(prefix))) {
    return 'claude';
  }
  return 'opencode';
}

/**
 * Whether the list carries sessions from more than one tool.
 *
 * El control de filtro se esconde cuando la respuesta es `false`. Sin
 * transcripciones de Claude todas las sesiones son de opencode, y un filtro
 * donde una opción siempre da vacío es ruido, no función.
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
  sessions: T[],
  filter: SessionSourceFilter,
): T[] {
  // Se devuelve la MISMA referencia con `all`, no una copia: esta lista alimenta
  // memos aguas abajo y copiarla los invalidaria en cada render.
  if (filter === 'all') {
    return sessions;
  }
  return sessions.filter((session) => resolveSessionSource(session) === filter);
}

export const SESSION_SOURCE_FILTERS: readonly SessionSourceFilter[] = ['all', 'opencode', 'claude'];

// `as const` no es cosmetico: `t()` esta tipado contra la union de claves de
// mensajes, y un Record<..., string> le llega como `string` y no compila.
export const SESSION_SOURCE_LABEL_KEYS = {
  all: 'sessions.sidebar.header.sourceFilter.all',
  opencode: 'sessions.sidebar.header.sourceFilter.opencode',
  claude: 'sessions.sidebar.header.sourceFilter.claude',
} as const satisfies Record<SessionSourceFilter, string>;

/**
 * Glifo que marca la fila de una sesión ajena a opencode.
 *
 * Solo se dibuja para `claude`: opencode es la herramienta nativa de
 * la app, así que la ausencia de glifo YA dice «opencode» y una lista de un
 * solo origen no gana ni un píxel de ruido. Marcar la excepción en vez de
 * marcarlo todo deja la jerarquía visual intacta para quien solo usa opencode.
 */
export const SESSION_SOURCE_ICONS = {
  claude: 'claude-code',
} as const satisfies Partial<Record<SessionSource, IconName>>;

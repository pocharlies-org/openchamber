/**
 * Sessions the company's bots author, as opposed to Dani.
 *
 * The company dispatches work through `claude -p` (headless), so its sessions
 * reach the transcript store with no marker of their own — the only reliable
 * signal is the dispatch prompt the launchers write (measured 2026-09-29,
 * x86-host-runtime jira-epic-trigger, the supervisor's morning cron, the
 * tech-lead maker dispatches and the dreaming pass). Each pattern below is
 * anchored to the literal opening a launcher produces; a human typing at the
 * composer is matched by the same rules only if they paste a dispatch prompt
 * verbatim, which is rare and harmless (the session just lands in the folder).
 *
 * The company's maker worktrees also live under `~/compania/` and the bots'
 * offices under `~/startupcompany/employees/`, so a session whose cwd is
 * inside either tree is company-made regardless of its title.
 */

// Openings no human summary or rename would ever produce: safe to match
// against `summary` and `customTitle` too.
const COMPANY_ROLE_OPENINGS = Object.freeze([
  /^PRIORIDADES DE LA MA[ÑN]ANA/, // supervisor's morning PM dispatch
  /^#\s*[A-Z][A-Z0-9]*-\d+\s*·/, // Jira epic trigger: "# SC-1327 · …"
  /^Eres el clasificador del pase/, // dreaming pass (SC-711)
  /^Eres company-/, // company roles: designer, writer, …
  /^Eres (el|la|un|una|las) (PM|analista|CTO|Tech[ -]Lead|auditor|verificador|brazo pesado|manos|agente del rol|sesi[oó]n de Claude)\b/, // role dispatches by text
]);

// Anchored to the literal dispatch prompts, so they run against `firstPrompt`
// only — a summary like "SC-1327 ya está merged" is a human asking about a
// ticket, not a dispatch (measured 2026-09-29 against the whole store).
const COMPANY_DISPATCH_PATTERNS = Object.freeze([
  ...COMPANY_ROLE_OPENINGS,
  /^[#\s]*[A-Z][A-Z0-9]*-\d+\b/, // opens with the epic key: "INFRA-284 (H1 de …)", "SC-1272 (epica hija …)"
  /^#?\s*ENCARGO\b/i, // tech-lead turns and CTO commissions: "# Encargo · DGX-433", "ENCARGO INFRA-257", "Encargo del CTO (…)"
  /^TAREA\b/i, // maker dispatch: "Tarea DGX-466 en el repo actual", "TAREA: escribir UN fichero…"
  /^REWORK\s+[A-Z][A-Z0-9]*-\d+/i, // qa rework: "REWORK SC-1328 (h2 cache-timer plugin)…"
  /^IMPLEMENTA\s+[A-Z][A-Z0-9]*-\d+/i, // maker dispatch: "Implementa DGX-460 (P4 widgets+Watch…"
  /^Trabaj[oa]s?\b/, // "Trabajas en el worktree", "Trabajo en el repo", "Trabajo: INFRA-288", "Trabajo en DGX-416 (H2…"
  /^Ejecuta exactamente estos cambios en este worktree/, // maker dispatch without preamble
  /^Crea UN fichero de test nuevo en este worktree/, // qa fixture dispatch
  /^Repo: worktree actual/, // maker dispatch on its own branch
]);

const COMPANY_CWD_PATTERN = /(^|\/)(compania|startupcompany\/employees)\//;

const matchesAny = (value, patterns) => (
  typeof value === 'string'
  && patterns.some((pattern) => pattern.test(value.trim()))
);

/**
 * @param {{ cwd?: string, customTitle?: string, summary?: string, firstPrompt?: string }} info
 *   a `SDKSessionInfo` from the Agent SDK's `listSessions`.
 */
export const isCompanyClaudeSession = (info) => {
  if (!info || typeof info !== 'object') return false;
  if (typeof info.cwd === 'string' && COMPANY_CWD_PATTERN.test(info.cwd)) return true;
  return matchesAny(info.customTitle, COMPANY_ROLE_OPENINGS)
    || matchesAny(info.summary, COMPANY_ROLE_OPENINGS)
    || matchesAny(info.firstPrompt, COMPANY_DISPATCH_PATTERNS);
};

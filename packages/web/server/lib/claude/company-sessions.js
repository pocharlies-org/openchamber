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
 * The company's maker worktrees also live under `~/compania/`, so a session
 * whose cwd is inside that tree is company-made regardless of its title.
 */

const COMPANY_TITLE_PATTERNS = Object.freeze([
  /^PRIORIDADES DE LA MAÑANA/, // supervisor's morning PM dispatch
  /^#\s*[A-Z][A-Z0-9]*-\d+\s*·/, // Jira epic trigger: "# SC-1327 · …"
  /^#?\s*Encargo\s*·/, // tech-lead turn: "# Encargo · DGX-433 · …"
  /^Tarea\s+[A-Z][A-Z0-9]*-\d+/, // maker dispatch: "Tarea DGX-466 en el repo actual"
  /^Eres el clasificador del pase/, // dreaming pass (SC-711)
  /^Eres company-/, // company roles: designer, writer, …
  /^Eres las manos del bot/, // maker dispatched without its own worktree
  /^Trabajas en el worktree/, // maker inside ~/compania/dev/…
  /^Trabajo en el repo/, // devops dispatch on a repo branch
]);

const COMPANY_CWD_PATTERN = /(^|\/)compania\//;

const matchesCompanyTitle = (value) => (
  typeof value === 'string'
  && COMPANY_TITLE_PATTERNS.some((pattern) => pattern.test(value.trim()))
);

/**
 * @param {{ cwd?: string, customTitle?: string, summary?: string, firstPrompt?: string }} info
 *   a `SDKSessionInfo` from the Agent SDK's `listSessions`.
 */
export const isCompanyClaudeSession = (info) => {
  if (!info || typeof info !== 'object') return false;
  if (typeof info.cwd === 'string' && COMPANY_CWD_PATTERN.test(info.cwd)) return true;
  return matchesCompanyTitle(info.customTitle)
    || matchesCompanyTitle(info.summary)
    || matchesCompanyTitle(info.firstPrompt);
};

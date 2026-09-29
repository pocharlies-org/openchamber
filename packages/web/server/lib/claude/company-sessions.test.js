import { describe, expect, it } from 'vitest';

import { isCompanyClaudeSession } from './company-sessions.js';

// Every accepted case is a dispatch prompt measured live in the transcript
// store on 2026-09-29 (supervisor cron, Jira epic trigger, tech-lead maker
// dispatch, dreaming pass). Rejected cases are real human sessions.
describe('isCompanyClaudeSession', () => {
  it('accepts the launchers that dispatch company work', () => {
    const dispatches = [
      { firstPrompt: 'PRIORIDADES DE LA MAÑANA (desde el supervisor). Eres el analista (PM) de la compañía' },
      { firstPrompt: '# SC-1327 · composerStatus en el host (H1 de SC-1268)\n\nRepo: worktree ~/compania/dev/SC-1327' },
      { firstPrompt: '# Encargo · DGX-433 · plan de la épica (turno de tech-lead, sin código)' },
      { firstPrompt: 'Tarea DGX-466 en el repo actual (worktree, rama dgx-413-h3-chip-summary).' },
      { firstPrompt: 'Eres el clasificador del pase dreaming (SC-711), lote index_shopify.' },
      { firstPrompt: 'Eres company-designer. Dani pide desde el chat (hermes) este diseño:' },
      { firstPrompt: 'Eres las manos del bot developer de la compañía. Historia DGX-457' },
      { firstPrompt: 'Trabajas en el worktree ~/compania/dev/DGX-465-developer (repo dgx-infra).' },
      { firstPrompt: 'Trabajo en el repo dgx-infra (rama ops/devops/update-watch-host-versions, base master).' },
    ];
    dispatches.forEach((info) => {
      expect(isCompanyClaudeSession(info), info.firstPrompt.slice(0, 40)).toBe(true);
    });
  });

  it('accepts a maker worktree by its cwd even when the title is a summary', () => {
    expect(isCompanyClaudeSession({ cwd: '/home/dibanez/compania/dev/SC-1327', summary: 'arreglar composer' })).toBe(true);
    expect(isCompanyClaudeSession({ cwd: '/home/dibanez/k8s', summary: 'compania algo' })).toBe(false);
  });

  it('rejects human sessions, including ones that merely mention a ticket', () => {
    [
      { firstPrompt: 'la vista de entregas https://dgx.e-dani.com/entregas no es igual qe diseño, estandarizala' },
      { firstPrompt: 'que hora es?' },
      { firstPrompt: 'Haz una auditoria con toda la informacion que hemos pasado a la gestoria' },
      { firstPrompt: 'mira la tarea DGX-466 que creó la compañía' },
      { firstPrompt: 'Investigar peticiones de master key' },
      { summary: 'SC-1327 ya está merged', firstPrompt: '¿cómo va SC-1327?' },
    ].forEach((info) => {
      expect(isCompanyClaudeSession(info), info.firstPrompt).toBe(false);
    });
  });

  it('tolerates junk input', () => {
    expect(isCompanyClaudeSession(null)).toBe(false);
    expect(isCompanyClaudeSession(undefined)).toBe(false);
    expect(isCompanyClaudeSession({})).toBe(false);
    expect(isCompanyClaudeSession({ firstPrompt: 42, cwd: null })).toBe(false);
  });
});

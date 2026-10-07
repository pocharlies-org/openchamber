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
      // Misses measured 2026-09-29 after the first ship: the store had these
      // dispatch openings outside the folder.
      { firstPrompt: 'Eres el PM de la compania. Encargo directo de Dani: UNA epica, esta.' },
      { firstPrompt: 'Eres el analista de la compañía preparando la auditoría de la épica SC-1305' },
      { firstPrompt: 'Eres el CTO auditando, en SÓLO LECTURA, el cierre de los findings' },
      { firstPrompt: 'Eres el Tech Lead de DGX-310 (épica CTO, sesión e793a4e8). Objetivo único' },
      { firstPrompt: 'Eres una sesión de Claude creada para cerrar el incidente de RabbitMQ' },
      { firstPrompt: 'Eres el brazo pesado del bot devops de la compañía en el repo' },
      { firstPrompt: 'Eres las manos que teclean; yo decido y verifico. Repo ya preparado' },
      { firstPrompt: 'Eres el agente del rol analista (company-pm) en fase PLAN de la épica OWU-81.' },
      { firstPrompt: 'INFRA-284 (H1 de INFRA-114): presupuesto de reintento en pushToBrain' },
      { firstPrompt: 'SC-1272 (epica hija 3/3 de SC-1262). RETOMA con EVENTO' },
      { firstPrompt: 'ENCARGO INFRA-257 (S1 de INFRA-256) · base común del proyecto Vite' },
      { firstPrompt: 'Encargo del CTO (sesión 04e3ce31) · épica DGX-372 · rework' },
      { firstPrompt: 'TAREA: escribir UN fichero de test nuevo en este repo (worktree INFRA-289' },
      { firstPrompt: 'REWORK SC-1328 (h2 cache-timer plugin) en este worktree' },
      { firstPrompt: 'Implementa DGX-460 (P4 widgets+Watch sobre v3) EXACTAMENTE así' },
      { firstPrompt: 'Trabajo en el worktree ~/compania/dev/INFRA-316-devops/brain-v2' },
      { firstPrompt: 'Trabajo: INFRA-288 (P1 de la épica INFRA-112) en el repo k8s-socialmedia' },
      { firstPrompt: 'Trabajo en DGX-416 (H2 de la épica DGX-414) dentro de este worktree' },
      { firstPrompt: 'Ejecuta exactamente estos cambios en este worktree (rama developer/OWU-83' },
      { firstPrompt: 'Crea UN fichero de test nuevo en este worktree y añade su ruta' },
      { firstPrompt: 'Repo: worktree actual (rama feat/sc1268-h2-cache-timer-plugin). Historia SC-1328' },
    ];
    dispatches.forEach((info) => {
      expect(isCompanyClaudeSession(info), info.firstPrompt.slice(0, 40)).toBe(true);
    });
  });

  it('accepts a maker worktree by its cwd even when the title is a summary', () => {
    expect(isCompanyClaudeSession({ cwd: '/home/user/compania/dev/SC-1327', summary: 'arreglar composer' })).toBe(true);
    expect(isCompanyClaudeSession({ cwd: '/home/user/startupcompany/employees/cto-office', summary: 'despacho del cto' })).toBe(true);
    expect(isCompanyClaudeSession({ cwd: '/home/user/k8s', summary: 'compania algo' })).toBe(false);
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

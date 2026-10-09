#!/usr/bin/env node
// Guarda de workflows del fork público (DGX-515).
//
// El repo es público y la org corre runners propios (arc-k8s): un workflow que
// corra código de una PR externa sobre esos runners o con secretos es ejecución
// remota de código no revisado. Esta guarda falla si reaparece alguno de los
// patrones que se eliminaron en H2:
//
//   1. `pull_request_target` en cualquier sitio (con o sin secretos).
//   2. runner propio (self-hosted / macbook / x86) o runner hosted de SO
//      (macos-* / windows-* / ubuntu-latest) en un workflow que dispara por
//      `pull_request`.
//   3. un job que referencia `secrets.X` (X != GITHUB_TOKEN) sin `environment:`
//      que lo ponga tras aprobación manual.
//
// Los jobs que delegan en un workflow reutilizable (`uses:`) no se inspeccionan
// aquí: el runner y los secretos viven en el repo del reusable (org).
//
// Uso: node scripts/check-workflow-guard.mjs [dir-workflows]   (por defecto
// .github/workflows). Salida: `::error file=…` por violación; rc=1 si alguna.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

// En eventos de PR el único runner permitido: allowlist, no denylist — así
// blacksmith-*, etiquetas de terceros y cualquier etiqueta futura caen solas.
const ALLOWED_PR_RUNNERS = new Set(['arc-k8s']);
// Reusables de workflows permitidos en PR: los de la org (auditados). Un
// `uses:` a un repo ajeno con `secrets: inherit` es un cauce de exfiltración.
const ORG_PREFIX = 'pocharlies-org/';

// El valor de `on:` llega del YAML como string (`on: pull_request`), lista de
// eventos u objeto con claves de evento; `null` (clave sin valor) no aporta.
const triggerEvents = (workflow) => {
  const on = workflow.on ?? workflow[true];
  if (on === null || on === undefined) return [];
  if (Array.isArray(on)) return on.map(String);
  if (on === String(on)) return [on];
  return Object.keys(on).map((k) => (k === 'true' ? 'on' : k));
};

// true solo si runs-on es literalmente arc-k8s (string) o una lista de
// etiquetas todas arc-k8s. Expresiones (${{ matrix.runner }}), mapas
// {group,labels} y cualquier otra etiqueta no se demuestran: no valen.
const runnerAllowed = (runner) => {
  if (runner === String(runner)) return ALLOWED_PR_RUNNERS.has(runner);
  if (Array.isArray(runner)) return runner.length > 0 && runner.every((t) => ALLOWED_PR_RUNNERS.has(t));
  return false;
};

export function checkWorkflow(file, text) {
  const errors = [];
  let workflow;
  try {
    workflow = parse(text);
  } catch (e) {
    return [`::error file=${file}::workflow YAML inválido: ${e.message}`];
  }
  if (!workflow || Array.isArray(workflow)) return [];
  const events = triggerEvents(workflow);
  const prEvents = events.filter((e) => e === 'pull_request' || e === 'pull_request_target');
  if (prEvents.includes('pull_request_target')) {
    errors.push(`::error file=${file}::pull_request_target prohibido en el fork (ejecuta código de PR ajena con los secretos del repo)`);
  }
  const jobs = workflow.jobs ?? {};
  if (Array.isArray(jobs)) return errors;
  for (const [name, job] of Object.entries(jobs)) {
    if (!job || Array.isArray(job)) continue;
    const where = `${file} job "${name}"`;
    // Un job con `if:` anclado a un evento que no es la PR (dispatch, push,
    // schedule, release, o solo `inputs.*`) no corre en pull_request. Ojo:
    // `if: github.event_name == 'pull_request'` NO exime — corre en la PR.
    const jobIf = String(job.if ?? '');
    const anchoredElsewhere =
      (/github\.event_name\s*==\s*'(workflow_dispatch|push|schedule|release)'/.test(jobIf) ||
        (/\binputs\./.test(jobIf) && !/github\.event_name/.test(jobIf))) &&
      !jobIf.includes('pull_request');
    const runsOnPr = prEvents.length > 0 && !anchoredElsewhere;
    if (job.uses !== undefined) {
      if (runsOnPr && !String(job.uses).startsWith(ORG_PREFIX) && !String(job.uses).startsWith('./')) {
        errors.push(`::error file=${file}::${where}: workflow reutilizable de un repo ajeno a la org en un job que corre en pull_request (${job.uses})`);
      }
    } else if (runsOnPr && job['runs-on'] !== undefined && !runnerAllowed(job['runs-on'])) {
      const shown = Array.isArray(job['runs-on']) ? job['runs-on'].join(', ') : String(job['runs-on']);
      errors.push(`::error file=${file}::${where}: runs-on '${shown}' no es arc-k8s literal; en eventos de PR solo se permite arc-k8s (skill ci-runners-arc)`);
    }
    if (!job.environment) {
      const jobText = JSON.stringify(job);
      for (const m of jobText.matchAll(/\$\{\{\s*secrets\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) {
        if (m[1] === 'GITHUB_TOKEN') continue;
        errors.push(`::error file=${file}::${where}: usa secrets.${m[1]} sin 'environment:' (todo secreto va tras aprobación manual)`);
        break;
      }
    }
  }
  return errors;
}

export function checkDir(dir) {
  const errors = [];
  for (const name of readdirSync(dir).sort()) {
    if (!/\.(ya?ml)$/.test(name)) continue;
    errors.push(...checkWorkflow(path.join(dir, name), readFileSync(path.join(dir, name), 'utf8')));
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const dir = process.argv[2] ?? '.github/workflows';
  const errors = checkDir(dir);
  for (const e of errors) console.error(e);
  if (errors.length) {
    console.error(`guarda de workflows: ${errors.length} violación(es) en ${dir}`);
    process.exit(1);
  }
  console.log(`guarda de workflows: OK (${dir})`);
}

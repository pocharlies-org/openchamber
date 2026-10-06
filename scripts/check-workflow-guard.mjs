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

const SELF_HOSTED = /\b(self-hosted|macbook|x86)\b/i;
const HOSTED_OS = /\b(macos[-\w]*|windows[-\w]*|ubuntu-latest|ubuntu-\d+\.\d+)\b/;

// El valor de `on:` llega del YAML como string (`on: pull_request`), lista de
// eventos u objeto con claves de evento; `null` (clave sin valor) no aporta.
const triggerEvents = (workflow) => {
  const on = workflow.on ?? workflow[true];
  if (on === null || on === undefined) return [];
  if (Array.isArray(on)) return on.map(String);
  if (on === String(on)) return [on];
  return Object.keys(on).map((k) => (k === 'true' ? 'on' : k));
};

const runsOnTokens = (job) => {
  const runner = job['runs-on'];
  if (runner === null || runner === undefined) return '';
  return (Array.isArray(runner) ? runner : [runner]).join(' ');
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
    const runs = runsOnTokens(job);
    // Un job con `if:` atado a otro evento (dispatch, tag) no corre en la PR
    // aunque el workflow también dispare por pull_request. Heurística: si el
    // `if` menciona `workflow_dispatch` o `github.event_name`, se excluye.
    const jobIf = String(job.if ?? '');
    const runsOnPr = prEvents.length > 0 && !/workflow_dispatch|github\.event_name/.test(jobIf);
    if (runs && !runs.includes('${{') && runsOnPr) {
      if (SELF_HOSTED.test(runs)) {
        errors.push(`::error file=${file}::${where}: runner propio (${runs.trim()}) en un workflow que dispara por pull_request`);
      }
      if (prEvents.includes('pull_request') && HOSTED_OS.test(runs)) {
        errors.push(`::error file=${file}::${where}: runner hosted de SO (${runs.trim()}) en pull_request; los jobs de PR van a arc-k8s (skill ci-runners-arc)`);
      }
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

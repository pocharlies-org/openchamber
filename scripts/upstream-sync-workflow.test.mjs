import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { parse } from 'yaml';

// Static checks of .github/workflows/upstream-sync.yml: the job runs with write
// permissions, so its trigger, runner and inputs are guarded here, offline.
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const wf = parse(read('../.github/workflows/upstream-sync.yml'));
const doc = read('../docs/upstream-sync.md');
const job = wf.jobs.sync;
// YAML 1.1 readers turn the bare key `on` into `true`; `yaml` v2 does not, accept both.
const triggers = wf.on ?? wf[true];

describe('upstream-sync workflow', () => {
  it('runs weekly on a schedule and on manual dispatch with a dry_run input defaulting to true', () => {
    assert.equal(triggers.schedule.length, 1);
    assert.match(triggers.schedule[0].cron, /^\S+ \S+ \S+ \S+ \S+$/);
    assert.equal(triggers.workflow_dispatch.inputs.dry_run.type, 'boolean');
    assert.equal(triggers.workflow_dispatch.inputs.dry_run.default, true);
  });

  it('never triggers on pull_request (it holds write permissions)', () => {
    assert.deepEqual(Object.keys(triggers).filter((t) => t.startsWith('pull_request')), []);
  });

  it('runs on the org ARC runners, with permissions declared on the job', () => {
    for (const j of Object.values(wf.jobs)) assert.equal(j['runs-on'], 'arc-k8s');
    assert.deepEqual(job.permissions, { contents: 'write', issues: 'write', 'pull-requests': 'write' });
    assert.equal(wf.permissions, undefined); // no broader workflow-level grant
  });

  it('never interpolates ${{ }} inside a run: step (inputs travel through env)', () => {
    const runs = job.steps.map((s) => s.run).filter(Boolean);
    assert.ok(runs.length >= 3);
    for (const run of runs) assert.doesNotMatch(run, /\$\{\{/);
  });

  it('keeps upstream_ref pinned to v2.1.0 in the dispatch default and the cron fallback until the docs say otherwise (DGX-637/638)', () => {
    const pinned = triggers.workflow_dispatch.inputs.upstream_ref.default;
    assert.equal(pinned, 'v2.1.0');
    assert.ok(job.env.SYNC_UPSTREAM_REF.includes(`'${pinned}'`), 'cron fallback must match the dispatch default');
    assert.ok(doc.includes(`defaults to **${pinned}**`), 'docs/upstream-sync.md must state the pinned tag; change both together');
  });
});

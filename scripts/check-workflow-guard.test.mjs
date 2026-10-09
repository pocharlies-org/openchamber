import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkWorkflow, checkDir } from './check-workflow-guard.mjs';

// Fixture malo: los tres patrones que la guarda debe cazar (DGX-515).
const BAD = `
name: heredado
on:
  pull_request_target:
    types: [opened]
jobs:
  bot:
    runs-on: self-hosted
    steps:
      - run: echo \${{ secrets.API_TOKEN }}
`;

// Formas de eludir una denylist de runners (ronda 1 del architect, PR #112):
// cada una debe fallar por sí sola.
const BYPASS = {
  'if anclado a la propia PR': `
on: pull_request
jobs:
  bot:
    if: github.event_name == 'pull_request'
    runs-on: self-hosted
    steps:
      - run: echo x
`,
  'etiqueta de terceros (blacksmith)': `
on: pull_request
jobs:
  test:
    runs-on: blacksmith-4vcpu-ubuntu-2404
    steps:
      - run: echo x
`,
  'runs-on por expresión (matrix)': `
on: pull_request
jobs:
  test:
    strategy:
      matrix:
        runner: [arc-k8s, ubuntu-latest]
    runs-on: \${{ matrix.runner }}
    steps:
      - run: echo x
`,
  'reusable de un repo ajeno': `
on: pull_request
jobs:
  delega:
    uses: alguien/no-audited/.github/workflows/listo.yml@main
    secrets: inherit
`,
};

// Fixture bueno: PR solo en arc-k8s literal sin secretos; secretos solo tras
// environment y anclados a workflow_dispatch; reusable de la org con inherit.
const GOOD = `
name: correcto
on:
  pull_request:
  workflow_dispatch:
jobs:
  checks:
    runs-on: arc-k8s
    steps:
      - run: echo hola
  reutil:
    uses: pocharlies-org/k8s-gitops-pocharlies/.github/workflows/reusable-duplicados.yml@main
    secrets: inherit
  publica:
    if: github.event_name == 'workflow_dispatch'
    environment: release
    runs-on: macos-15
    steps:
      - run: echo \${{ secrets.APPLE_ID }}
`;

test('workflow heredado malo falla con las tres violaciones', () => {
  const errors = checkWorkflow('malo.yml', BAD);
  assert.equal(errors.length, 3, errors.join('\n'));
  assert.match(errors.join('\n'), /pull_request_target/);
  assert.match(errors.join('\n'), /arc-k8s/);
  assert.match(errors.join('\n'), /secrets\.API_TOKEN/);
});

test('cada forma de eludir la guarda falla', () => {
  for (const [name, yaml] of Object.entries(BYPASS)) {
    const errors = checkWorkflow('bypass.yml', yaml);
    assert.equal(errors.length, 1, `${name}: ${errors.join('\n')}`);
  }
});

test('workflow conforme pasa', () => {
  assert.deepEqual(checkWorkflow('bueno.yml', GOOD), []);
});

test('checkDir: la carpeta con el fixture malo falla y solo la buena pasa', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'guarda-'));
  try {
    writeFileSync(path.join(dir, 'bueno.yml'), GOOD);
    assert.deepEqual(checkDir(dir), []);
    writeFileSync(path.join(dir, 'malo.yml'), BAD);
    assert.equal(checkDir(dir).length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

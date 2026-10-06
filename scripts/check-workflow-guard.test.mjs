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

// Fixture bueno: PR en arc-k8s sin secretos; secretos solo tras environment y
// fuera de pull_request.
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
  assert.match(errors.join('\n'), /runner propio/);
  assert.match(errors.join('\n'), /secrets\.API_TOKEN/);
});

test('workflow conforme pasa', () => {
  assert.deepEqual(checkWorkflow('bueno.yml', GOOD), []);
});

test('runner hosted de SO en pull_request falla', () => {
  const errors = checkWorkflow('hosted.yml', `
on: pull_request
jobs:
  test:
    runs-on: macos-15
    steps:
      - run: echo x
`);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /hosted/);
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

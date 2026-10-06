import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { test } from 'node:test';

// The fork must never check, download or link to upstream's releases. Upstream's repo is
// named in lookups (GitHub URLs, API paths, publish owner) in a few places on purpose;
// each one is listed here with the reason.
const ROOTS = ['packages/ui/src', 'packages/electron', 'packages/web/server'];
const UPSTREAM = /(github\.com[/:]|repos\/|raw\.githubusercontent\.com\/|["']?owner["']?: *["'])openchamber(\/openchamber|["'])/;
const ISSUE_REFERENCE = /openchamber\/openchamber\/issues\/\d/;
const ALLOWED = {
  'packages/electron/main.mjs': 'bug-report and ideas links: the fork has issues and discussions off; repoint when they are on',
  'packages/ui/src/components/sections/integrations/catalogExtensions.ts': 'upstream-owned extension repositories (openchamber-excalidraw)',
};

test('no update, release or link surface points at upstream openchamber/openchamber', () => {
  const files = execSync(`git ls-files ${ROOTS.join(' ')}`, { encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.(m?js|cjs|ts|tsx|json)$/.test(f) && !/\.(test|spec)\./.test(f) && !/__tests__/.test(f));
  const hits = [];
  for (const file of files) {
    if (ALLOWED[file]) continue;
    const text = execSync(`cat ${file}`, { encoding: 'utf8' });
    text.split('\n').forEach((line, i) => {
      if (UPSTREAM.test(line) && !ISSUE_REFERENCE.test(line)) hits.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, []);
});

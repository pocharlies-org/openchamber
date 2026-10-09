import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const ROOTS = ['packages/ui/src', 'packages/electron', 'packages/mobile'];
const lines = readFileSync(new URL('./brand-allowlist.txt', import.meta.url), 'utf8').split('\n');
const entries = lines.filter((l) => l && !l.startsWith('#'));
const reviewedTotal = Number(lines.find((l) => l.startsWith('# reviewed-total:'))?.split(':')[1]);
const mentions = execSync(`git grep -il openchamber -- ${ROOTS.join(' ')}`, { encoding: 'utf8' }).split('\n').filter(Boolean);

test('the allowlist is paths with a reason, not patterns', () => {
  let why = false;
  for (const line of lines) {
    if (line.startsWith('# why:')) why = true;
    else if (line && !line.startsWith('#')) {
      assert.ok(why, `${line} has no "# why:" line above it`);
      assert.ok(!/[*?[\]]/.test(line), `${line} looks like a pattern`);
    }
  }
});

test('the allowlist does not grow without review', () => {
  assert.ok(Number.isInteger(reviewedTotal), 'missing "# reviewed-total: N" line');
  assert.ok(entries.length <= reviewedTotal, `${entries.length} entries, reviewed total is ${reviewedTotal}: use the brand (packages/ui/src/lib/brand.ts) instead of listing a new file`);
});

test('every file that mentions openchamber is listed, and every listed file still does', () => {
  const listed = new Set(entries);
  assert.deepEqual(mentions.filter((f) => !listed.has(f)), [], 'unlisted files mention openchamber');
  const found = new Set(mentions);
  assert.deepEqual(entries.filter((f) => !found.has(f)), [], 'listed files no longer mention openchamber: remove them');
});

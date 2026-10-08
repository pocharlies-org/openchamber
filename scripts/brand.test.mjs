import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { brandDrift, readBrand, TARGETS } from './brand-sync.mjs';
import { brandMonoSpriteMarkup } from './lib/brand-mark.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(join(ROOT, relative), 'utf8');
const brand = readBrand();

// Where a person can read the product's name, and the files that are the seam or are written by it.
const SCAN = ['packages/ui/src', 'packages/electron', 'packages/mobile', 'packages/web/index.html', 'packages/web/public', 'packages/web/server/lib/brand.js', 'packages/web/server/lib/brand-mark.js'];
const EXTENSIONS = /\.(ts|tsx|js|mjs|cjs|html|swift|plist|xml|json|java|webmanifest)$/;
const TESTS = /(\.test\.|\.behavior\.|\/__tests__\/)/;
// Written by brand-sync (checked against brand.json below) or the seam itself.
const WRITTEN_BY_SYNC = new Set(TARGETS.map((target) => target.file));
// Not scanned on purpose (each has its own follow-up story): packages/web/bin and the rest of packages/web/server/lib
// (CLI and log messages for the operator; the `openchamber` bin is a contract) and packages/vscode (its own manifest).

// Case-sensitive on purpose: `OpenChamberWidget`, `OpenChamberLogo` and `openchamber://` are identifiers, not names.
const NAMES = [...new Set([...brand.legacy.names, brand.displayName, brand.productName])];
const NAME = new RegExp(`\\b(${NAMES.join('|')})\\b`);
// The product's own channels come from brand.json `social`. A handle or an invite written by hand is somebody else's
// community on a screen that says Triora, and NAME (case-sensitive) cannot see `openchamber_dev`.
const SOCIAL = /openchamber_dev|(^|[^\w-])(x|twitter)\.com\/|discord\.(gg|com\/invite)\//i;

const stripComments = (lines) => {
  let block = null;
  return lines.map((line) => {
    let code = '';
    for (let i = 0; i < line.length;) {
      if (block) {
        const end = line.indexOf(block, i);
        if (end < 0) { i = line.length; } else { i = end + block.length; block = null; }
      } else if (line.startsWith('<!--', i)) { block = '-->'; i += 4; }
      else if (line.startsWith('/*', i) && (i === 0 || /[\s{(;,]/.test(line[i - 1]))) { block = '*/'; i += 2; }
      else if (line.startsWith('//', i) && (i === 0 || /\s/.test(line[i - 1]))) { break; }
      else { code += line[i++]; }
    }
    return code;
  });
};

const trackedFiles = () => execFileSync('git', ['ls-files', '-z', '--', ...SCAN], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\0')
  .filter((file) => file && EXTENSIONS.test(file) && !TESTS.test(file) && !WRITTEN_BY_SYNC.has(file));

/** Lines where `pattern` (the product's name, old or new, by default) is written by hand, outside comments. */
export const findings = (pattern = NAME) => trackedFiles().flatMap((file) => {
  const lines = read(file).split('\n');
  const code = stripComments(lines);
  return code.flatMap((line, index) => (pattern.test(line) ? [{ file, line: index + 1, text: lines[index].trim() }] : []));
});

const show = (f) => `${f.file}:${f.line}: ${f.text.slice(0, 140)}`;

const exceptionLines = read('scripts/brand-exceptions.txt').split('\n');
const reviewedTotal = Number(exceptionLines.find((l) => l.startsWith('# reviewed-total:'))?.split(':')[1]);
const exceptions = exceptionLines.filter((l) => l && !l.startsWith('#')).map((l) => {
  const [file, text, reason, ...rest] = l.split('\t');
  return { file, text, reason, rest };
});

const key = (file, text) => `${file}\t${text}`;
const excepted = new Set(exceptions.map((e) => key(e.file, e.text)));

test('every target of brand-sync matches brand/brand.json', () => {
  assert.deepEqual(brandDrift().map((d) => d.file), [], 'run: bun run brand:sync');
  const result = spawnSync(process.execPath, ['scripts/brand-sync.mjs', '--check'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('the icon masters match icons.lock (changing a master means regenerating)', () => {
  const result = spawnSync(process.execPath, ['scripts/build-brand-icons.mjs', '--lock-check'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('the sprite glyph of the product is the mono master, not a drawing', () => {
  assert.ok(read('packages/ui/src/components/icon/sprite.ts').includes(brandMonoSpriteMarkup(read(brand.icons.mono))), 'run: node scripts/generate-icon-sprite.mjs');
});

test('no name of the product (old or new) is written by hand outside the seam', () => {
  const found = findings().filter((f) => !excepted.has(key(f.file, f.text)));
  assert.deepEqual(found.map(show), [], 'use the brand (packages/ui/src/lib/brand.ts, packages/web/server/lib/brand.js, packages/electron/brand.mjs) or add a reviewed line to scripts/brand-exceptions.txt');
});

test('no social handle or invite link is written by hand outside the seam, and brand.json holds none of upstream', () => {
  assert.deepEqual(findings(SOCIAL).map(show), [], 'read the channels from `social` in brand/brand.json (packages/ui/src/lib/brand.ts, packages/web/server/lib/brand.js)');
  assert.doesNotMatch(JSON.stringify(brand.social), /openchamber/i, "upstream's accounts are not the product's own channels");
});

test('the exceptions are exact lines with a reason, and none is stale or unreviewed', () => {
  assert.ok(Number.isInteger(reviewedTotal), 'missing "# reviewed-total: N" line');
  assert.ok(exceptions.length <= reviewedTotal, `${exceptions.length} exceptions, reviewed total is ${reviewedTotal}`);
  for (const e of exceptions) {
    assert.ok(e.file && e.text && e.reason && e.rest.length === 0, `exception needs exactly: path<TAB>exact line<TAB>reason (${e.file})`);
    assert.ok(!/[*?[\]]/.test(e.file), `${e.file} looks like a pattern`);
  }
  const live = new Set(findings().map((f) => key(f.file, f.text)));
  assert.deepEqual(exceptions.filter((e) => !live.has(key(e.file, e.text))).map((e) => `${e.file}: ${e.text}`), [], 'stale exceptions: remove them');
});

test('mobile-release.yml takes the app id and URL scheme from brand.json, not from repository variables', () => {
  const workflow = read('.github/workflows/mobile-release.yml');
  assert.doesNotMatch(workflow, /vars\.IOS_/, 'IOS_BUNDLE_ID and IOS_URL_SCHEME come from brand/brand.json');
  assert.match(workflow, /brand\/brand\.json/);
  assert.doesNotMatch(workflow, /\^openchamber-/, 'the scheme guard is "the brand\'s scheme, never a legacy one"');
});

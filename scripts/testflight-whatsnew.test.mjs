import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { ascToken, baseSha, composeWhatsNew, createAsc, listChanges, trimToBytes, writeWhatsNew } from './testflight-whatsnew.mjs';

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim();

describe('ascToken', () => {
  it('signs ES256 in the raw r||s form JWS wants, with the claims ASC asks for', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const [header, payload, signature] = ascToken(pem, 'KEYID', 'ISSUER', 1000).split('.');
    assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'ES256', kid: 'KEYID', typ: 'JWT' });
    assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url')), { iss: 'ISSUER', iat: 1000, exp: 2200, aud: 'appstoreconnect-v1' });
    assert.equal(Buffer.from(signature, 'base64url').length, 64);
    assert.ok(verify('sha256', Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
  });
});

describe('createAsc', () => {
  it('throws on an errors body instead of letting a missing data read as "no builds"', async () => {
    const asc = createAsc(() => 't', async () => ({ ok: true, json: async () => ({ errors: [{ code: 'FORBIDDEN' }] }) }));
    await assert.rejects(asc('GET', '/apps'), /FORBIDDEN/);
  });
});

describe('text', () => {
  it('finds the commit an earlier build names, whichever locale carries it', () => {
    assert.equal(baseSha(['', 'Cambios de esta build 7 (commit abc1234def) · desde 0011223344']), 'abc1234def');
    assert.equal(baseSha(['', 'sin commit']), undefined);
  });

  it('cuts whole lines at the byte limit and says how many went', () => {
    const subjects = Array.from({ length: 200 }, (_, i) => `cambio ${i} con acentos: añadir lógica ñandú`);
    const text = composeWhatsNew(9, 'abcdef0123', '', subjects);
    assert.ok(Buffer.byteLength(text) <= 3800);
    assert.match(text, /\n… y \d+ cambios más$/);
    assert.ok(text.startsWith('Cambios de esta build 9 (commit abcdef0123)\n\n• cambio 0'));
    assert.ok(!text.includes('�'));
  });

  it('leaves a text that fits untouched', () => {
    assert.equal(trimToBytes('a\n\n• b'), 'a\n\n• b');
  });
});

describe('listChanges', () => {
  let repo;
  let first;
  before(() => {
    repo = mkdtempSync(path.join(os.tmpdir(), 'whatsnew-'));
    git(repo, 'init', '-q');
    for (const name of ['uno', 'dos', 'tres']) {
      writeFileSync(path.join(repo, name), name);
      git(repo, 'add', '-A');
      git(repo, 'commit', '-qm', `cambio ${name}`);
      if (name === 'uno') first = git(repo, 'rev-parse', 'HEAD');
    }
    git(repo, 'checkout', '-qb', 'pr', first);
    writeFileSync(path.join(repo, 'pr'), 'pr');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'cambio de la PR');
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'merge', '-q', '--no-ff', '-m', 'Merge pull request #1', 'pr');
  });
  after(() => rmSync(repo, { recursive: true, force: true }));

  it('lists the real subjects since the base, never the merge commit', () => {
    const { base, subjects } = listChanges(first, repo);
    assert.equal(base, first);
    assert.deepEqual(subjects.sort(), ['cambio de la PR', 'cambio dos', 'cambio tres']);
  });

  it('falls back to the latest commits when the base is unknown or absent', () => {
    for (const unknown of [undefined, '0123456789abcdef0123456789abcdef01234567']) {
      const { base, subjects } = listChanges(unknown, repo);
      assert.equal(base, '');
      assert.equal(subjects.length, 4);
    }
  });

  it('says so when the build is the same commit as the base', () => {
    const head = git(repo, 'rev-parse', 'HEAD');
    assert.deepEqual(listChanges(head, repo).subjects, ['Sin cambios de código desde la build anterior.']);
  });

  it('waits for the build, takes the base from the newest earlier text, patches what exists and creates the missing locale', async () => {
    const head = git(repo, 'rev-parse', '--short=10', 'HEAD');
    const calls = [];
    let polls = 0;
    const asc = async (method, route, body) => {
      calls.push(`${method} ${decodeURIComponent(route)}`);
      if (route.startsWith('/apps')) return { data: [{ id: 'APP' }] };
      if (route.includes('filter%5Bversion%5D=12')) return { data: ++polls < 3 ? [] : [{ id: 'B12' }] };
      if (route.includes('sort=')) return { data: [{ id: 'B12' }, { id: 'B11' }, { id: 'B10' }] };
      if (route === '/builds/B11/betaBuildLocalizations') return { data: [{ id: 'L11', attributes: { locale: 'en-US' } }] };
      if (route === '/builds/B10/betaBuildLocalizations') return { data: [{ id: 'L10', attributes: { locale: 'es-ES', whatsNew: `x (commit ${first.slice(0, 10)})` } }] };
      if (route === '/builds/B12/betaBuildLocalizations') return { data: [{ id: 'L12', attributes: { locale: 'en-US' } }] };
      calls.push(JSON.stringify(body));
      return { data: {} };
    };
    const text = await writeWhatsNew({ asc, bundleId: 'com.x', build: '12', locale: 'es-ES', waitMinutes: 25, cwd: repo, delayFn: async () => {} });
    assert.equal(polls, 3);
    assert.ok(text.startsWith(`Cambios de esta build 12 (commit ${head}) · desde ${first.slice(0, 10)}`));
    assert.ok(text.includes('• cambio de la PR') && !text.includes('cambio uno'));
    assert.ok(calls.includes('PATCH /betaBuildLocalizations/L12'));
    assert.ok(calls.includes('POST /betaBuildLocalizations'));
  });

  it('fails, not skips, when the build never shows up', async () => {
    const asc = async (_method, route) => (route.startsWith('/apps') ? { data: [{ id: 'APP' }] } : { data: [] });
    await assert.rejects(writeWhatsNew({ asc, bundleId: 'com.x', build: '1', locale: 'es-ES', waitMinutes: 0, cwd: repo, delayFn: async () => {} }), /no apareció/);
  });
});

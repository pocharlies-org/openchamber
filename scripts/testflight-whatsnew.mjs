#!/usr/bin/env node
// Writes the "What to Test" text of the TestFlight build that mobile-release.yml just
// uploaded. Rule (2026-10-03): no build reaches TestFlight without it, so a build whose
// text cannot be written is a red job.
//
// Recipe of the company's other iOS app (App Store Connect betaBuildLocalizations, per
// build and locale), in Node because the job already has it and node:crypto signs ES256
// JWTs without openssl glue.
//
// Range of commits: since the newest earlier build whose own text names its commit
// ("commit <sha>"). Build numbers here are run numbers, so unlike a commit-count scheme they cannot
// be counted back through git: the text written to App Store Connect is the only memory.
// No such build (first upload, or one without text) -> the last 20 commits.
//
//   ASC_KEY_PATH, ASC_KEY_ID, ASC_ISSUER_ID   App Store Connect API key (the .p8, PEM, as a file)
//   BUNDLE_ID, BUILD_NUMBER                   the build to describe
//   WHATSNEW_LOCALE (es-ES), WHATSNEW_WAIT_MIN (25: ASC needs ~10-20 min to process an upload)
//
// Exit codes: 0 text written, 1 not written, 2 bad input.

import { execFileSync } from 'node:child_process';
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const API = 'https://api.appstoreconnect.apple.com/v1';
// The field is capped at 4000; ASC rejected 4308 bytes with TOO_LONG, so cut by bytes with margin.
const LIMIT_BYTES = 3800;
const SHA_IN_TEXT = /commit ([0-9a-f]{7,40})\b/;

const query = (params) => `?${new URLSearchParams(params)}`;
const base64url = (text) => Buffer.from(text).toString('base64url');

/** ES256 JWT for the ASC API; `ieee-p1363` is the raw r||s form JWS wants, no DER unwrapping. */
export const ascToken = (keyPem, keyId, issuerId, now = Math.floor(Date.now() / 1000)) => {
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iss: issuerId, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' }));
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), { key: createPrivateKey(keyPem), dsaEncoding: 'ieee-p1363' });
  return `${header}.${payload}.${signature.toString('base64url')}`;
};

/** Raw ASC call; any HTTP error or `errors` body throws, so a missing `data` is never read as "no builds". */
export const createAsc = (token, fetchFn = fetch) => async (method, route, body) => {
  const response = await fetchFn(`${API}${route}`, {
    method,
    headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok || data.errors) {
    throw new Error(`App Store Connect ${method} ${route}: ${JSON.stringify(data.errors ?? response.status).slice(0, 600)}`);
  }
  return data;
};

/** The commit an earlier build's text names, if any. */
export const baseSha = (texts) => texts.map((text) => SHA_IN_TEXT.exec(text)?.[1]).find(Boolean);

/** Whole list lines only, never mid-line or mid-character, closed with a count of what was cut. */
export const trimToBytes = (text, limit = LIMIT_BYTES) => {
  if (Buffer.byteLength(text) <= limit) return text;
  const [headline, , ...items] = text.split('\n');
  for (let kept = items.length - 1; kept >= 0; kept--) {
    const candidate = [headline, '', ...items.slice(0, kept), `… y ${items.length - kept} cambios más`].join('\n');
    if (Buffer.byteLength(candidate) <= limit) return candidate;
  }
  return headline;
};

export const composeWhatsNew = (build, sha, base, subjects) =>
  trimToBytes([`Cambios de esta build ${build} (commit ${sha})${base ? ` · desde ${base.slice(0, 10)}` : ''}`, '', ...subjects.map((s) => `• ${s}`)].join('\n'));

const gitOut = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const reachable = (cwd, sha) => {
  try {
    gitOut(cwd, ['cat-file', '-e', `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
};

/** Subjects since `base`; merges are skipped (each PR enters as one), the real subjects are what a tester reads. */
export const listChanges = (base, cwd = process.cwd()) => {
  const log = (...range) => gitOut(cwd, ['log', '--no-merges', '--format=%s', ...range]).split('\n').filter(Boolean);
  if (!base || !reachable(cwd, base)) return { base: '', subjects: log('-20') };
  const subjects = log(`${base}..HEAD`);
  return { base, subjects: subjects.length ? subjects : ['Sin cambios de código desde la build anterior.'] };
};

/** Waits for ASC to process the build, then puts the text on every localization it has, and on `locale` if missing. */
export const writeWhatsNew = async ({ asc, bundleId, build, locale, waitMinutes, cwd, delayFn = delay }) => {
  const apps = await asc('GET', `/apps${query({ 'filter[bundleId]': bundleId })}`);
  const appId = apps.data[0]?.id;
  if (!appId) throw new Error(`no hay ficha para ${bundleId} en App Store Connect (My Apps → New App)`);

  const ios = { 'filter[app]': appId, 'filter[preReleaseVersion.platform]': 'IOS' };
  const deadline = Date.now() + waitMinutes * 60_000;
  const findBuild = async () => (await asc('GET', `/builds${query({ ...ios, 'filter[version]': build })}`)).data[0];
  let current = await findBuild();
  while (!current) {
    if (Date.now() >= deadline) throw new Error(`la build ${build} no apareció en App Store Connect en ${waitMinutes} min: la subida no llegó, y sin «Qué probar» no hay build`);
    await delayFn(60_000);
    current = await findBuild();
  }

  const earlier = (await asc('GET', `/builds${query({ ...ios, sort: '-uploadedDate', limit: '10' })}`)).data.filter((b) => b.id !== current.id);
  let base;
  for (const previous of earlier) {
    const localizations = await asc('GET', `/builds/${previous.id}/betaBuildLocalizations`);
    base = baseSha(localizations.data.map((l) => l.attributes.whatsNew ?? ''));
    if (base) break;
  }

  const sha = gitOut(cwd, ['rev-parse', '--short=10', 'HEAD']);
  const changes = listChanges(base, cwd);
  const whatsNew = composeWhatsNew(build, sha, changes.base, changes.subjects);

  const existing = (await asc('GET', `/builds/${current.id}/betaBuildLocalizations`)).data;
  for (const localization of existing) {
    await asc('PATCH', `/betaBuildLocalizations/${localization.id}`, { data: { type: 'betaBuildLocalizations', id: localization.id, attributes: { whatsNew } } });
  }
  if (!existing.some((l) => l.attributes.locale === locale)) {
    await asc('POST', '/betaBuildLocalizations', {
      data: { type: 'betaBuildLocalizations', attributes: { whatsNew, locale }, relationships: { build: { data: { type: 'builds', id: current.id } } } },
    });
  }
  return whatsNew;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { ASC_KEY_PATH, ASC_KEY_ID, ASC_ISSUER_ID, BUNDLE_ID, BUILD_NUMBER, WHATSNEW_LOCALE = 'es-ES', WHATSNEW_WAIT_MIN = '25' } = process.env;
  if (![ASC_KEY_PATH, ASC_KEY_ID, ASC_ISSUER_ID, BUNDLE_ID, BUILD_NUMBER].every(Boolean)) {
    console.error('::error::faltan ASC_KEY_PATH, ASC_KEY_ID, ASC_ISSUER_ID, BUNDLE_ID o BUILD_NUMBER');
    process.exit(2);
  }
  try {
    const keyPem = readFileSync(ASC_KEY_PATH);
    const asc = createAsc(() => ascToken(keyPem, ASC_KEY_ID, ASC_ISSUER_ID));
    const text = await writeWhatsNew({ asc, bundleId: BUNDLE_ID, build: BUILD_NUMBER, locale: WHATSNEW_LOCALE, waitMinutes: Number(WHATSNEW_WAIT_MIN), cwd: process.cwd() });
    console.log(`«Qué probar» escrito en la build ${BUILD_NUMBER}:\n${text}`);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}

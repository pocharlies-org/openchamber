#!/usr/bin/env node
// Moves the fork's own commits onto the newest upstream release tag.
//
// Called by .github/workflows/upstream-sync.yml; every input arrives through
// the environment so the workflow never interpolates event data into a shell.
// Decisions and limits (token, workflow files): docs/upstream-sync.md.
//
//   SYNC_TARGET        branch carrying the own commits (default: main)
//   SYNC_UPSTREAM_URL  where upstream tags are fetched from
//   SYNC_UPSTREAM_REF  tag to sync to (default: newest vX.Y.Z upstream tag)
//   SYNC_REPORT_FILE   markdown report, used as issue / PR body
//   GITHUB_OUTPUT      status, tag, branch, pushable (when set)
//
// Subcommands (after the sync, same checkout): `publish-pr` pushes the sync
// branch and opens the PR, `publish-issue` delivers the report as an issue or, where
// issues are disabled, as a pull request. They use the REST API with GH_TOKEN
// because the arc-k8s image has no `gh`.
//
// Exit codes: 0 = up to date or clean, 1 = conflict, 2 = bad input.

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;
const SAFE_REF = /^[A-Za-z0-9._/-]+$/;
const IDENTITY = ['-c', 'user.name=upstream-sync', '-c', 'user.email=upstream-sync@users.noreply.github.com'];

const git = (cwd, args, options = {}) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();

const lines = (text) => (text ? text.split('\n') : []);

const commitLine = (cwd, sha) => git(cwd, ['log', '-1', '--format=%h %s', sha]);

// Everything fetched from upstream lives in its own namespace, so what counts as
// "upstream" never depends on the fork's branches or on tags the fork made itself.
const UPSTREAM_TAGS = 'refs/upstream/tags';
const UPSTREAM_HEAD = 'refs/upstream/head';

/** Newest `vX.Y.Z` upstream tag first; prereleases are not sync targets. */
const releaseTags = (cwd, args = []) =>
  lines(git(cwd, ['for-each-ref', '--sort=-v:refname', '--format=%(refname:strip=3)', ...args, UPSTREAM_TAGS])).filter((t) => RELEASE_TAG.test(t));

/**
 * The fork's own commits: reachable from the target and from nothing upstream
 * (any tag, or its default branch: a merge -s ours can pull in unreleased
 * upstream work), minus what an earlier sync already carried. That is told by
 * content, never by how the sync PR was merged: `cherry-pick -x` leaves
 * "(cherry picked from commit <sha>)" in every carried commit, so the originals
 * named there are dropped; and `--cherry-pick` drops copies of upstream commits
 * (a rebase merge replays the sync branch, upstream history included).
 */
const ownCommits = (cwd, targetRef) => {
  // Two passes on purpose: with the tags as extra negatives the upstream side of the
  // patch comparison would lose exactly the commits a rebase-merged copy mirrors.
  const notCopies = new Set(lines(git(cwd, ['rev-list', '--no-merges', '--cherry-pick', '--right-only', `${UPSTREAM_HEAD}...${targetRef}`])));
  const candidates = lines(git(cwd, ['rev-list', '--reverse', '--no-merges', targetRef, '--not', UPSTREAM_HEAD, `--glob=${UPSTREAM_TAGS}/*`])).filter((sha) => notCopies.has(sha));
  if (!candidates.length) return candidates;
  const messages = git(cwd, ['log', '--no-walk=unsorted', '--stdin', '--format=%B'], { input: `${candidates.join('\n')}\n`, stdio: ['pipe', 'pipe', 'pipe'] });
  const carried = new Set([...messages.matchAll(/\(cherry picked from commit ([0-9a-f]{40})\)/g)].map((m) => m[1]));
  return candidates.filter((sha) => !carried.has(sha));
};

const renderReport = ({ status, tag, baseTag, target, branch, applied, conflict, remaining, touchesWorkflows }) => {
  const out = [`# Sync de upstream a ${tag}`, '', `Rama propia: \`${target}\` · tag actual: \`${baseTag}\` · tag nuevo: \`${tag}\``, ''];
  if (status === 'conflict') {
    out.push(`## Conflicto en \`${conflict.commit}\``, '', 'Ficheros en conflicto:', ...conflict.files.map((f) => `- \`${f}\``), '');
    if (remaining.length) out.push('Commits propios sin aplicar (tras el conflicto):', ...remaining.map((c) => `- ${c}`), '');
  }
  out.push(`## Commits propios aplicados (${applied.length})`, '', ...(applied.length ? applied.map((c) => `- ${c}`) : ['- ninguno']), '');
  if (status === 'clean') out.push('## Cómo fusionar', '', 'Fusionar con merge commit o rebase, nunca squash: el siguiente sync reconoce lo ya llevado por los `(cherry picked from commit …)` de estos commits, y un squash los pierde.', '');
  if (status === 'clean' && touchesWorkflows) {
    out.push('## Sin push automático', '', `El diff de \`${baseTag}..${tag}\` toca \`.github/workflows\` y \`GITHUB_TOKEN\` no puede empujarlo. La rama \`${branch}\` se ha construido sin conflictos pero no se ha publicado: ver docs/upstream-sync.md.`, '');
  }
  return out.join('\n');
};

/**
 * @returns {{status: 'up-to-date'|'clean'|'conflict', tag: string, baseTag: string, branch: string,
 *   applied: string[], conflict?: {commit: string, files: string[]}, touchesWorkflows: boolean, report: string}}
 */
export const runSync = ({ repoDir, target = 'main', upstreamUrl, upstreamRef = '' }) => {
  if (!SAFE_REF.test(target) || (upstreamRef && !RELEASE_TAG.test(upstreamRef))) {
    throw new Error(`invalid target or upstream ref: ${target} ${upstreamRef}`);
  }
  const targetRef = `origin/${target}`;
  git(repoDir, ['fetch', '--no-tags', upstreamUrl, `+refs/tags/*:${UPSTREAM_TAGS}/*`, `+HEAD:${UPSTREAM_HEAD}`]);

  const allTags = releaseTags(repoDir);
  const baseTag = releaseTags(repoDir, ['--merged', targetRef])[0];
  const tag = upstreamRef || allTags[0];
  if (!baseTag || !tag || !allTags.includes(tag)) throw new Error(`no upstream release tag found (base ${baseTag}, wanted ${tag})`);
  const branch = `sync/upstream-${tag}`;
  const result = { tag, baseTag, branch, applied: [], touchesWorkflows: false };

  // Synced = every commit of the tag is in the target or has a patch-equivalent there
  // (ancestry alone misses a sync PR merged by rebase, whose commits are copies).
  const missing = git(repoDir, ['rev-list', '--no-merges', '--cherry-pick', '--right-only', '--count', `${targetRef}...${UPSTREAM_TAGS}/${tag}`]);
  if (allTags.indexOf(tag) >= allTags.indexOf(baseTag) || missing === '0') {
    return { ...result, status: 'up-to-date', report: `# Sync de upstream\n\n\`${target}\` ya tiene \`${tag}\` (última base: \`${baseTag}\`); nada que sincronizar.\n` };
  }

  const own = ownCommits(repoDir, targetRef);
  git(repoDir, ['checkout', '-q', '-B', branch, `${UPSTREAM_TAGS}/${tag}`]);
  for (const [index, sha] of own.entries()) {
    try {
      git(repoDir, [...IDENTITY, 'cherry-pick', '--allow-empty', '--keep-redundant-commits', '-x', sha]);
      result.applied.push(commitLine(repoDir, sha));
    } catch (error) {
      const files = lines(git(repoDir, ['diff', '--name-only', '--diff-filter=U']));
      if (!files.length) throw error; // a failure that is not a conflict must not read as one
      git(repoDir, ['cherry-pick', '--abort']);
      git(repoDir, ['checkout', '-q', '--detach', targetRef]);
      git(repoDir, ['branch', '-D', branch]);
      const conflict = { commit: commitLine(repoDir, sha), files };
      const remaining = own.slice(index + 1).map((s) => commitLine(repoDir, s));
      return { ...result, status: 'conflict', conflict, report: renderReport({ ...result, status: 'conflict', target, conflict, remaining }) };
    }
  }

  // GITHUB_TOKEN cannot push workflow changes: decide from what the push would add to the target.
  result.touchesWorkflows = git(repoDir, ['diff', '--name-only', targetRef, branch, '--', '.github/workflows']) !== '';
  return { ...result, status: 'clean', report: renderReport({ ...result, status: 'clean', target }) };
};

/** GitHub REST client for the running repository; `fetchFn` is injectable so tests never touch the network. */
export const createApi = ({ fetchFn = fetch, repository = process.env.GITHUB_REPOSITORY, token = process.env.GH_TOKEN } = {}) =>
  async (method, route, body) => {
    const response = await fetchFn(`https://api.github.com/repos/${repository}${route}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
      body: body && JSON.stringify(body),
    });
    if (!response.ok) throw Object.assign(new Error(`${method} ${route}: ${response.status} ${await response.text()}`), { status: response.status });
    return response.json();
  };

const gitPush = (repoDir, branch) => {
  const basic = Buffer.from(`x-access-token:${process.env.GH_TOKEN}`).toString('base64');
  git(repoDir, ['push', 'origin', `${branch}:refs/heads/${branch}`], {
    env: { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}` },
  });
};

/** Pushes the sync branch (never forced: if it exists remotely, a PR is already in flight) and opens the PR. */
const publishPr = async ({ repoDir, target, branch, tag, report, api = createApi() }) => {
  if (git(repoDir, ['ls-remote', 'origin', `refs/heads/${branch}`])) {
    console.log(`${branch} already exists on origin; nothing to publish.`);
    return;
  }
  gitPush(repoDir, branch);
  try {
    const pr = await api('POST', '/pulls', { title: `sync: upstream ${tag}`, head: branch, base: target, body: report });
    console.log(`PR opened: ${pr.html_url}`);
  } catch (error) {
    // The branch is already on origin; the report is in the run summary. Typical cause: the repo
    // setting "Allow GitHub Actions to create pull requests" is off.
    console.error(`::error::branch ${branch} pushed but the PR could not be opened: ${error.message}`);
    throw error;
  }
};

const issueChannel = async ({ api, tag, status, report }) => {
  const title = `Sync de upstream ${tag}: ${status === 'conflict' ? 'conflicto' : 'push manual'}`;
  const open = await api('GET', '/issues?state=open&per_page=100');
  const existing = open.find((issue) => !issue.pull_request && issue.title === title);
  const result = existing
    ? await api('POST', `/issues/${existing.number}/comments`, { body: report })
    : await api('POST', '/issues', { title, body: report });
  return result.html_url;
};

/**
 * Same report, on a pull request, for repositories with issues turned off.
 * Order: the open sync PR of this tag, else the open report PR of this tag, else a
 * new report PR from `sync/upstream-<tag>-report` (the target plus one empty commit,
 * because a conflicted sync leaves no branch of its own).
 */
const pullRequestChannel = async ({ api, repoDir, target, tag, report, pushReportBranch }) => {
  const open = await api('GET', '/pulls?state=open&per_page=100');
  const mine = open.filter((pr) => pr.head?.ref === `sync/upstream-${tag}` || pr.head?.ref === `sync/upstream-${tag}-report`);
  const existing = mine.find((pr) => pr.head.ref === `sync/upstream-${tag}`) ?? mine[0];
  if (existing) return (await api('POST', `/issues/${existing.number}/comments`, { body: report })).html_url;
  const reportBranch = `sync/upstream-${tag}-report`;
  await pushReportBranch(repoDir, target, reportBranch);
  const pr = await api('POST', '/pulls', { title: `sync: informe de upstream ${tag}`, head: reportBranch, base: target, body: report, draft: true });
  return pr.html_url;
};

const pushEmptyReportBranch = (repoDir, target, branch) => {
  git(repoDir, ['checkout', '-q', '-B', branch, `origin/${target}`]);
  git(repoDir, [...IDENTITY, 'commit', '-q', '--allow-empty', '-m', `sync report ${branch}`]);
  gitPush(repoDir, branch);
};

/**
 * Delivers the report outside the run. The run summary is always written by the
 * workflow; this adds a durable copy where someone will look: an issue, and where
 * the repository has issues disabled (or the call fails), a pull request.
 * @returns {Promise<{delivered: boolean, channel?: string, url?: string, errors: string[]}>}
 */
export const publishReport = async ({ api, repoDir, target, tag, status, report, pushReportBranch = pushEmptyReportBranch, log = console }) => {
  const errors = [];
  for (const [channel, run] of [
    ['issue', () => issueChannel({ api, tag, status, report })],
    ['pull-request', () => pullRequestChannel({ api, repoDir, target, tag, report, pushReportBranch })],
  ]) {
    try {
      const url = await run();
      log.log(`Report delivered as ${channel}: ${url}`);
      return { delivered: true, channel, url, errors };
    } catch (error) {
      errors.push(`${channel}: ${error.message}`);
      log.warn(`::warning::report channel ${channel} failed: ${error.message}`);
    }
  }
  log.error('::error::the report reached no channel outside this run; it is in the run summary');
  return { delivered: false, errors };
};

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const env = process.env;
  const [subcommand] = process.argv.slice(2);
  if (subcommand) {
    const common = { repoDir: process.cwd(), target: env.SYNC_TARGET, tag: env.SYNC_TAG, report: readFileSync(env.SYNC_REPORT_FILE, 'utf8') };
    if (subcommand === 'publish-pr') {
      await publishPr({ ...common, branch: env.SYNC_BRANCH });
    } else if (subcommand === 'publish-issue') {
      const outcome = await publishReport({ ...common, api: createApi(), status: env.SYNC_STATUS });
      process.exit(outcome.delivered ? 0 : 1);
    } else {
      console.error(`::error::unknown subcommand ${subcommand}`);
      process.exit(2);
    }
    process.exit(0);
  }
  let result;
  try {
    result = runSync({
      repoDir: process.cwd(),
      target: env.SYNC_TARGET || 'main',
      upstreamUrl: env.SYNC_UPSTREAM_URL || 'https://github.com/openchamber/openchamber.git',
      upstreamRef: env.SYNC_UPSTREAM_REF || '',
    });
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(2);
  }
  console.log(result.report);
  if (env.SYNC_REPORT_FILE) writeFileSync(env.SYNC_REPORT_FILE, result.report);
  if (env.GITHUB_OUTPUT) {
    const pushable = result.status === 'clean' && !result.touchesWorkflows;
    appendFileSync(env.GITHUB_OUTPUT, `status=${result.status}\ntag=${result.tag}\nbranch=${result.branch}\npushable=${pushable}\n`);
  }
  process.exit(result.status === 'conflict' ? 1 : 0);
}

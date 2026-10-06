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
// branch and opens the PR, `publish-issue` opens (or updates) the conflict
// issue. They use the REST API with GH_TOKEN because the arc-k8s image has no `gh`.
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

/** Newest `vX.Y.Z` tag first; prereleases are not sync targets. */
const releaseTags = (cwd, args) => lines(git(cwd, ['tag', '--sort=-v:refname', '-l', 'v[0-9]*', ...args])).filter((t) => RELEASE_TAG.test(t));

const renderReport = ({ status, tag, baseTag, target, branch, applied, conflict, remaining, touchesWorkflows }) => {
  const out = [`# Sync de upstream a ${tag}`, '', `Rama propia: \`${target}\` · tag actual: \`${baseTag}\` · tag nuevo: \`${tag}\``, ''];
  if (status === 'conflict') {
    out.push(`## Conflicto en \`${conflict.commit}\``, '', 'Ficheros en conflicto:', ...conflict.files.map((f) => `- \`${f}\``), '');
    if (remaining.length) out.push('Commits propios sin aplicar (tras el conflicto):', ...remaining.map((c) => `- ${c}`), '');
  }
  out.push(`## Commits propios aplicados (${applied.length})`, '', ...(applied.length ? applied.map((c) => `- ${c}`) : ['- ninguno']), '');
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
  git(repoDir, ['fetch', '--no-tags', upstreamUrl, '+refs/tags/*:refs/tags/*']);

  const baseTag = releaseTags(repoDir, ['--merged', targetRef])[0];
  const tag = upstreamRef || releaseTags(repoDir, [])[0];
  if (!baseTag || !tag) throw new Error('no upstream release tag found');
  const branch = `sync/upstream-${tag}`;
  const result = { tag, baseTag, branch, applied: [], touchesWorkflows: false };

  const isNewer = baseTag !== tag && git(repoDir, ['tag', '--sort=-v:refname', '-l', baseTag, tag]).split('\n')[0] === tag;
  if (!isNewer) {
    return { ...result, status: 'up-to-date', report: `# Sync de upstream\n\n\`${target}\` ya contiene \`${baseTag}\`; nada que sincronizar.\n` };
  }

  const own = lines(git(repoDir, ['rev-list', '--reverse', '--no-merges', `${baseTag}..${targetRef}`]));
  git(repoDir, ['checkout', '-q', '-B', branch, tag]);
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

const api = async (method, route, body) => {
  const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${process.env.GH_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
    body: body && JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${route}: ${response.status} ${await response.text()}`);
  return response.json();
};

/** Pushes the sync branch (never forced: if it exists remotely, a PR is already in flight) and opens the PR. */
const publishPr = async ({ repoDir, target, branch, tag, report }) => {
  if (git(repoDir, ['ls-remote', 'origin', `refs/heads/${branch}`])) {
    console.log(`${branch} already exists on origin; nothing to publish.`);
    return;
  }
  const basic = Buffer.from(`x-access-token:${process.env.GH_TOKEN}`).toString('base64');
  git(repoDir, ['push', 'origin', `${branch}:refs/heads/${branch}`], {
    env: { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}` },
  });
  const pr = await api('POST', '/pulls', { title: `sync: upstream ${tag}`, head: branch, base: target, body: report });
  console.log(`PR opened: ${pr.html_url}`);
};

const publishIssue = async ({ tag, report }) => {
  const title = `Sync de upstream ${tag}: ${process.env.SYNC_STATUS === 'conflict' ? 'conflicto' : 'push manual'}`;
  const open = await api('GET', '/issues?state=open&per_page=100');
  const existing = open.find((issue) => !issue.pull_request && issue.title === title);
  const result = existing
    ? await api('POST', `/issues/${existing.number}/comments`, { body: report })
    : await api('POST', '/issues', { title, body: report });
  console.log(`Issue: ${result.html_url}`);
};

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const env = process.env;
  const [subcommand] = process.argv.slice(2);
  if (subcommand) {
    const publish = { 'publish-pr': publishPr, 'publish-issue': publishIssue }[subcommand];
    if (!publish) {
      console.error(`::error::unknown subcommand ${subcommand}`);
      process.exit(2);
    }
    await publish({ repoDir: process.cwd(), target: env.SYNC_TARGET, branch: env.SYNC_BRANCH, tag: env.SYNC_TAG, report: readFileSync(env.SYNC_REPORT_FILE, 'utf8') });
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

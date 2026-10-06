import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { runSync } from './upstream-sync.mjs';

const SCRIPT = fileURLToPath(new URL('./upstream-sync.mjs', import.meta.url));
const root = mkdtempSync(path.join(os.tmpdir(), 'upstream-sync-'));

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim();

const commit = (cwd, file, content, message) => {
  mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  writeFileSync(path.join(cwd, file), content);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-qm', message);
};

/** upstream: v1.0.0 -> v1.1.0 (rewrites a.txt line, touches a workflow when asked). fork: clone with own commits. */
const makeFixture = (name, { ownEdits, upstreamWorkflow = false, pullUnreleased = false }) => {
  const upstream = path.join(root, `${name}-upstream`);
  const fork = path.join(root, `${name}-fork`);
  mkdirSync(upstream);
  git(upstream, 'init', '-q');
  commit(upstream, 'a.txt', 'one\ntwo\nthree\n', 'upstream: base');
  git(upstream, 'tag', 'v1.0.0');
  commit(upstream, 'a.txt', 'one\nTWO upstream\nthree\n', 'upstream: edit two');
  if (upstreamWorkflow) commit(upstream, '.github/workflows/ci.yml', 'name: ci\n', 'upstream: workflow');
  git(upstream, 'tag', 'v1.1.0');
  let unreleased;
  if (pullUnreleased) {
    // main moves past v1.1.0; the next tag comes from a hotfix branch that does not contain that work
    commit(upstream, 'unreleased.txt', 'x\n', 'upstream: unreleased');
    unreleased = git(upstream, 'rev-parse', 'HEAD');
    git(upstream, 'checkout', '-q', '-b', 'hotfix', 'v1.1.0');
    commit(upstream, 'hotfix.txt', 'h\n', 'upstream: hotfix');
    git(upstream, 'tag', 'v1.1.1');
    git(upstream, 'checkout', '-q', 'main');
  }
  git(root, 'clone', '-q', upstream, fork);
  git(fork, 'checkout', '-q', '-B', 'main', 'v1.0.0');
  for (const [file, content, message] of ownEdits) commit(fork, file, content, message);
  // merge -s ours: the fork takes upstream's unreleased history without its content
  if (pullUnreleased) git(fork, 'merge', '-q', '-s', 'ours', unreleased, '-m', 'merge: upstream unreleased (ours)');
  git(fork, 'update-ref', 'refs/remotes/origin/main', 'main'); // the workflow checkout has origin/<target>
  git(fork, 'tag', '-d', 'v1.1.0'); // the fork has not seen the new tag yet
  return { upstream, fork };
};

const clean = [['own/b.txt', 'b\n', 'own: add b'], ['own/c.txt', 'c\n', 'own: add c']];
const conflicting = [['own/b.txt', 'b\n', 'own: add b'], ['a.txt', 'one\nTWO own\nthree\n', 'own: edit two'], ['own/c.txt', 'c\n', 'own: add c']];

describe('upstream-sync', () => {
  after(() => rmSync(root, { recursive: true, force: true }));

  it('applies every own commit on the new tag', () => {
    const { upstream, fork } = makeFixture('clean', { ownEdits: clean });
    const result = runSync({ repoDir: fork, upstreamUrl: upstream });
    assert.equal(result.status, 'clean');
    assert.equal(result.tag, 'v1.1.0');
    assert.equal(result.applied.length, 2);
    assert.equal(result.touchesWorkflows, false);
    git(fork, 'merge-base', '--is-ancestor', 'refs/upstream/tags/v1.1.0', result.branch);
    assert.match(result.report, /own: add b/);
    assert.match(result.report, /merge commit o rebase, nunca squash/);
  });

  it('does not treat upstream commits pulled in with merge -s ours as own', () => {
    const { upstream, fork } = makeFixture('ours', { ownEdits: clean, pullUnreleased: true });
    const result = runSync({ repoDir: fork, upstreamUrl: upstream });
    assert.equal(result.status, 'clean');
    assert.equal(result.tag, 'v1.1.1');
    assert.deepEqual(result.applied.map((c) => c.slice(8)), ['own: add b', 'own: add c']);
  });

  it('ignores a fork-made tag that looks like a release', () => {
    const { upstream, fork } = makeFixture('forktag', { ownEdits: clean });
    git(fork, 'tag', 'v9.9.9', 'main');
    const result = runSync({ repoDir: fork, upstreamUrl: upstream });
    assert.equal(result.tag, 'v1.1.0');
    assert.equal(result.baseTag, 'v1.0.0');
  });

  it('a second sync after the first PR was merged carries each own commit once', () => {
    const { upstream, fork } = makeFixture('second', { ownEdits: clean });
    const first = runSync({ repoDir: fork, upstreamUrl: upstream });
    assert.equal(first.status, 'clean');
    // the sync PR lands as a merge commit, as docs/upstream-sync.md requires
    git(fork, 'checkout', '-q', 'main');
    git(fork, 'merge', '-q', '--no-ff', first.branch, '-m', `Merge pull request #1 from fork/${first.branch}`);
    git(fork, 'update-ref', 'refs/remotes/origin/main', 'main');
    commit(upstream, 'a.txt', 'one\nTWO upstream\nthree\nfour\n', 'upstream: edit four');
    git(upstream, 'tag', 'v1.2.0');

    const second = runSync({ repoDir: fork, upstreamUrl: upstream });
    assert.equal(second.status, 'clean');
    assert.equal(second.tag, 'v1.2.0');
    assert.deepEqual(second.applied.map((c) => c.slice(8)), ['own: add b', 'own: add c']);
    assert.equal(git(fork, 'rev-list', '--count', 'refs/upstream/tags/v1.2.0..' + second.branch), '2');
  });

  it('keeps an own commit that lands on main between cutting the sync branch and merging its PR', () => {
    const { upstream, fork } = makeFixture('between', { ownEdits: clean });
    const first = runSync({ repoDir: fork, upstreamUrl: upstream });
    git(fork, 'checkout', '-q', 'main');
    commit(fork, 'own/x.txt', 'x\n', 'own: added while the sync PR was open');
    git(fork, 'merge', '-q', '--no-ff', first.branch, '-m', `Merge pull request #1 from fork/${first.branch}`);
    git(fork, 'update-ref', 'refs/remotes/origin/main', 'main');
    commit(upstream, 'a.txt', 'one\nTWO upstream\nthree\nfour\n', 'upstream: edit four');
    git(upstream, 'tag', 'v1.2.0');

    const second = runSync({ repoDir: fork, upstreamUrl: upstream });
    assert.deepEqual(second.applied.map((c) => c.slice(8)).sort(), ['own: add b', 'own: add c', 'own: added while the sync PR was open']);
  });

  it('a sync PR merged by rebase is recognised as synced and carries each own commit once', () => {
    const { upstream, fork } = makeFixture('rebase', { ownEdits: clean });
    const first = runSync({ repoDir: fork, upstreamUrl: upstream });
    // rebase merge: every commit of the PR replayed on main, upstream history included
    git(fork, 'checkout', '-q', 'main');
    git(fork, 'cherry-pick', '--allow-empty', '--keep-redundant-commits', `refs/upstream/tags/v1.0.0..${first.branch}`);
    git(fork, 'update-ref', 'refs/remotes/origin/main', 'main');
    assert.equal(runSync({ repoDir: fork, upstreamUrl: upstream }).status, 'up-to-date');

    commit(upstream, 'a.txt', 'one\nTWO upstream\nthree\nfour\n', 'upstream: edit four');
    git(upstream, 'tag', 'v1.2.0');
    const second = runSync({ repoDir: fork, upstreamUrl: upstream });
    assert.equal(second.status, 'clean');
    assert.deepEqual(second.applied.map((c) => c.slice(8)), ['own: add b', 'own: add c']);
  });

  it('flags a tag that changes workflows so the run does not push', () => {
    const { upstream, fork } = makeFixture('wf', { ownEdits: clean, upstreamWorkflow: true });
    const result = runSync({ repoDir: fork, upstreamUrl: upstream });
    assert.equal(result.status, 'clean');
    assert.equal(result.touchesWorkflows, true);
  });

  it('reports a forced conflict: files, applied commits, and exit 1', () => {
    const { upstream, fork } = makeFixture('conflict', { ownEdits: conflicting });
    const result = runSync({ repoDir: fork, upstreamUrl: upstream });
    assert.equal(result.status, 'conflict');
    assert.deepEqual(result.conflict.files, ['a.txt']);
    assert.match(result.conflict.commit, /own: edit two/);
    assert.equal(result.applied.length, 1);
    assert.match(result.report, /- `a\.txt`/);
    assert.match(result.report, /own: add b/);
    assert.match(result.report, /own: add c/); // listed as not applied

    const cli = spawnSync('node', [SCRIPT], { cwd: fork, encoding: 'utf8', env: { ...process.env, SYNC_UPSTREAM_URL: upstream } });
    assert.equal(cli.status, 1);
    assert.match(cli.stdout, /a\.txt/);
  });

  it('does nothing when the target already has the newest tag', () => {
    const { upstream, fork } = makeFixture('uptodate', { ownEdits: clean });
    const result = runSync({ repoDir: fork, upstreamUrl: upstream, upstreamRef: 'v1.0.0' });
    assert.equal(result.status, 'up-to-date');
  });

  it('rejects a ref that is not a release tag', () => {
    const { upstream, fork } = makeFixture('badref', { ownEdits: clean });
    assert.throws(() => runSync({ repoDir: fork, upstreamUrl: upstream, upstreamRef: '$(id)' }), /invalid/);
  });
});

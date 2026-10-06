# Upstream sync

The fork keeps its own commits on `main`, on top of the newest release tag of
`openchamber/openchamber`. `.github/workflows/upstream-sync.yml` moves them to
each new tag; the logic lives in `scripts/upstream-sync.mjs` and is tested in
`scripts/upstream-sync.test.mjs` (a forced conflict on a fixture repository).

## What a run does

1. Fetches upstream tags and syncs to `upstream_ref` (pinned, see below; without one it would take the newest `vX.Y.Z`).
2. Takes the own commits: reachable from `origin/<target>`, from no upstream tag and not
   from upstream's default branch (so work pulled in with `merge -s ours` is never "own"),
   and not already carried by an earlier sync: `cherry-pick -x` leaves
   `(cherry picked from commit <sha>)` in each carried commit, so the originals it names are
   dropped, whatever way the sync PR was merged (merge commit or rebase; a squash cannot be
   told apart from new work). Upstream refs are fetched into
   `refs/upstream/*`, so fork-made tags never count as releases.
3. Builds `sync/upstream-<tag>` at the new tag and cherry-picks them in order.
4. Clean: pushes the branch and opens a PR against `main` listing every applied commit.
5. Conflict: aborts, deletes the local branch, **the run ends in `failure`**, and the
   report lists the conflicting files, the commits applied before it and the ones left.

## Where the report goes

The report never depends on a repository feature being on. It always goes to the run
summary (`$GITHUB_STEP_SUMMARY`) and, outside a dry run, to the first of these that works:

1. an **issue** (`Sync de upstream <tag>: conflicto` / `push manual`; a second run comments
   on the open one);
2. a **pull request**, when issues are disabled or the call fails: a comment on the open
   `sync/upstream-<tag>` PR, else on the open `sync/upstream-<tag>-report` PR, else a new
   draft PR from `sync/upstream-<tag>-report` (the target plus one empty commit, since a
   conflicted sync leaves no branch of its own).

If neither works the step fails and the summary still has the report. A conflict fails the
run in any case, so a missing report is never a green run. This repository has issues
disabled today (found by qa on the first dry run), so path 2 is the live one until the CTO
asks for them in the repository settings. Opening the sync PR needs "Allow GitHub Actions
to create pull requests"; if that setting is off, the branch is pushed, the step fails with
the reason, and the summary has the report.

## Pinned tag

`upstream_ref` defaults to **v2.1.0** in `workflow_dispatch` and in the cron, so the sync
reports "up to date" until the product call is made: syncing to v2.1.1 conflicts for real
(14 files, first own commit `declarative side conversations`) because the fork's own side
chat and upstream's `/btw` overlap. Moving the pin is a one-line change in two places of
`upstream-sync.yml` once that is decided. To see the conflict report on demand:
`workflow_dispatch` with `upstream_ref: v2.1.1`.

Triggers: Monday 05:17 UTC (`schedule`) and `workflow_dispatch`. Dispatch inputs:
`dry_run` (default true: report in the run summary, no push, no PR, no issue; a
conflict still fails the run), `target` (branch carrying the stack) and
`upstream_ref`. Never `pull_request`: the job has write permissions.
Re-running for a tag whose branch is already on `origin` does nothing.

## Merging a sync PR

Merge commit or rebase, never squash. The next run tells what was already carried by the
`(cherry picked from commit …)` lines in the commits; a squash folds them into one message
and the old commits would be carried again. The PR description says so.

## Decision: report-only when the tag touches workflows (2026-10-06)

`GITHUB_TOKEN` cannot push commits that change `.github/workflows/`. When the diff
of the new branch against `main` touches that folder, the run **builds the branch,
does not push it, and publishes the report** (see above). Someone pushes the branch
by hand (`git fetch`, then push `sync/upstream-<tag>` as the same name) after reading it.

Why not a GitHub App token now: it needs a secret in `environment: upstream-sync`
with manual approval, written by `devops` and validated by `security`, and the
acceptance criterion for this workflow allows no secret beyond `GITHUB_TOKEN`.
Option (a) stays the preferred upgrade: when that environment and key exist, the
`publish-pr` step swaps `GH_TOKEN` for the app token and the report-only branch
goes away. Nothing else in the script changes.

Two consequences of using `GITHUB_TOKEN`, both by design of GitHub:

- A PR opened with it does not trigger `pull_request` workflows. To get the checks,
  run `fork-pr-checks` by `workflow_dispatch` on the sync branch.
- The repository setting "Allow GitHub Actions to create pull requests" must be on.

## Contracts the sync must not move

`~/.local/openchamber` (releases, `current`, `beta`, bin, ports) and session /
filing ids are consumed outside the repo; the sync only rewrites source commits.
A conflict in `packages/web/server/lib/claude/` or `session-folders/` is resolved
keeping those behaviours.

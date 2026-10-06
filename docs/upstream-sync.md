# Upstream sync

The fork keeps its own commits on `main`, on top of the newest release tag of
`openchamber/openchamber`. `.github/workflows/upstream-sync.yml` moves them to
each new tag; the logic lives in `scripts/upstream-sync.mjs` and is tested in
`scripts/upstream-sync.test.mjs` (a forced conflict on a fixture repository).

## What a run does

1. Fetches upstream tags and finds the newest `vX.Y.Z` tag (or `upstream_ref`).
2. Takes the own commits: reachable from `origin/<target>`, from no upstream tag and not
   from upstream's default branch (so work pulled in with `merge -s ours` is never "own"),
   and not already carried by an earlier sync (see below). Upstream refs are fetched into
   `refs/upstream/*`, so fork-made tags never count as releases.
3. Builds `sync/upstream-<tag>` at the new tag and cherry-picks them in order.
4. Clean: pushes the branch and opens a PR against `main` listing every applied commit.
5. Conflict: aborts, deletes the local branch, **the run ends in `failure`**, and an
   issue lists the conflicting files, the commits applied before it and the ones left.

Triggers: Monday 05:17 UTC (`schedule`) and `workflow_dispatch`. Dispatch inputs:
`dry_run` (default true: report in the run summary, no push, no PR, no issue; a
conflict still fails the run), `target` (branch carrying the stack) and
`upstream_ref`. Never `pull_request`: the job has write permissions.
Re-running for a tag whose branch is already on `origin` does nothing.

## Merging a sync PR

Merge it with a **merge commit** (the default PR title `Merge pull request … from …/sync/upstream-<tag>`
is what the next run looks for). The next sync excludes everything reachable from the first
parent of the latest such merge, so each own commit is carried once. A squash or rebase merge
loses that marker and the next run would carry the old commits again.

## Decision: report-only when the tag touches workflows (2026-10-06)

`GITHUB_TOKEN` cannot push commits that change `.github/workflows/`. When the diff
of the new branch against `main` touches that folder, the run **builds the branch,
does not push it, and opens an issue** with the report. Someone pushes the branch
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

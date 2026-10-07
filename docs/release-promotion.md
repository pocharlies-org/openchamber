# Release promotion runbook

How a GitHub Release of this fork becomes the web app the company runs from
`~/.local/openchamber` on the x86 host. Since DGX-516 the fork's own
`release.yml` builds everything, and promotion is a deliberate, separate step.
Nothing in CI touches `~/.local/openchamber`.

The invariants that must survive every promotion: `current` and `beta` stay
symlinks under `~/.local/openchamber`, `.anterior` keeps pointing at the
previous release, `backups/` is never rewritten, and the `openchamber` binary
path never moves. A new path is a new entry next to the old one, not a move.

## Cut a release

Push a `v*` tag, or run `Release` manually with an empty `version` to build the
current `package.json` version. Publishing jobs sit behind the protected
`release` environment, so a run needs a human approval before it uploads.
If the version already has a release, bump the version first.

The run uploads, among others, `openchamber-sdk-<version>.tgz` and
`openchamber-web-<version>.tgz`. Install from those two files, never from the
npm registry: the registry copy of `@openchamber/sdk` is upstream's, and a
fork install that pulls it mixes two stacks.

## Install a release (no traffic yet)

`ID` is the release workflow run id (visible in the run URL).

```bash
VERSION=2.1.2
ID=<run-id>
R="$HOME/.local/openchamber/releases/$ID"
mkdir -p "$R"
gh release download "v$VERSION" -R pocharlies-org/openchamber -p '*.tgz' -D "/tmp/oc-$ID"
npm install --global --prefix "$R" "/tmp/oc-$ID"/openchamber-sdk-*.tgz "/tmp/oc-$ID"/openchamber-web-*.tgz
"$R/bin/openchamber" --version   # must print $VERSION
```

## Promote to beta (canary)

```bash
ln -sfn "releases/$ID" "$HOME/.local/openchamber/beta"
systemctl --user restart openchamber-beta.service
```

Open the beta URL and check that sessions list and a prompt round-trips. The
beta service restarts only the canary; live sessions on `current` are untouched.

## Promote to current

Promotion restarts the production service and cuts live sessions, so do it when
nobody is mid-turn. Serialize with the lock file the old pipeline used:

```bash
flock "$HOME/.local/openchamber/.lock" bash -c '
  set -euo pipefail
  readlink -f "$HOME/.local/openchamber/current" > "$HOME/.local/openchamber/.anterior"
  ln -sfn "releases/'"$ID"'" "$HOME/.local/openchamber/current"
  systemctl --user restart openchamber.service
'
```

## Roll back

```bash
flock "$HOME/.local/openchamber/.lock" bash -c '
  set -euo pipefail
  ln -sfn "$(cat "$HOME/.local/openchamber/.anterior")" "$HOME/.local/openchamber/current"
  systemctl --user restart openchamber.service
'
```

Older releases stay under `releases/`; `backups/` holds config snapshots the
old build pipeline used to take. Keep both, never edit them.

## The update button

`POST /api/openchamber/fork-update/dispatch` (the update button in the UI)
dispatches this same `release.yml` from `main` with no inputs. It starts a
build, it does not publish by itself (protected environment) and it never
promotes. Promotion is this runbook.

## Retired: openchamber-build-pocharlies

The private `pocharlies-org/openchamber-build-pocharlies` repo and its
MacBook/x86 runner used to build and promote releases. DGX-516 replaced them
with `release.yml` plus this runbook. To retire it for good, after the first
fork release has been promoted:

```bash
gh repo archive pocharlies-org/openchamber-build-pocharlies   # disables its Actions
systemctl --user disable --now github-runner-openchamber-build.service   # on the x86 host
```

And disable any runner still registered for that repo in its Actions settings.
After that the repo has no live consumers; leave it archived as history.

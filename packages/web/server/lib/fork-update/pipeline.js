/**
 * Talks to the release pipeline that owns this fork.
 *
 * WHY THIS EXISTS. The update button used to run the package manager's install
 * command, which pulls `@openchamber/web` from npm. That is upstream: it has no
 * `server/lib/claude`, no fork stack, and it overwrites the global install that
 * production runs from. Measured 2026-09-15 19:14: production went from our
 * 1.22.0 build to upstream 1.23.2 and every Claude session vanished from the
 * session list while the transcripts stayed on disk.
 *
 * So an update here is not a download. It is a request to the pipeline to build
 * the fork trunk and publish it. Since DGX-516 the pipeline is the fork's own
 * `release.yml` (the retired `openchamber-build-pocharlies` repo is gone).
 * Publishing and promoting are not part of the run: they sit behind the
 * protected `release` environment and the promotion runbook
 * (`docs/release-promotion.md`), so one click cannot roll production forward on
 * its own. This module is the only place that knows the pipeline's coordinates.
 */
import { getGitHubAuth, isGhCliDisabled } from '../github/auth.js';
import { getGhCliToken } from '../github/gh-cli-credential.js';

export const PIPELINE_REPO = 'pocharlies-org/openchamber';

/** The fork's release workflow. An empty dispatch builds the trunk's current
 *  package.json version; publishing waits on the protected environment. */
export const FORK_UPDATE_WORKFLOW = 'release.yml';

/** Branch of the pipeline repo the workflow runs from (not the app ref it builds). */
export const PIPELINE_REF = 'main';

const DISPATCH_URL = `https://api.github.com/repos/${PIPELINE_REPO}/actions/workflows/${FORK_UPDATE_WORKFLOW}/dispatches`;
const RUNS_URL = `https://api.github.com/repos/${PIPELINE_REPO}/actions/runs`;

const REQUEST_TIMEOUT_MS = 10_000;

const readString = (value) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : null);
const readNumber = (value) => (Number.isFinite(value) ? value : null);

/**
 * A run is reported as one of four states. `unavailable` is deliberately not
 * `failed`: a run we cannot read says nothing about the update, and collapsing
 * the two would let a network blip look like a broken build.
 */
const asStatus = (value) => {
  if (value === 'queued' || value === 'in_progress' || value === 'requested' || value === 'waiting' || value === 'pending') {
    return { state: 'running' };
  }
  if (value === 'completed') return { state: 'finished' };
  return null;
};

const asConclusion = (value) => {
  if (value === 'success') return { outcome: 'succeeded' };
  if (value === 'failure' || value === 'timed_out' || value === 'cancelled') return { outcome: 'failed' };
  if (value === 'neutral' || value === 'action_required' || value === 'skipped') return { outcome: 'blocked' };
  return null;
};

/**
 * The stage that stopped a failed run, read from the job that stopped. The
 * pipeline names its jobs after the stage, so the UI can say "the gates failed"
 * instead of "something failed" — which is the difference between an actionable
 * message and a shrug.
 */
const pickFailingStage = (jobs) => {
  if (!Array.isArray(jobs)) return null;
  for (const job of jobs) {
    const conclusion = asConclusion(readString(job?.conclusion));
    const name = readString(job?.name);
    if (conclusion?.outcome === 'failed' && name) return name;
  }
  return null;
};

/**
 * The step a running build is in. Without this the UI can only say "working",
 * which is the thing that made the old button feel dead: a run that spends
 * minutes bundling and then hours waiting for the promotion window looks
 * exactly like a run that went nowhere.
 */
const pickActiveStage = (jobs) => {
  if (!Array.isArray(jobs)) return null;
  for (const job of jobs) {
    const state = asStatus(readString(job?.status));
    const name = readString(job?.name);
    if (state?.state === 'running' && name) return name;
  }
  return null;
};

export const parseWorkflowRun = (payload) => {
  const runId = readNumber(payload?.id);
  const status = asStatus(readString(payload?.status));
  if (runId === null || !status) return null;

  const base = { runId, htmlUrl: readString(payload.html_url) };
  if (status.state === 'running') {
    return { ...base, state: 'running', stage: pickActiveStage(payload.jobs) };
  }

  const conclusion = asConclusion(readString(payload.conclusion));
  if (!conclusion) return { ...base, state: 'unknown' };
  if (conclusion.outcome === 'succeeded') return { ...base, state: 'succeeded' };
  if (conclusion.outcome === 'blocked') return { ...base, state: 'blocked' };
  return { ...base, state: 'failed', stage: pickFailingStage(payload.jobs) };
};

/**
 * OAuth token from the app's own GitHub sign-in first, the host's `gh` CLI
 * second — the same precedence every other GitHub route uses, so the button
 * works wherever the rest of the GitHub integration already works.
 */
export const resolvePipelineToken = (dependencies = {}) => {
  // An override is authoritative even when empty: callers that pass one are
  // saying which credential to use, and silently falling back to the machine's
  // own would let a test or a scoped caller dispatch as the host user.
  if (dependencies.tokenOverride !== undefined) {
    return readString(String(dependencies.tokenOverride));
  }
  const auth = getGitHubAuth();
  const oauthToken = readString(auth?.accessToken);
  if (oauthToken) return oauthToken;
  if (isGhCliDisabled()) return null;
  return readString(getGhCliToken());
};

const githubFetch = async (fetchImpl, url, token, init = {}) => {
  const response = await fetchImpl(url, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  });
  return response;
};

/**
 * Starts a fork update. Returns a discriminated result rather than throwing, so
 * the caller can tell "no credential on this machine" apart from "the pipeline
 * refused" apart from "started".
 */
export const dispatchForkUpdate = async (input = {}) => {
  const fetchImpl = input.fetchImpl || globalThis.fetch;
  const token = resolvePipelineToken(input);
  if (!token) {
    return { started: false, reason: 'no-credential' };
  }

  // `release.yml` takes no inputs for the common case: an empty dispatch
  // builds the run's own ref at its current package.json version. A caller
  // that names a ref gets the workflow running from that branch instead.
  const ref = readString(input.ref) || PIPELINE_REF;

  let response;
  try {
    response = await githubFetch(fetchImpl, DISPATCH_URL, token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref, inputs: {} }),
    });
  } catch (error) {
    return { started: false, reason: 'unreachable', detail: error?.message || String(error) };
  }

  if (response.status === 204) return { started: true };
  if (response.status === 404) return { started: false, reason: 'workflow-not-found' };
  if (response.status === 401 || response.status === 403) return { started: false, reason: 'not-authorized' };

  const detail = readString(await response.text().catch(() => ''));
  return { started: false, reason: 'rejected', status: response.status, detail };
};

/**
 * Reads the newest run of the fork-update workflow, or a specific run.
 * `state: 'idle'` means the pipeline has never reported a run — distinct from a
 * run that produced nothing.
 */
export const getForkUpdateStatus = async (input = {}) => {
  const fetchImpl = input.fetchImpl || globalThis.fetch;
  const token = resolvePipelineToken(input);
  if (!token) return { state: 'no-credential' };

  const runId = readNumber(input.runId);
  const url = runId === null ? `${RUNS_URL}?event=workflow_dispatch&per_page=1` : `${RUNS_URL}/${runId}/jobs`;

  let payload;
  try {
    const response = await githubFetch(fetchImpl, url, token);
    if (!response.ok) return { state: 'unreachable', status: response.status };
    payload = await response.json();
  } catch (error) {
    return { state: 'unreachable', detail: error?.message || String(error) };
  }

  if (runId !== null) {
    const run = await githubFetch(fetchImpl, `${RUNS_URL}/${runId}`, token)
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null);
    if (!run) return { state: 'unreachable', runId };
    const jobs = Array.isArray(payload?.jobs) ? payload.jobs : null;
    const parsed = parseWorkflowRun({ ...run, jobs });
    return parsed || { state: 'unreachable', runId };
  }

  const runs = Array.isArray(payload?.workflow_runs) ? payload.workflow_runs : null;
  if (!runs || runs.length === 0) return { state: 'idle' };

  // A workflow_dispatch reply is 204 with no body, so the caller never learns
  // the run id. Re-reading the newest run is what lets the button follow the
  // one it just started.
  const latest = runs[0];
  const latestId = readNumber(latest?.id);
  const jobsPayload = latestId === null
    ? null
    : await githubFetch(fetchImpl, `${RUNS_URL}/${latestId}/jobs`, token)
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null);

  const jobs = Array.isArray(jobsPayload?.jobs) ? jobsPayload.jobs : null;
  return parseWorkflowRun({ ...latest, jobs }) || { state: 'idle' };
};

/**
 * Request bodies are parsed here rather than in the handler, so the HTTP layer
 * branches on domain values (`confirm`, `ref`) instead of on representations.
 */
export const readDispatchRequest = (body) => ({
  confirm: body?.confirm === true || body?.confirm === 'true',
  ref: readString(body?.ref),
});

export const readRunIdParam = (value) => {
  const raw = readString(value);
  if (raw === null) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
};

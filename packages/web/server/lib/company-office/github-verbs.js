const TRUNKS = new Set(['main', 'master', 'deploy/prod']);
const BRANCH_SHAPE = /^feature\/([A-Z][A-Z0-9_]*-\d+)(?:-[a-z0-9-]{1,60})?$/;
const KNOWN_VERBS = new Set(['publish_branch', 'approve_pr', 'request_changes', 'pr_comment', 'merge_pr']);
const MERGE_METHODS = new Set(['merge', 'squash', 'rebase']);
const MAX_FILES = 50;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_BODY_CHARS = 30000;

const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const optionalString = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;

/**
 * Per-role GitHub verb configuration. This is DATA from the plugin (F5), the
 * same posture as roles.js: nothing on the host decides what a role may do.
 */
export const parseGitHubVerbConfig = (value) => {
  if (!isRecord(value) || !isRecord(value.roles)) throw new Error('GitHub verb config must carry roles');
  const roles = new Map();
  for (const [role, entry] of Object.entries(value.roles)) {
    const id = optionalString(role)?.toLowerCase();
    if (!id) throw new Error('GitHub verb config has an unnamed role');
    if (!isRecord(entry) || !Array.isArray(entry.verbs) || entry.verbs.length === 0) {
      throw new Error(`GitHub verb config for "${id}" must list verbs`);
    }
    const verbs = entry.verbs.map((verb) => {
      if (!KNOWN_VERBS.has(verb)) throw new Error(`Unknown GitHub verb "${verb}" for role "${id}"`);
      return verb;
    });
    const repos = entry.repos === undefined ? null : entry.repos;
    if (repos !== null && (!Array.isArray(repos) || repos.some((repo) => !optionalString(repo)))) {
      throw new Error(`GitHub verb config for "${id}" has an invalid repo allowlist`);
    }
    roles.set(id, { verbs: new Set(verbs), repos: repos ? new Set(repos) : null });
  }
  return { roles };
};

/**
 * The only path from an agent to GitHub. The broker keeps the tokens; this
 * gateway keeps the policy: role->verb from plugin data, trunks rejected
 * unconditionally, the ticket stamped in the branch, the employee stamped in
 * the commit. An agent asking for a verb its role does not have gets a refusal
 * naming the role, never a silent fallback.
 */
export const createGitHubGateway = ({
  owner,
  config,
  brokersByRole,
  fetchImpl = globalThis.fetch,
  apiBase = 'https://api.github.com',
}) => {
  const org = optionalString(owner);
  if (!org) throw new Error('GitHub gateway needs an owner');
  if (!(brokersByRole instanceof Map) || brokersByRole.size === 0) {
    throw new Error('GitHub gateway needs brokers keyed by role');
  }

  const gate = (role, verb, repo) => {
    const id = optionalString(role)?.toLowerCase();
    const entry = id ? config.roles.get(id) : null;
    if (!entry) throw new Error(`Role "${role}" has no GitHub configuration`);
    if (!entry.verbs.has(verb)) throw new Error(`Role "${id}" may not ${verb}`);
    if (entry.repos && !entry.repos.has(repo)) throw new Error(`Role "${id}" may not touch repo "${repo}"`);
    const broker = brokersByRole.get(id);
    if (!broker) throw new Error(`Role "${id}" has no GitHub App broker`);
    return broker;
  };

  const api = async (broker, method, path, body) => {
    const token = await broker.installationToken();
    const response = await fetchImpl(`${apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status >= 400) {
      throw new Error(`GitHub ${method} ${path} failed (${response.status})`);
    }
    return response.json();
  };

  /**
   * Push one commit to a NEW feature branch and open its PR. The branch name
   * must carry the ticket; the commit message must mention the ticket and gets
   * the employee trailer appended. Trunks are rejected before any request.
   */
  const publishBranch = async (role, {
    repo, ticketKey, branch, baseBranch, files, commitMessage, employeeId, prTitle, prBody,
  }) => {
    const repository = optionalString(repo);
    const ticket = optionalString(ticketKey);
    const head = optionalString(branch);
    const message = optionalString(commitMessage);
    const employee = optionalString(employeeId);
    if (!repository || !ticket || !head || !message || !employee) {
      throw new Error('publish_branch needs repo, ticketKey, branch, commitMessage and employeeId');
    }
    if (TRUNKS.has(head)) throw new Error(`Branch "${head}" is a trunk; agents never touch trunks`);
    const shape = BRANCH_SHAPE.exec(head);
    if (!shape) throw new Error(`Branch "${head}" must look like feature/${ticket}-short-slug`);
    if (shape[1] !== ticket) throw new Error(`Branch "${head}" does not carry ticket ${ticket}`);
    if (!message.includes(ticket)) throw new Error(`Commit message must mention ${ticket}`);
    if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES) {
      throw new Error(`publish_branch needs 1..${MAX_FILES} files`);
    }
    for (const file of files) {
      if (!isRecord(file) || !optionalString(file.path) || typeof file.content !== 'string'
        || Buffer.byteLength(file.content) > MAX_FILE_BYTES || file.path.includes('..')) {
        throw new Error('publish_branch got an invalid file entry');
      }
    }
    const broker = gate(role, 'publish_branch', repository);

    const repoInfo = await api(broker, 'GET', `/repos/${org}/${repository}`);
    const base = optionalString(baseBranch) ?? optionalString(repoInfo.default_branch);
    if (!base) throw new Error('Cannot resolve the base branch');
    const baseRef = await api(broker, 'GET', `/repos/${org}/${repository}/git/ref/heads/${encodeURIComponent(base)}`);
    const baseSha = baseRef?.object?.sha;
    if (!optionalString(baseSha)) throw new Error('Base branch has no resolvable head commit');
    const baseCommit = await api(broker, 'GET', `/repos/${org}/${repository}/git/commits/${baseSha}`);
    const tree = await api(broker, 'POST', `/repos/${org}/${repository}/git/trees`, {
      base_tree: baseCommit.tree.sha,
      tree: files.map((file) => ({ path: file.path, mode: '100644', type: 'blob', content: file.content })),
    });
    const commit = await api(broker, 'POST', `/repos/${org}/${repository}/git/commits`, {
      message: `${message}\n\nSc-Employee: ${employee}\nSc-Ticket: ${ticket}`,
      tree: tree.sha,
      parents: [baseSha],
    });
    await api(broker, 'POST', `/repos/${org}/${repository}/git/refs`, {
      ref: `refs/heads/${head}`,
      sha: commit.sha,
    });
    const pr = await api(broker, 'POST', `/repos/${org}/${repository}/pulls`, {
      title: optionalString(prTitle) ?? `[${ticket}] ${message.split('\n')[0]}`.slice(0, 200),
      head,
      base,
      body: (optionalString(prBody) ?? '').slice(0, MAX_BODY_CHARS),
    });
    return { branch: head, commitSha: commit.sha, prNumber: pr.number, prUrl: pr.html_url };
  };

  const review = async (role, verb, event, { repo, prNumber, body }) => {
    const repository = optionalString(repo);
    const number = Number(prNumber);
    if (!repository || !Number.isInteger(number) || number <= 0) {
      throw new Error(`${verb} needs repo and prNumber`);
    }
    const broker = gate(role, verb, repository);
    const result = await api(broker, 'POST', `/repos/${org}/${repository}/pulls/${number}/reviews`, {
      event,
      body: (optionalString(body) ?? '').slice(0, MAX_BODY_CHARS),
    });
    return { reviewId: result.id, state: result.state };
  };

  /**
   * The one sanctioned way code reaches a trunk: merging a reviewed PR. The
   * gate is evidence read back from GitHub, never caller claims — every
   * required approver's bot must have APPROVED as its LATEST review, and an
   * outstanding CHANGES_REQUESTED from anyone blocks. An empty approver list
   * is refused: no gate is not a gate. Who gets this verb is installation
   * data (per the workflow, devops executes; cto/qa/po sign, the CEO can
   * always merge by hand as override).
   */
  const mergePr = async (role, { repo, prNumber, requiredApprovers, method }) => {
    const repository = optionalString(repo);
    const number = Number(prNumber);
    if (!repository || !Number.isInteger(number) || number <= 0) {
      throw new Error('merge_pr needs repo and prNumber');
    }
    if (!Array.isArray(requiredApprovers) || requiredApprovers.length === 0
      || requiredApprovers.some((slug) => !optionalString(slug))) {
      throw new Error('merge_pr refuses an empty approver gate');
    }
    const mergeMethod = optionalString(method) ?? 'merge';
    if (!MERGE_METHODS.has(mergeMethod)) throw new Error(`merge_pr got unknown method "${method}"`);
    const broker = gate(role, 'merge_pr', repository);

    const pr = await api(broker, 'GET', `/repos/${org}/${repository}/pulls/${number}`);
    if (pr.merged) return { merged: true, alreadyMerged: true, sha: optionalString(pr.merge_commit_sha) };
    if (pr.draft) throw new Error(`merge_pr refused: PR #${number} is a draft`);
    if (pr.state !== 'open') throw new Error(`merge_pr refused: PR #${number} is ${pr.state}`);

    const reviews = await api(broker, 'GET', `/repos/${org}/${repository}/pulls/${number}/reviews?per_page=100`);
    // Latest decisive state per reviewer: a dismissed approval never counts,
    // and a later CHANGES_REQUESTED overrides an earlier APPROVED.
    const latest = new Map();
    for (const entry of Array.isArray(reviews) ? reviews : []) {
      const login = optionalString(entry?.user?.login);
      if (login && (entry.state === 'APPROVED' || entry.state === 'CHANGES_REQUESTED')) {
        latest.set(login, entry.state);
      }
    }
    const blocking = [...latest].filter(([, state]) => state === 'CHANGES_REQUESTED').map(([login]) => login);
    if (blocking.length) throw new Error(`merge_pr refused: changes requested by ${blocking.join(', ')}`);
    for (const slug of requiredApprovers) {
      const login = `${optionalString(slug)}[bot]`;
      if (latest.get(login) !== 'APPROVED') {
        throw new Error(`merge_pr refused: missing approval from ${login}`);
      }
    }

    const result = await api(broker, 'PUT', `/repos/${org}/${repository}/pulls/${number}/merge`, {
      merge_method: mergeMethod,
    });
    if (!result.merged) throw new Error(`merge_pr did not merge PR #${number}`);
    return { merged: true, sha: optionalString(result.sha) };
  };

  return {
    publish_branch: publishBranch,
    merge_pr: mergePr,
    approve_pr: (role, args) => review(role, 'approve_pr', 'APPROVE', args),
    request_changes: async (role, args) => {
      const body = optionalString(args?.body);
      if (!body) throw new Error('request_changes needs a reason in body');
      return review(role, 'request_changes', 'REQUEST_CHANGES', { ...args, body });
    },
    pr_comment: async (role, { repo, prNumber, body }) => {
      const repository = optionalString(repo);
      const number = Number(prNumber);
      const text = optionalString(body);
      if (!repository || !Number.isInteger(number) || number <= 0 || !text) {
        throw new Error('pr_comment needs repo, prNumber and body');
      }
      const broker = gate(role, 'pr_comment', repository);
      const result = await api(broker, 'POST', `/repos/${org}/${repository}/issues/${number}/comments`, {
        body: text.slice(0, MAX_BODY_CHARS),
      });
      return { commentId: result.id, url: result.html_url };
    },
  };
};

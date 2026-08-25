import { describe, expect, test } from 'vitest';
import { createGitHubGateway, parseGitHubVerbConfig } from './github-verbs.js';

const broker = { installationToken: async () => 'installation-token' };

const respond = (body, status = 200) => new Response(JSON.stringify(body), { status });

/** Gateway over a mocked GitHub, recording every request it actually makes. */
const gateway = ({ pr = {}, reviews = [], mergeResult = { merged: true, sha: 'abc123' } } = {}) => {
  const calls = [];
  const gw = createGitHubGateway({
    owner: 'pocharlies-org',
    config: parseGitHubVerbConfig({
      roles: {
        devops: { verbs: ['merge_pr'] },
        developer: { verbs: ['publish_branch', 'pr_comment'] },
      },
    }),
    brokersByRole: new Map([['devops', broker], ['developer', broker]]),
    fetchImpl: async (url, init) => {
      const target = String(url);
      calls.push({ method: init?.method ?? 'GET', url: target });
      if (target.includes('/pulls/7/reviews')) return respond(reviews);
      if (target.endsWith('/pulls/7/merge')) return respond(mergeResult);
      if (target.endsWith('/pulls/7')) return respond({ state: 'open', merged: false, draft: false, ...pr });
      return respond({ message: 'unexpected request in test' }, 404);
    },
  });
  return { gw, calls };
};

const approved = (slug) => ({ user: { login: `${slug}[bot]` }, state: 'APPROVED' });

describe('merge_pr: the only sanctioned path to a trunk', () => {
  test('a role without the verb is refused by name', async () => {
    const { gw } = gateway();
    await expect(gw.merge_pr('developer', { repo: 'r', prNumber: 7, requiredApprovers: ['sc-pocharlies-cto'] }))
      .rejects.toThrow(/"developer" may not merge_pr/);
  });

  test('an empty approver gate is refused before touching GitHub', async () => {
    const { gw, calls } = gateway();
    await expect(gw.merge_pr('devops', { repo: 'r', prNumber: 7, requiredApprovers: [] }))
      .rejects.toThrow(/empty approver gate/);
    expect(calls).toHaveLength(0);
  });

  test('a missing or dismissed approval refuses naming the bot', async () => {
    const { gw } = gateway({
      reviews: [approved('sc-pocharlies-cto'), { user: { login: 'sc-pocharlies-qa[bot]' }, state: 'DISMISSED' }],
    });
    await expect(gw.merge_pr('devops', {
      repo: 'r', prNumber: 7, requiredApprovers: ['sc-pocharlies-cto', 'sc-pocharlies-qa'],
    })).rejects.toThrow(/missing approval from sc-pocharlies-qa\[bot\]/);
  });

  test('an outstanding changes-requested blocks even with every approval present', async () => {
    const { gw } = gateway({
      reviews: [approved('sc-pocharlies-cto'), { user: { login: 'sc-pocharlies-qa[bot]' }, state: 'CHANGES_REQUESTED' }],
    });
    await expect(gw.merge_pr('devops', { repo: 'r', prNumber: 7, requiredApprovers: ['sc-pocharlies-cto'] }))
      .rejects.toThrow(/changes requested by sc-pocharlies-qa\[bot\]/);
  });

  test('a later changes-requested overrides that reviewer\'s earlier approval', async () => {
    const { gw } = gateway({
      reviews: [approved('sc-pocharlies-cto'), { user: { login: 'sc-pocharlies-cto[bot]' }, state: 'CHANGES_REQUESTED' }],
    });
    await expect(gw.merge_pr('devops', { repo: 'r', prNumber: 7, requiredApprovers: ['sc-pocharlies-cto'] }))
      .rejects.toThrow(/changes requested/);
  });

  test('merges with the chosen method once every required bot approved', async () => {
    const { gw, calls } = gateway({ reviews: [approved('sc-pocharlies-cto'), approved('sc-pocharlies-qa')] });
    const result = await gw.merge_pr('devops', {
      repo: 'r', prNumber: 7, requiredApprovers: ['sc-pocharlies-cto', 'sc-pocharlies-qa'], method: 'squash',
    });
    expect(result).toEqual({ merged: true, sha: 'abc123' });
    const merge = calls.find((call) => call.method === 'PUT');
    expect(merge.url).toContain('/pulls/7/merge');
  });

  test('an already-merged PR short-circuits without merging again', async () => {
    const { gw, calls } = gateway({ pr: { merged: true, merge_commit_sha: 'prior' } });
    const result = await gw.merge_pr('devops', { repo: 'r', prNumber: 7, requiredApprovers: ['sc-pocharlies-cto'] });
    expect(result).toEqual({ merged: true, alreadyMerged: true, sha: 'prior' });
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
  });

  test('drafts and closed PRs are refused', async () => {
    const { gw } = gateway({ pr: { draft: true } });
    await expect(gw.merge_pr('devops', { repo: 'r', prNumber: 7, requiredApprovers: ['sc-pocharlies-cto'] }))
      .rejects.toThrow(/is a draft/);
    const closed = gateway({ pr: { state: 'closed' } });
    await expect(closed.gw.merge_pr('devops', { repo: 'r', prNumber: 7, requiredApprovers: ['sc-pocharlies-cto'] }))
      .rejects.toThrow(/is closed/);
  });
});

describe('publish_branch policy holds without any network', () => {
  test('trunks and branches that do not carry the ticket are refused', async () => {
    const { gw, calls } = gateway();
    const base = { repo: 'r', ticketKey: 'SC-1', commitMessage: 'SC-1 x', employeeId: 'dev-hugo', files: [{ path: 'a', content: 'b' }] };
    await expect(gw.publish_branch('developer', { ...base, branch: 'main' })).rejects.toThrow(/trunk/);
    await expect(gw.publish_branch('developer', { ...base, branch: 'feature/OTHER-9-x' })).rejects.toThrow(/does not carry ticket SC-1/);
    expect(calls).toHaveLength(0);
  });
});

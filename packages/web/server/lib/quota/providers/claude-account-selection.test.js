import { describe, expect, it } from 'vitest';

import { buildAccountMiss } from './claude.js';
import { accountIdFromProviderId, buildAccountResult } from './claude-accounts.js';

/**
 * Which Claude pool a session's quota comes from.
 *
 * Tested through the pieces, not through fetchQuota: that function binds
 * readAuthFile at module load, so the ambient-credential branch cannot be
 * substituted in a test and any assertion about it would really be an assertion
 * about whatever token happens to be on the machine.
 */
describe('accountIdFromProviderId', () => {
  it('names the account for an account-scoped provider', () => {
    expect(accountIdFromProviderId('claude-code-tercera')).toBe('tercera');
    expect(accountIdFromProviderId('claude-code-works-shared')).toBe('works-shared');
  });

  it('names nothing for the bare id, which is the default account', () => {
    expect(accountIdFromProviderId('claude-code')).toBeNull();
    expect(accountIdFromProviderId('claude')).toBeNull();
    expect(accountIdFromProviderId(undefined)).toBeNull();
  });
});

describe('buildAccountResult', () => {
  const account = {
    id: 'tercera',
    label: 'Work personal',
    identity: { email: 'd@cloudblue.com' },
    sharesOrganizationWith: ['works-shared'],
    quota: { windows: { fiveHour: { utilization: 0.2, resetsAt: 1788303600000 } } },
  };

  it('names the account and converts utilization to percent', () => {
    const result = buildAccountResult(account);
    expect(result.providerName).toBe('Work personal · d@cloudblue.com');
    expect(result.usage.windows['5h'].usedPercent).toBeCloseTo(20);
    expect(result.sharedWith).toEqual(['works-shared']);
  });

  it('does not list an account as sharing with itself', () => {
    // The plugin's own `accountsSharingLogin`/`accountsSharingSubscription`
    // exclude the account itself, so this cannot arrive from a healthy roster —
    // but if it ever did, echoing it back would print an account as sharing its
    // own budget with itself, which reads as a second pool.
    const self = { ...account, sharesLoginWith: ['tercera'], sharesOrganizationWith: ['tercera'] };
    expect(buildAccountResult(self).sharedWith).toBeUndefined();
  });
});

describe('buildAccountMiss', () => {
  it('says the plugin does not know the account', () => {
    const result = buildAccountMiss({ accountId: 'nope', pluginReachable: true });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Account not found in the Claude plugin');
    expect(result.providerName).toBe('Claude · nope');
  });

  it('says the plugin is unreachable', () => {
    const result = buildAccountMiss({ accountId: 'tercera', pluginReachable: false });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Claude plugin not reachable');
  });

  it('never falls back to another subscription numbers', () => {
    // The point of the branch: a wrong pool under a right label is worse than
    // no number at all.
    expect(buildAccountMiss({ accountId: 'x', pluginReachable: true }).usage).toBeNull();
  });
});

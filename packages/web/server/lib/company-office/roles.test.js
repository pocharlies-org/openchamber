import { describe, expect, test } from 'vitest';
import { parseRole, parseRoleConfig } from './roles.js';

const role = (overrides = {}) => ({
  id: 'developer',
  title: 'Developer',
  permission: [
    { permission: 'bash', pattern: '*', action: 'allow' },
    { permission: 'bash', pattern: 'kubectl *', action: 'deny' },
  ],
  ...overrides,
});

describe('roles arrive as data, not as files on the host', () => {
  test('a role says who does the work, not what they may run', () => {
    const parsed = parseRole(role());
    expect(parsed).toMatchObject({ id: 'developer', title: 'Developer', promptHint: null });
    // The boundary lives in the role folder, versioned and reviewable. An admin
    // page editing it would be a security change with no history behind it.
    expect(parsed.permission).toBeUndefined();
    expect(parsed.model).toBeUndefined();
  });

  test('an installation still sending permissions or a model is not broken by the split', () => {
    // Saved configurations predate this change. Rejecting them would take the
    // whole company down over fields that are now inert.
    const parsed = parseRole(role({
      permission: [{ permission: 'bash', pattern: '*', action: 'nonsense' }],
      model: { providerID: 'whatever' },
    }));
    expect(parsed.id).toBe('developer');
    expect(parsed.permission).toBeUndefined();
    expect(parsed.model).toBeUndefined();
  });

  test('defaults the title to the id and trims the prompt hint', () => {
    const parsed = parseRole(role({ title: undefined, promptHint: '  revisa arquitectura  ' }));
    expect(parsed.title).toBe('developer');
    expect(parsed.promptHint).toBe('revisa arquitectura');
  });

  test('rejects malformed ids', () => {
    for (const id of ['Developer', '1dev', 'dev_ops', '', 'a'.repeat(65)]) {
      expect(() => parseRole(role({ id }))).toThrow(/\.id/);
    }
  });

  test('bounds a hostile configuration instead of forwarding it', () => {
    expect(() => parseRoleConfig({ roles: Array.from({ length: 51 }, (_, i) => role({ id: `r${i}` })) }))
      .toThrow(/exceeds 50 roles/);
  });
});

describe('the github identity of a role travels as data, never as a key', () => {
  test('accepts appId/installationId/slug and defaults to null when absent', () => {
    expect(parseRole(role()).github).toBeNull();
    const parsed = parseRole(role({
      github: { appId: 4654106, installationId: 155050795, slug: 'sc-pocharlies-developer' },
    }));
    expect(parsed.github).toEqual({ appId: 4654106, installationId: 155050795, slug: 'sc-pocharlies-developer' });
  });

  test('rejects stringy or non-positive ids naming the offending role', () => {
    expect(() => parseRole(role({ github: { appId: '4654106', installationId: 1 } })))
      .toThrow(/roles\[0\]\.github\.appId/);
    expect(() => parseRole(role({ github: { appId: 4654106, installationId: 0 } })))
      .toThrow(/roles\[0\]\.github\.installationId/);
    expect(() => parseRole(role({ github: { appId: 4654106, installationId: 1, slug: 'Bad_Slug' } })))
      .toThrow(/roles\[0\]\.github\.slug/);
  });

  test('refuses a config that tries to smuggle the private key or a secret', () => {
    expect(() => parseRole(role({ github: { appId: 1, installationId: 1, pem: '-----BEGIN PRIVATE KEY-----' } })))
      .toThrow(/secrets never travel/);
    expect(() => parseRole(role({ github: { appId: 1, installationId: 1, client_secret: 'x' } })))
      .toThrow(/secrets never travel/);
  });
});

describe('role configuration for one installation', () => {
  test('indexes roles by id and accepts a bare array', () => {
    const config = parseRoleConfig({ roles: [role(), role({ id: 'sre', title: 'SRE' })] });
    expect([...config.byId.keys()]).toEqual(['developer', 'sre']);
    expect(parseRoleConfig([role()]).roles).toHaveLength(1);
  });

  test('rejects duplicates and empty configuration', () => {
    expect(() => parseRoleConfig({ roles: [role(), role()] })).toThrow(/duplicate role id/);
    expect(() => parseRoleConfig({ roles: [] })).toThrow(/non-empty array/);
    expect(() => parseRoleConfig(null)).toThrow(/non-empty array/);
  });

  test('names the offending role so an operator can find it', () => {
    expect(() => parseRoleConfig({ roles: [role(), { id: 'Broken Id' }] }))
      .toThrow(/roles\[1\]\.id/);
  });
});

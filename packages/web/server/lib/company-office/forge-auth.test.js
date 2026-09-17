import { describe, expect, test } from 'vitest';
import { generateKeyPairSync, createSign, createHmac } from 'node:crypto';
import { createForgeTokenVerifier, toHeartbeat } from './forge-auth.js';

const ISSUER = 'https://forge.atlassian.com';
const AUDIENCE = 'https://office.example.test';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });

const jwk = (key, kid) => ({ ...key.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' });
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

const sign = (header, claims, key = privateKey) => {
  const input = `${b64(header)}.${b64(claims)}`;
  const signature = createSign('RSA-SHA256').update(input).end().sign(key).toString('base64url');
  return `${input}.${signature}`;
};

const validClaims = (overrides = {}) => ({
  iss: ISSUER,
  aud: AUDIENCE,
  exp: 2000,
  app: { id: 'ari:cloud:ecosystem::app/abc', installationId: 'inst-1' },
  ...overrides,
});

const verifierWith = (keys, overrides = {}) => {
  let fetches = 0;
  const verifier = createForgeTokenVerifier({
    jwksUrl: 'https://forge.atlassian.com/jwks',
    expectedIssuer: ISSUER,
    expectedAudience: AUDIENCE,
    now: () => 1000_000,
    fetchImpl: async () => {
      fetches += 1;
      return new Response(JSON.stringify({ keys }), { status: 200 });
    },
    ...overrides,
  });
  return { verifier, fetches: () => fetches };
};

const bearer = (token) => `Bearer ${token}`;

describe('Forge asymmetric token verification', () => {
  test('accepts a genuine token and returns the installation scope', async () => {
    const { verifier } = verifierWith([jwk(publicKey, 'k1')]);
    const result = await verifier.verify(bearer(sign({ alg: 'RS256', kid: 'k1' }, validClaims())));
    expect(result).toEqual({
      installationId: 'inst-1',
      appId: 'ari:cloud:ecosystem::app/abc',
      issuedForAudience: AUDIENCE,
    });
  });

  test('rejects a token signed by a key that is not Atlassian', async () => {
    const { verifier } = verifierWith([jwk(publicKey, 'k1')]);
    const forged = sign({ alg: 'RS256', kid: 'k1' }, validClaims(), other.privateKey);
    await expect(verifier.verify(bearer(forged))).rejects.toThrow(/signature is invalid/);
  });

  test('refuses algorithm confusion: none and HMAC signed with the public key', async () => {
    const { verifier } = verifierWith([jwk(publicKey, 'k1')]);

    const header = b64({ alg: 'none', kid: 'k1' });
    const payload = b64(validClaims());
    await expect(verifier.verify(bearer(`${header}.${payload}.`))).rejects.toThrow(/unsigned/);

    const hsHeader = b64({ alg: 'HS256', kid: 'k1' });
    const pem = publicKey.export({ type: 'spki', format: 'pem' });
    const hs = createHmac('sha256', pem).update(`${hsHeader}.${payload}`).digest('base64url');
    await expect(verifier.verify(bearer(`${hsHeader}.${payload}.${hs}`)))
      .rejects.toThrow(/algorithm is not allowed: HS256/);
  });

  test('rejects a token minted for a different audience or issuer', async () => {
    const { verifier } = verifierWith([jwk(publicKey, 'k1')]);
    await expect(verifier.verify(bearer(sign({ alg: 'RS256', kid: 'k1' }, validClaims({ aud: 'https://someone-else.test' })))))
      .rejects.toThrow(/audience is not accepted/);
    await expect(verifier.verify(bearer(sign({ alg: 'RS256', kid: 'k1' }, validClaims({ iss: 'https://evil.test' })))))
      .rejects.toThrow(/issuer is not accepted/);
  });

  test('accepts an audience array that contains this service', async () => {
    const { verifier } = verifierWith([jwk(publicKey, 'k1')]);
    const token = sign({ alg: 'RS256', kid: 'k1' }, validClaims({ aud: ['https://other.test', AUDIENCE] }));
    await expect(verifier.verify(bearer(token))).resolves.toMatchObject({ installationId: 'inst-1' });
  });

  test('enforces lifetime with bounded clock skew', async () => {
    const { verifier } = verifierWith([jwk(publicKey, 'k1')]);
    await expect(verifier.verify(bearer(sign({ alg: 'RS256', kid: 'k1' }, validClaims({ exp: 100 })))))
      .rejects.toThrow(/expired/);
    await expect(verifier.verify(bearer(sign({ alg: 'RS256', kid: 'k1' }, validClaims({ nbf: 999_999 })))))
      .rejects.toThrow(/not valid yet/);
    await expect(verifier.verify(bearer(sign({ alg: 'RS256', kid: 'k1' }, validClaims({ exp: undefined })))))
      .rejects.toThrow(/no expiry/);
  });

  test('requires an installation id, because dedupe and limits are per installation', async () => {
    const { verifier } = verifierWith([jwk(publicKey, 'k1')]);
    await expect(verifier.verify(bearer(sign({ alg: 'RS256', kid: 'k1' }, validClaims({ app: { id: 'x' } })))))
      .rejects.toThrow(/no installation id/);
  });

  test('pins the app id when one is configured', async () => {
    const { verifier } = verifierWith([jwk(publicKey, 'k1')], { expectedAppId: 'ari:cloud:ecosystem::app/mine' });
    await expect(verifier.verify(bearer(sign({ alg: 'RS256', kid: 'k1' }, validClaims()))))
      .rejects.toThrow(/app id is not accepted/);
  });

  test('caches the key set but refetches once for an unknown key id', async () => {
    const { verifier, fetches } = verifierWith([jwk(publicKey, 'k1')]);
    await verifier.verify(bearer(sign({ alg: 'RS256', kid: 'k1' }, validClaims())));
    await verifier.verify(bearer(sign({ alg: 'RS256', kid: 'k1' }, validClaims())));
    expect(fetches()).toBe(1);

    await expect(verifier.verify(bearer(sign({ alg: 'RS256', kid: 'rotated' }, validClaims()))))
      .rejects.toThrow(/key id is unknown/);
    expect(fetches()).toBe(2);
  });

  test('rejects missing, malformed and oversized credentials without touching the JWKS', async () => {
    const { verifier, fetches } = verifierWith([jwk(publicKey, 'k1')]);
    await expect(verifier.verify(undefined)).rejects.toThrow(/missing/);
    await expect(verifier.verify('Basic abc')).rejects.toThrow(/missing/);
    await expect(verifier.verify(bearer('a.b'))).rejects.toThrow(/malformed/);
    await expect(verifier.verify(bearer(`${'x'.repeat(9000)}`))).rejects.toThrow(/oversized/);
    expect(fetches()).toBe(0);
  });

  test('refuses to be built without an audience to check against', () => {
    expect(() => createForgeTokenVerifier({ jwksUrl: 'https://j', expectedIssuer: ISSUER }))
      .toThrow(/requires jwksUrl, expectedIssuer and expectedAudience/);
  });
});

describe('heartbeat payload', () => {
  test('reports the three states and never leaks working context', () => {
    const busy = toHeartbeat({
      ticketKey: 'SC-21', sessionId: 'ses_1', agent: 'company/developer',
      status: { type: 'busy' }, startedAt: 1000, now: 4000,
    });
    expect(busy).toEqual({
      schemaVersion: 1,
      ticketKey: 'SC-21',
      sessionId: 'ses_1',
      agent: 'company/developer',
      state: 'busy',
      runningForMs: 3000,
    });
    expect(Object.keys(busy)).not.toContain('directory');

    expect(toHeartbeat({ ticketKey: 'SC-1', sessionId: 'ses_2', status: { type: 'idle' }, now: 1 }))
      .toMatchObject({ state: 'idle', runningForMs: null, agent: null });
    expect(toHeartbeat({ ticketKey: 'SC-1', sessionId: 'ses_3', status: null, now: 1 }))
      .toMatchObject({ state: 'missing', runningForMs: null });
  });
});

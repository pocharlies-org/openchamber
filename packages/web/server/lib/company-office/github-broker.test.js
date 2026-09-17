import { describe, expect, test } from 'vitest';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { mintAppJwt, createGitHubAppBroker } from './github-broker.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const otherPem = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' });

const decode = (jwt) => {
  const [header, payload] = jwt.split('.');
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString()),
    payload: JSON.parse(Buffer.from(payload, 'base64url').toString()),
  };
};

const verifies = (jwt, key) => {
  const [header, payload, signature] = jwt.split('.');
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${header}.${payload}`);
  return verifier.verify(key, Buffer.from(signature, 'base64url'));
};

describe('app JWT', () => {
  test('signs RS256 with the app key and GitHub-required claims', () => {
    const jwt = mintAppJwt({ appId: 4654106, privateKeyPem: pem, now: () => 1_787_000_000_000 });
    expect(verifies(jwt, publicKey)).toBe(true);
    const { header, payload } = decode(jwt);
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(payload.iss).toBe('4654106');
    expect(payload.iat).toBe(1_787_000_000 - 60);
    expect(payload.exp - payload.iat).toBe(600);
  });

  test('a JWT signed by another key does not verify', () => {
    const forged = mintAppJwt({ appId: 4654106, privateKeyPem: otherPem });
    expect(verifies(forged, publicKey)).toBe(false);
  });

  test('rejects a non-numeric app id and a missing key', () => {
    expect(() => mintAppJwt({ appId: 'sc-developer', privateKeyPem: pem })).toThrow(/numeric/);
    expect(() => mintAppJwt({ appId: 4654106, privateKeyPem: '  ' })).toThrow(/private key/);
  });
});

describe('installation token broker', () => {
  const okResponse = (token, expiresInMs, nowMs) => ({
    status: 201,
    json: async () => ({ token, expires_at: new Date(nowMs + expiresInMs).toISOString() }),
  });

  test('exchanges the JWT for an installation token with the right request shape', async () => {
    const calls = [];
    const nowMs = 1_787_000_000_000;
    const broker = createGitHubAppBroker({
      appId: 4654106,
      installationId: 155050795,
      privateKeyPem: pem,
      now: () => nowMs,
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return okResponse('ghs_test_token', 3_600_000, nowMs);
      },
    });
    await expect(broker.installationToken()).resolves.toBe('ghs_test_token');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.github.com/app/installations/155050795/access_tokens');
    expect(calls[0].init.method).toBe('POST');
    const bearer = calls[0].init.headers.Authorization.replace('Bearer ', '');
    expect(verifies(bearer, publicKey)).toBe(true);
  });

  test('caches the token and refreshes only near expiry', async () => {
    let nowMs = 1_787_000_000_000;
    let fetches = 0;
    const broker = createGitHubAppBroker({
      appId: 4654106,
      installationId: 155050795,
      privateKeyPem: pem,
      now: () => nowMs,
      fetchImpl: async () => {
        fetches += 1;
        return okResponse(`ghs_token_${fetches}`, 3_600_000, nowMs);
      },
    });
    await broker.installationToken();
    await broker.installationToken();
    expect(fetches).toBe(1);
    nowMs += 56 * 60 * 1000;
    await expect(broker.installationToken()).resolves.toBe('ghs_token_2');
    expect(fetches).toBe(2);
  });

  test('a non-201 exchange or a token-less body throws instead of degrading', async () => {
    const denied = createGitHubAppBroker({
      appId: 4654106, installationId: 155050795, privateKeyPem: pem,
      fetchImpl: async () => ({ status: 401, json: async () => ({}) }),
    });
    await expect(denied.installationToken()).rejects.toThrow(/failed \(401\)/);
    const empty = createGitHubAppBroker({
      appId: 4654106, installationId: 155050795, privateKeyPem: pem,
      fetchImpl: async () => ({ status: 201, json: async () => ({ token: '', expires_at: 'nope' }) }),
    });
    await expect(empty.installationToken()).rejects.toThrow(/no usable token/);
  });

  test('a bad key fails at construction, not on first use', () => {
    expect(() => createGitHubAppBroker({
      appId: 4654106, installationId: 155050795, privateKeyPem: 'not-a-pem',
    })).toThrow();
    expect(() => createGitHubAppBroker({
      appId: 4654106, installationId: 'all', privateKeyPem: pem,
    })).toThrow(/installation id/);
  });
});

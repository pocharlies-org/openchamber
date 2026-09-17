const DEFAULT_CLOCK_SKEW_SEC = 60;
const DEFAULT_JWKS_TTL_MS = 10 * 60 * 1000;
const MAX_TOKEN_CHARS = 8192;

// Allowlist, never a denylist. Accepting `none` or an HMAC algorithm here is the
// classic confusion attack: the Atlassian public key is public, so anything that
// lets a caller pick a symmetric algorithm lets them sign their own tokens.
const ALLOWED_ALG = 'RS256';

const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const decodeSegment = (segment, label) => {
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    throw new Error(`Forge token ${label} is not decodable`);
  }
  if (!isRecord(decoded)) throw new Error(`Forge token ${label} is not an object`);
  return decoded;
};

const asList = (value) => (Array.isArray(value) ? value : [value]).filter((entry) => typeof entry === 'string');

/**
 * Verifies an asymmetric Forge invocation token.
 *
 * This is the standard shape: Atlassian signs RS256, publishes its keys as a JWKS,
 * and the remote validates signature plus `iss`, `aud` and lifetime. There is no
 * shared secret to store or rotate.
 *
 * `expectedAudience` MUST be this service's own public URL. Skipping it is what
 * turns a valid token minted for someone else's app into a valid token here.
 */
export const createForgeTokenVerifier = ({
  jwksUrl,
  expectedIssuer,
  expectedAudience,
  expectedAppId = null,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  clockSkewSec = DEFAULT_CLOCK_SKEW_SEC,
  jwksTtlMs = DEFAULT_JWKS_TTL_MS,
}) => {
  if (!jwksUrl || !expectedIssuer || !expectedAudience) {
    throw new Error('Forge token verifier requires jwksUrl, expectedIssuer and expectedAudience');
  }

  let cache = { keys: null, fetchedAt: 0 };

  const loadKeys = async (force) => {
    const fresh = cache.keys && !force && now() - cache.fetchedAt < jwksTtlMs;
    if (fresh) return cache.keys;
    const response = await fetchImpl(jwksUrl, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Forge JWKS fetch failed (${response.status})`);
    const payload = await response.json();
    if (!isRecord(payload) || !Array.isArray(payload.keys)) {
      throw new Error('Forge JWKS response is unusable');
    }
    cache = { keys: payload.keys, fetchedAt: now() };
    return cache.keys;
  };

  const importKey = async (jwk) => crypto.subtle.importKey(
    'jwk',
    { ...jwk, alg: ALLOWED_ALG, ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  const verifySignature = async (kid, signingInput, signature) => {
    for (const force of [false, true]) {
      const keys = await loadKeys(force);
      const jwk = keys.find((key) => key.kid === kid && (!key.alg || key.alg === ALLOWED_ALG));
      if (!jwk) {
        // An unknown kid is the normal shape of key rotation: refetch once before failing.
        if (force) throw new Error('Forge token key id is unknown');
        continue;
      }
      const key = await importKey(jwk);
      const valid = await crypto.subtle.verify(
        { name: 'RSASSA-PKCS1-v1_5' },
        key,
        Buffer.from(signature, 'base64url'),
        Buffer.from(signingInput, 'utf8'),
      );
      if (!valid) throw new Error('Forge token signature is invalid');
      return;
    }
    throw new Error('Forge token key id is unknown');
  };

  return {
    verify: async (authorizationHeader) => {
      const raw = typeof authorizationHeader === 'string' ? authorizationHeader.trim() : '';
      const token = /^Bearer\s+(.+)$/i.exec(raw)?.[1]?.trim();
      if (!token) throw new Error('Forge token is missing');
      if (token.length > MAX_TOKEN_CHARS) throw new Error('Forge token is oversized');

      const parts = token.split('.');
      if (parts.length !== 3) throw new Error('Forge token is malformed');
      const [encodedHeader, encodedPayload, signature] = parts;
      if (!signature) throw new Error('Forge token is unsigned');

      const header = decodeSegment(encodedHeader, 'header');
      if (header.alg !== ALLOWED_ALG) throw new Error(`Forge token algorithm is not allowed: ${String(header.alg)}`);
      if (typeof header.kid !== 'string' || !header.kid.trim()) throw new Error('Forge token has no key id');

      await verifySignature(header.kid, `${encodedHeader}.${encodedPayload}`, signature);

      const claims = decodeSegment(encodedPayload, 'payload');
      if (claims.iss !== expectedIssuer) throw new Error('Forge token issuer is not accepted');
      if (!asList(claims.aud).includes(expectedAudience)) throw new Error('Forge token audience is not accepted');

      const nowSec = Math.floor(now() / 1000);
      if (typeof claims.exp !== 'number') throw new Error('Forge token has no expiry');
      if (claims.exp + clockSkewSec < nowSec) throw new Error('Forge token has expired');
      if (typeof claims.nbf === 'number' && claims.nbf - clockSkewSec > nowSec) {
        throw new Error('Forge token is not valid yet');
      }

      // The installation id scopes everything downstream: dedupe, rate limiting and
      // authorization are per installation, never global.
      const installationId = typeof claims.app?.installationId === 'string' ? claims.app.installationId.trim() : '';
      if (!installationId) throw new Error('Forge token has no installation id');
      if (expectedAppId && claims.app?.id !== expectedAppId) throw new Error('Forge token app id is not accepted');

      return {
        installationId,
        appId: typeof claims.app?.id === 'string' ? claims.app.id : null,
        issuedForAudience: expectedAudience,
      };
    },
  };
};

/**
 * The heartbeat payload Forge is allowed to see.
 *
 * Deliberately thin: no directory, no prompt, no transcript, no model credentials.
 * Anything reachable from Atlassian's cloud must assume a wider audience than the
 * private snapshot the authenticated panel gets.
 */
export const toHeartbeat = ({ ticketKey, sessionId, status, startedAt, agent, now }) => {
  const state = status?.type === 'busy' ? 'busy' : status ? 'idle' : 'missing';
  return {
    schemaVersion: 1,
    ticketKey,
    sessionId,
    agent: agent ?? null,
    state,
    runningForMs: state === 'busy' && Number.isFinite(startedAt) ? Math.max(0, now - startedAt) : null,
  };
};

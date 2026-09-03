import { createSign, createPrivateKey } from 'node:crypto';

const JWT_LIFETIME_SEC = 600;
const JWT_BACKDATE_SEC = 60;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

const b64url = (value) => Buffer.from(value).toString('base64url');
const optionalString = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;

/**
 * Mints the short-lived RS256 JWT a GitHub App authenticates with.
 *
 * The algorithm is fixed, never negotiated: the same alg-confusion rule as
 * forge-auth. `iat` is backdated 60s because GitHub rejects tokens whose clock
 * runs ahead of theirs, and 10 minutes is GitHub's hard maximum lifetime.
 */
export const mintAppJwt = ({ appId, privateKeyPem, now = () => Date.now() }) => {
  const id = optionalString(String(appId ?? ''));
  if (!id || !/^\d+$/.test(id)) throw new Error('GitHub App id must be numeric');
  const pem = optionalString(privateKeyPem);
  if (!pem) throw new Error('GitHub App private key is missing');
  const iat = Math.floor(now() / 1000) - JWT_BACKDATE_SEC;
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat, exp: iat + JWT_LIFETIME_SEC, iss: id }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(createPrivateKey(pem)).toString('base64url');
  return `${header}.${payload}.${signature}`;
};

/**
 * One broker per role App. Agents never see any of this: no PEM, no JWT, no
 * installation token. The narrow verbs (F3) call `installationToken()` and the
 * hour-long token stays inside the broker process.
 */
export const createGitHubAppBroker = ({
  appId,
  installationId,
  privateKeyPem,
  fetchImpl = globalThis.fetch,
  apiBase = 'https://api.github.com',
  now = () => Date.now(),
}) => {
  const installation = optionalString(String(installationId ?? ''));
  if (!installation || !/^\d+$/.test(installation)) throw new Error('GitHub installation id must be numeric');
  // Fails fast on a bad key instead of failing on first use.
  mintAppJwt({ appId, privateKeyPem, now });

  let cached = null;

  const installationToken = async () => {
    if (cached && cached.expiresAtMs - now() > TOKEN_REFRESH_MARGIN_MS) return cached.token;
    const response = await fetchImpl(`${apiBase}/app/installations/${installation}/access_tokens`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${mintAppJwt({ appId, privateKeyPem, now })}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (response.status !== 201) {
      throw new Error(`Installation token exchange for app ${appId} failed (${response.status})`);
    }
    const body = await response.json();
    const token = optionalString(body?.token);
    const expiresAtMs = Date.parse(body?.expires_at ?? '');
    if (!token || !Number.isFinite(expiresAtMs)) {
      throw new Error('Installation token response carries no usable token');
    }
    cached = { token, expiresAtMs };
    return token;
  };

  return { installationToken, mintJwt: () => mintAppJwt({ appId, privateKeyPem, now }) };
};

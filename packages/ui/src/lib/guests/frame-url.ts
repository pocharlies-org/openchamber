import { mintGuestFrameUrlAuthToken } from '@/lib/runtime-auth';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { getActiveRelayTunnel } from '@/lib/relay/runtime-tunnel';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { loadRelayGuestDocument } from './relay-document';

/**
 * Direct frames use a short-lived guest-scoped URL. Relay frames fetch their
 * HTML and static resources over authenticated runtime HTTP and use srcDoc;
 * browser-owned iframe requests cannot travel through the JS tunnel client.
 * Neither representation contains the runtime's bearer credential.
 *
 * A direct frame falls back to srcDoc too when the scoped URL alone is not
 * enough: behind a cookie-authenticated proxy (an SSO forward-auth in front
 * of the runtime) the sandboxed frame's own requests are cross-site and carry
 * no cookie, so the page loads but its scripts get a 401 and the frame stays
 * blank. The host's requests do carry the cookie.
 */
export type GuestFrameUrl =
  | { kind: 'url'; url: string; expiresAt: number }
  | { kind: 'document'; html: string };

const loadGuestDocument = async (
  guestId: string,
  entry: string,
  isCurrent: () => boolean,
  signal?: AbortSignal,
  origins: readonly string[] = [],
): Promise<GuestFrameUrl> => {
  const html = await loadRelayGuestDocument(guestId, entry, (path) => {
    if (!isCurrent() || signal?.aborted) {
      throw new DOMException('Extension frame owner changed', 'AbortError');
    }
    return runtimeFetch(path, { signal });
  }, origins);
  if (!isCurrent() || signal?.aborted) {
    throw new DOMException('Extension frame owner changed', 'AbortError');
  }
  return { kind: 'document', html };
};

/**
 * Whether the scoped URL loads without the host's cookies, as the sandboxed
 * frame will request it. Only a runtime on the page's own origin can sit
 * behind the page's cookie proxy; a cross-origin runtime (desktop loopback,
 * VS Code) keeps the scoped URL untested.
 */
const scopedUrlLoadsWithoutCookies = async (url: string, signal?: AbortSignal): Promise<boolean> => {
  if (typeof window === 'undefined') return true;
  try {
    if (new URL(url, window.location.href).origin !== window.location.origin) return true;
  } catch {
    return true;
  }
  try {
    const response = await fetch(url, { credentials: 'omit', cache: 'no-store', redirect: 'manual', signal });
    await response.body?.cancel().catch(() => {});
    return response.ok;
  } catch (error) {
    if (signal?.aborted) throw error;
    return false;
  }
};

export const resolveGuestFrameUrl = async (
  guestId: string,
  entry: string,
  signal?: AbortSignal,
  origins: readonly string[] = [],
): Promise<GuestFrameUrl> => {
  const runtimeKey = getRuntimeKey();
  const relay = getActiveRelayTunnel();
  if (relay) {
    return loadGuestDocument(guestId, entry, () => getRuntimeKey() === runtimeKey && getActiveRelayTunnel() === relay, signal, origins);
  }
  const { token, expiresAt } = await mintGuestFrameUrlAuthToken(guestId);
  if (runtimeKey !== getRuntimeKey()) throw new Error('Runtime changed while authorizing extension frame');
  const url = getRuntimeUrlResolver().assetWithUrlToken(`/api/guests/${guestId}/${entry}`, token, { oc_ui: 'issue-page' });
  if (!(await scopedUrlLoadsWithoutCookies(url, signal))) {
    return loadGuestDocument(guestId, entry, () => getRuntimeKey() === runtimeKey && !getActiveRelayTunnel(), signal, origins);
  }
  if (runtimeKey !== getRuntimeKey()) throw new Error('Runtime changed while authorizing extension frame');
  return { kind: 'url', url, expiresAt };
};

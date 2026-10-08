import brand from './brand.json';

/**
 * The product's display name. Single source for every user-visible string in the
 * shared UI: i18n messages interpolate it as `{brand}` (see `formatMessage`).
 * The values live in `brand/brand.json`; `scripts/brand-sync.mjs` copies it here
 * and writes the per-client constants (Electron `productName`, Capacitor `appName`,
 * the manifests). Identifiers that other systems consume (`@openchamber/*`,
 * `OPENCHAMBER_*`, the `openchamber` bin, `~/.local/openchamber`) are contracts and
 * keep their names; see `scripts/brand-allowlist.txt`.
 */
export const BRAND_NAME = brand.displayName;

/** The fork's repository: releases, About links. Upstream's slug must not come back (see scripts/upstream-slug.test.mjs). */
export const BRAND_REPO_URL = `https://github.com/${brand.repo.owner}/${brand.repo.name}`;

/** The URL scheme the app emits (`<scheme>://session/<id>`, pairing links) and, after it, the older ones every parser still accepts. */
export const BRAND_URL_SCHEME = brand.urlScheme;
export const BRAND_URL_SCHEMES: readonly string[] = [brand.urlScheme, ...brand.legacy.urlSchemes];

/** True when `protocol` (`URL.protocol`, e.g. `triora:`) is a scheme the app accepts. */
export const isBrandUrlProtocol = (protocol: string): boolean => BRAND_URL_SCHEMES.some((scheme) => protocol === `${scheme}:`);

/** True when `value` starts with `<scheme>://` for a scheme the app accepts (case-insensitive: links are pasted by hand). */
export const hasBrandUrlScheme = (value: string): boolean => {
  const lower = value.toLowerCase();
  return BRAND_URL_SCHEMES.some((scheme) => lower.startsWith(`${scheme}://`));
};

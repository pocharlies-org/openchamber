// The server's view of the product's brand. The values live in brand/brand.json (copied here byte for byte
// by scripts/brand-sync.mjs, because the npm package only publishes dist, server, bin and public); the UI and
// the desktop shell have their own facades over the same file. Identifiers other systems consume
// (`@openchamber/*`, `OPENCHAMBER_*`, the `openchamber` bin, `~/.local/openchamber`) are contracts and keep
// their names.
import brand from './brand.json' with { type: 'json' };

// Display name of the product in server responses.
export const APP_NAME = brand.displayName;
export const PRODUCT_NAME = brand.productName;
export const APP_ID = brand.appId;

// PWA manifest values. The static public/site.webmanifest and the inline manifest in index.html carry the
// same literals (they cannot import this module); scripts/brand-sync.mjs --check fails if they diverge.
export const PWA_DESCRIPTION = brand.description;
export const PWA_THEME_COLOR = brand.themeColor;

// The fork's GitHub repository, the one source for release and changelog lookups.
// Upstream's slug must not come back (see scripts/upstream-slug.test.mjs).
export const REPO_OWNER = brand.repo.owner;
export const REPO_NAME = brand.repo.name;
export const REPO_SLUG = `${REPO_OWNER}/${REPO_NAME}`;

// The product's own community channels ({ discord?, x?: { url, handle } }); empty when it has none.
export const SOCIAL = brand.social;

// The URL scheme the product emits and registers, and the ones every parser still accepts.
export const URL_SCHEME = brand.urlScheme;
export const LEGACY_URL_SCHEMES = brand.legacy.urlSchemes;
export const URL_SCHEMES = [URL_SCHEME, ...LEGACY_URL_SCHEMES];

// Folder name (under appData) of the user's existing data. Electron derives userData from the app name, so
// renaming the app would otherwise orphan settings and sessions.
export const LEGACY_USER_DATA_DIR = brand.legacy.userDataDir;

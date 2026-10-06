/**
 * The product's display name. Single source for every user-visible string in the
 * shared UI: i18n messages interpolate it as `{brand}` (see `formatMessage`).
 * Per-client constants (Electron `productName`, Capacitor `appName`, the VS Code
 * manifest) live in their own configs. Identifiers that other systems consume
 * (`@openchamber/*`, `OPENCHAMBER_*`, the `openchamber` bin, `~/.local/openchamber`)
 * are contracts and keep their names; see `scripts/brand-allowlist.txt`.
 */
export const BRAND_NAME = 'AgentChamber';

/** The fork's repository: releases, About links. Upstream's slug must not come back (see scripts/upstream-slug.test.mjs). */
export const BRAND_REPO_URL = 'https://github.com/pocharlies-org/openchamber';

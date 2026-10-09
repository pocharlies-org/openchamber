// Display name of the product in server responses (the UI has its own in packages/ui/src/lib/brand.ts).
export const APP_NAME = 'AgentChamber';

// PWA manifest values. The static public/site.webmanifest and the inline manifest in index.html carry
// the same literals (they cannot import this module); pwa-brand.test.js fails if the three diverge.
export const PWA_DESCRIPTION = 'One workspace for your AI coding agents: Claude and OpenCode';
export const PWA_THEME_COLOR = '#ee4f0c';

// The fork's GitHub repository, the one source for release and changelog lookups.
// Upstream's slug must not come back (see scripts/upstream-slug.test.mjs).
export const REPO_SLUG = 'pocharlies-org/openchamber';

// Display name of the desktop app. Must match `build.productName` in package.json.
// The shared UI has its own copy in packages/ui/src/lib/brand.ts (different bundle).
export const APP_NAME = 'AgentChamber';

// Folder name (under appData) of the user's existing data. Electron derives userData
// from the app name, so renaming the app would otherwise orphan settings and sessions.
export const LEGACY_USER_DATA_DIR = 'OpenChamber';

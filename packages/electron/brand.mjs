// The desktop shell reads the same brand as the server (brand/brand.json through the web package, which
// stays external in the bundle and resolves from node_modules at runtime).
export {
  APP_ID,
  APP_NAME,
  LEGACY_USER_DATA_DIR,
  PRODUCT_NAME,
  REPO_NAME,
  REPO_OWNER,
  URL_SCHEMES,
} from '@openchamber/web/server/lib/brand.js';

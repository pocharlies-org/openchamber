import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchUpdateNotes } from './changelog/update-notes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PACKAGE_NAME = '@openchamber/web';
const PACKAGE_PATH_SEGMENTS = PACKAGE_NAME.split('/');
// The fork publishes its own releases and they are the only update source:
// there is no @openchamber/web package for the fork, and npm would report
// upstream (measured 2026-09-15: an npm-based update installed upstream over
// this build in production). See docs/release-promotion.md.
const GITHUB_RELEASES_URL = 'https://github.com/pocharlies-org/openchamber/releases';
const GITHUB_RELEASES_API_URL = 'https://api.github.com/repos/pocharlies-org/openchamber/releases';
let cachedDetectedPm = null;

function getSpawnSyncBaseOptions() {
  return process.platform === 'win32' ? { windowsHide: true } : {};
}

function mapPlatform(value) {
  if (value === 'darwin') return 'macos';
  if (value === 'win32') return 'windows';
  if (value === 'linux') return 'linux';
  return 'web';
}

function normalizeAppType(value) {
  if (value === 'web' || value === 'desktop-electron' || value === 'vscode' || value === 'mobile-capacitor') return value;
  return 'web';
}

function normalizePlatform(value) {
  if (value === 'macos' || value === 'windows' || value === 'linux' || value === 'web' || value === 'android' || value === 'ios') return value;
  return mapPlatform(process.platform);
}

async function resolveAndroidApkUrl(version, candidateUrl) {
  if (typeof candidateUrl === 'string') {
    try {
      if (new URL(candidateUrl).pathname.toLowerCase().endsWith('.apk')) return candidateUrl;
    } catch {
      // Resolve malformed or non-APK values from the authoritative release assets below.
    }
  }

  try {
    const response = await fetch(`${GITHUB_RELEASES_API_URL}/tags/v${version}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'openchamber-update-check',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return undefined;

    const release = await response.json();
    const apkAssets = Array.isArray(release?.assets)
      ? release.assets.filter((asset) => (
        typeof asset?.name === 'string'
        && asset.name.toLowerCase().endsWith('.apk')
        && typeof asset.browser_download_url === 'string'
      ))
      : [];
    const canonicalAsset = apkAssets.find((asset) => /^OpenChamber-.+-android\.apk$/i.test(asset.name));
    return (canonicalAsset || apkAssets[0])?.browser_download_url;
  } catch {
    return undefined;
  }
}

function normalizePathForComparison(filePath) {
  if (!filePath || typeof filePath !== 'string') return null;
  const normalized = path.normalize(path.resolve(filePath));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function getComparablePaths(filePath) {
  const paths = new Set();
  const normalized = normalizePathForComparison(filePath);
  if (normalized) {
    paths.add(normalized);
  }

  try {
    const realPath = fs.realpathSync.native ? fs.realpathSync.native(filePath) : fs.realpathSync(filePath);
    const normalizedRealPath = normalizePathForComparison(realPath);
    if (normalizedRealPath) {
      paths.add(normalizedRealPath);
    }
  } catch {
  }

  return paths;
}

function pathSetContains(a, b) {
  for (const value of a) {
    if (b.has(value)) {
      return true;
    }
  }
  return false;
}

function getCurrentPackagePath() {
  return path.resolve(__dirname, '..', '..');
}

function getPackagePathForGlobalRoot(rootPath) {
  if (!rootPath) return null;
  return path.join(rootPath, ...PACKAGE_PATH_SEGMENTS);
}

function getUniquePaths(paths) {
  const seen = new Set();
  const result = [];
  for (const value of paths) {
    const normalized = normalizePathForComparison(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(path.resolve(value));
  }
  return result;
}

function getCommandOutput(command, args) {
  try {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
      ...getSpawnSyncBaseOptions(),
    });

    if (result.status !== 0) {
      return null;
    }

    const stdout = result.stdout.trim();
    return stdout || null;
  } catch {
    return null;
  }
}

function getGlobalBinDirs(pm) {
  const pmCommand = resolvePackageManagerCommand(pm);
  if (!isCommandAvailable(pmCommand)) {
    return [];
  }

  const dirs = [];
  switch (pm) {
    case 'pnpm': {
      const pnpmBin = getCommandOutput(pmCommand, ['bin', '-g']);
      if (pnpmBin) dirs.push(pnpmBin);
      const pnpmPrefix = getCommandOutput(pmCommand, ['prefix', '-g']);
      if (pnpmPrefix) dirs.push(process.platform === 'win32' ? pnpmPrefix : path.join(pnpmPrefix, 'bin'));
      break;
    }
    case 'yarn': {
      const yarnBin = getCommandOutput(pmCommand, ['global', 'bin']);
      if (yarnBin) dirs.push(yarnBin);
      break;
    }
    case 'bun': {
      const bunBin = getCommandOutput(pmCommand, ['pm', 'bin', '-g']);
      if (bunBin) dirs.push(bunBin);
      break;
    }
    default: {
      const npmPrefix = getCommandOutput(pmCommand, ['prefix', '-g']);
      if (npmPrefix) dirs.push(process.platform === 'win32' ? npmPrefix : path.join(npmPrefix, 'bin'));
      break;
    }
  }

  return getUniquePaths(dirs);
}

function getGlobalNodeModulesRoots(pm) {
  try {
    const pmCommand = resolvePackageManagerCommand(pm);
    if (!isCommandAvailable(pmCommand)) {
      return [];
    }

    const roots = [];

    switch (pm) {
      case 'pnpm': {
        const pnpmRoot = getCommandOutput(pmCommand, ['root', '-g']);
        if (pnpmRoot) roots.push(pnpmRoot);
        const pnpmPrefix = getCommandOutput(pmCommand, ['prefix', '-g']);
        if (pnpmPrefix) roots.push(process.platform === 'win32' ? path.join(pnpmPrefix, 'node_modules') : path.join(pnpmPrefix, 'lib', 'node_modules'));
        break;
      }
      case 'yarn': {
        const yarnDir = getCommandOutput(pmCommand, ['global', 'dir']);
        if (yarnDir) roots.push(path.join(yarnDir, 'node_modules'));
        break;
      }
      case 'bun': {
        const bunBinDir = getCommandOutput(pmCommand, ['pm', 'bin', '-g']);
        if (bunBinDir) {
          roots.push(path.resolve(bunBinDir, '..', 'install', 'global', 'node_modules'));
          roots.push(path.resolve(bunBinDir, '..', '..', 'node_modules'));
        }
        break;
      }
      default:
      {
        const npmRoot = getCommandOutput(pmCommand, ['root', '-g']);
        if (npmRoot) roots.push(npmRoot);
        const npmPrefix = getCommandOutput(pmCommand, ['prefix', '-g']);
        if (npmPrefix) roots.push(process.platform === 'win32' ? path.join(npmPrefix, 'node_modules') : path.join(npmPrefix, 'lib', 'node_modules'));
        break;
      }
    }

    return getUniquePaths(roots);
  } catch {
    return [];
  }
}

function getOwnedPackagePathsFromGlobalBins(pm) {
  const packagePaths = [];
  for (const binDir of getGlobalBinDirs(pm)) {
    const binaryName = process.platform === 'win32' ? 'openchamber.cmd' : 'openchamber';
    const binaryPath = path.join(binDir, binaryName);
    if (!fs.existsSync(binaryPath)) continue;

    try {
      const realBinaryPath = fs.realpathSync.native ? fs.realpathSync.native(binaryPath) : fs.realpathSync(binaryPath);
      packagePaths.push(path.resolve(realBinaryPath, '..', '..'));
    } catch {
    }
  }

  return getUniquePaths(packagePaths);
}

function detectPackageManagerFromCurrentInstallPath() {
  return detectPackageManagerFromInstallPath(getCurrentPackagePath());
}

function packageManagerOwnsCurrentInstall(pm) {
  const currentPackagePaths = getComparablePaths(getCurrentPackagePath());
  const candidatePackagePaths = [
    ...getGlobalNodeModulesRoots(pm).map(getPackagePathForGlobalRoot),
    ...getOwnedPackagePathsFromGlobalBins(pm),
  ];

  for (const candidatePath of candidatePackagePaths) {
    if (!candidatePath) continue;
    if (pathSetContains(currentPackagePaths, getComparablePaths(candidatePath))) {
      return true;
    }
  }

  return false;
}

export function detectPackageManagerDetails() {
  // In desktop (Electron) runtime, package-manager detection is worthless —
  // the app ships as a .app bundle, not installed via npm/pnpm/yarn/bun, and
  // updates are handled by electron-updater. The detection path does up to a
  // dozen spawnSync(pm, ['bin', '-g']) calls with 10s timeouts each; under
  // the in-process server every one blocks the Electron main event loop and
  // manifests as a multi-second UI freeze. Short-circuit here.
  if (process.env.OPENCHAMBER_RUNTIME === 'desktop') {
    return {
      packageManager: 'electron',
      reason: 'desktop-runtime',
      packagePath: null,
      packageManagerCommand: null,
      globalNodeModulesRoot: null,
    };
  }

  if (cachedDetectedPm) {
      return {
        packageManager: cachedDetectedPm,
        reason: 'cached',
        packagePath: getCurrentPackagePath(),
        packageManagerCommand: resolvePackageManagerCommand(cachedDetectedPm),
        globalNodeModulesRoot: getGlobalNodeModulesRoots(cachedDetectedPm)[0] || null,
      };
  }

  const forcedPm = process.env.OPENCHAMBER_PACKAGE_MANAGER?.trim();
  if (forcedPm && ['npm', 'pnpm', 'yarn', 'bun'].includes(forcedPm)) {
    const forcedPmCommand = resolvePackageManagerCommand(forcedPm);
    if (isCommandAvailable(forcedPmCommand)) {
      cachedDetectedPm = forcedPm;
      return {
        packageManager: cachedDetectedPm,
        reason: 'forced-env',
        packagePath: getCurrentPackagePath(),
        packageManagerCommand: forcedPmCommand,
        globalNodeModulesRoot: getGlobalNodeModulesRoots(cachedDetectedPm)[0] || null,
      };
    }
  }

  // First prefer the package manager that demonstrably owns the current install.
  const installPathPm = detectPackageManagerFromCurrentInstallPath();
  if (installPathPm && packageManagerOwnsCurrentInstall(installPathPm)) {
    cachedDetectedPm = installPathPm;
    return {
      packageManager: cachedDetectedPm,
      reason: 'install-path-owner',
      packagePath: getCurrentPackagePath(),
      packageManagerCommand: resolvePackageManagerCommand(cachedDetectedPm),
      globalNodeModulesRoot: getGlobalNodeModulesRoots(cachedDetectedPm)[0] || null,
    };
  }

  const ownershipCandidates = ['pnpm', 'yarn', 'bun', 'npm'];
  for (const candidate of ownershipCandidates) {
    if (packageManagerOwnsCurrentInstall(candidate)) {
      cachedDetectedPm = candidate;
      return {
        packageManager: cachedDetectedPm,
        reason: 'global-root-owner',
        packagePath: getCurrentPackagePath(),
        packageManagerCommand: resolvePackageManagerCommand(cachedDetectedPm),
        globalNodeModulesRoot: getGlobalNodeModulesRoots(cachedDetectedPm)[0] || null,
      };
    }
  }

  // Fall back to weaker hints only when ownership cannot be established.
  const userAgent = process.env.npm_config_user_agent || '';
  let hintedPm = null;
  if (userAgent.startsWith('pnpm')) hintedPm = 'pnpm';
  else if (userAgent.startsWith('yarn')) hintedPm = 'yarn';
  else if (userAgent.startsWith('bun')) hintedPm = 'bun';
  else if (userAgent.startsWith('npm')) hintedPm = 'npm';

  // Check execpath.
  const execPath = process.env.npm_execpath || '';
  if (!hintedPm) {
    if (execPath.includes('pnpm')) hintedPm = 'pnpm';
    else if (execPath.includes('yarn')) hintedPm = 'yarn';
    else if (execPath.includes('bun')) hintedPm = 'bun';
    else if (execPath.includes('npm')) hintedPm = 'npm';
  }

  // Detect from invoked binary path.
  const invokedPm = detectPackageManagerFromInvocationPath(process.argv?.[1]);
  if (!hintedPm) {
    hintedPm = invokedPm;
  }

  if (!hintedPm) {
    hintedPm = installPathPm;
  }

  // Validate the hint against package visibility, but only after ownership checks failed.
  if (hintedPm && isCommandAvailable(resolvePackageManagerCommand(hintedPm)) && isPackageInstalledWith(hintedPm)) {
    cachedDetectedPm = hintedPm;
    return {
      packageManager: cachedDetectedPm,
      reason: 'hinted-visible-install',
      packagePath: getCurrentPackagePath(),
      packageManagerCommand: resolvePackageManagerCommand(cachedDetectedPm),
      globalNodeModulesRoot: getGlobalNodeModulesRoots(cachedDetectedPm)[0] || null,
    };
  }

  const runtimePm = detectPackageManagerFromRuntimePath(process.execPath);
  if (runtimePm && isCommandAvailable(resolvePackageManagerCommand(runtimePm)) && isPackageInstalledWith(runtimePm)) {
    cachedDetectedPm = runtimePm;
    return {
      packageManager: cachedDetectedPm,
      reason: 'runtime-visible-install',
      packagePath: getCurrentPackagePath(),
      packageManagerCommand: resolvePackageManagerCommand(cachedDetectedPm),
      globalNodeModulesRoot: getGlobalNodeModulesRoots(cachedDetectedPm)[0] || null,
    };
  }

  // Last resort: pick a PM that can at least see the package.
  const pmChecks = [
    { name: 'pnpm', check: () => isCommandAvailable(resolvePackageManagerCommand('pnpm')) },
    { name: 'yarn', check: () => isCommandAvailable(resolvePackageManagerCommand('yarn')) },
    { name: 'bun', check: () => isCommandAvailable(resolvePackageManagerCommand('bun')) },
    { name: 'npm', check: () => isCommandAvailable(resolvePackageManagerCommand('npm')) },
  ];

  for (const { name, check } of pmChecks) {
    if (check()) {
      // Verify this PM actually has the package installed globally
      if (isPackageInstalledWith(name)) {
        cachedDetectedPm = name;
        return {
          packageManager: cachedDetectedPm,
          reason: 'last-resort-visible-install',
          packagePath: getCurrentPackagePath(),
          packageManagerCommand: resolvePackageManagerCommand(cachedDetectedPm),
          globalNodeModulesRoot: getGlobalNodeModulesRoots(cachedDetectedPm)[0] || null,
        };
      }
    }
  }

  cachedDetectedPm = 'npm';
  return {
    packageManager: cachedDetectedPm,
    reason: 'default-fallback',
    packagePath: getCurrentPackagePath(),
    packageManagerCommand: resolvePackageManagerCommand(cachedDetectedPm),
    globalNodeModulesRoot: getGlobalNodeModulesRoots(cachedDetectedPm)[0] || null,
  };
}

export function detectPackageManager() {
  return detectPackageManagerDetails().packageManager;
}

function detectPackageManagerFromInstallPath(pkgPath) {
  if (!pkgPath) return null;
  const normalized = pkgPath.replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('/.pnpm/') || normalized.includes('/pnpm/')) return 'pnpm';
  if (normalized.includes('/.yarn/')) return 'yarn';
  if (normalized.includes('/.bun/') || normalized.includes('/bun/install/')) return 'bun';
  if (normalized.includes('/node_modules/')) return 'npm';
  return null;
}

function detectPackageManagerFromRuntimePath(runtimePath) {
  if (!runtimePath || typeof runtimePath !== 'string') return null;
  const normalized = runtimePath.replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('/.bun/bin/bun') || normalized.endsWith('/bun') || normalized.endsWith('/bun.exe')) {
    return 'bun';
  }
  if (normalized.includes('/pnpm/')) return 'pnpm';
  if (normalized.includes('/yarn/')) return 'yarn';
  if (normalized.includes('/node') || normalized.endsWith('/node.exe')) return 'npm';
  return null;
}

function detectPackageManagerFromInvocationPath(invokedPath) {
  if (!invokedPath || typeof invokedPath !== 'string') return null;
  const normalized = invokedPath.replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('/.bun/bin/')) return 'bun';
  if (normalized.includes('/.pnpm/')) return 'pnpm';
  if (normalized.includes('/.yarn/')) return 'yarn';
  return null;
}

function getPackageManagerCommandCandidates(pm) {
  const candidates = [];
  if (pm === 'bun') {
    const bunExecutable = process.platform === 'win32' ? 'bun.exe' : 'bun';
    if (process.env.BUN_INSTALL) {
      candidates.push(path.join(process.env.BUN_INSTALL, 'bin', bunExecutable));
    }
    if (process.env.HOME) {
      candidates.push(path.join(process.env.HOME, '.bun', 'bin', bunExecutable));
    }
    if (process.env.USERPROFILE) {
      candidates.push(path.join(process.env.USERPROFILE, '.bun', 'bin', bunExecutable));
    }
  }
  candidates.push(pm);
  return [...new Set(candidates.filter(Boolean))];
}

function resolvePackageManagerCommand(pm) {
  const candidates = getPackageManagerCommandCandidates(pm);
  for (const candidate of candidates) {
    if (isCommandAvailable(candidate)) {
      return candidate;
    }
  }
  return pm;
}

function quoteCommand(command) {
  if (!command) return command;
  if (!/\s/.test(command)) return command;
  if (process.platform === 'win32') {
    return `"${command.replace(/"/g, '""')}"`;
  }
  return `'${command.replace(/'/g, "'\\''")}'`;
}

function isCommandAvailable(command) {
  try {
    const result = spawnSync(command, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
      ...getSpawnSyncBaseOptions(),
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function getGlobalListArgs(pm) {
  switch (pm) {
    case 'pnpm':
      return ['list', '-g', '--depth=0', PACKAGE_NAME];
    case 'yarn':
      return ['global', 'list', '--depth=0'];
    case 'bun':
      return ['pm', 'ls', '-g'];
    default:
      return ['list', '-g', '--depth=0', PACKAGE_NAME];
  }
}

function isPackageInstalledWith(pm) {
  try {
    const pmCommand = resolvePackageManagerCommand(pm);
    const args = getGlobalListArgs(pm);

    const result = spawnSync(pmCommand, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
      ...getSpawnSyncBaseOptions(),
    });

    if (result.status !== 0) return false;
    return result.stdout.includes(PACKAGE_NAME) || result.stdout.includes('openchamber');
  } catch {
    return false;
  }
}

// npm, bun and yarn print `name@version`; pnpm separates the name and the
// version with whitespace. An optional `v` covers yarn listing formats.
const GLOBAL_VERSION_PATTERN = /@openchamber\/web[@\s]+v?(\d[\w.+-]*)/;

/**
 * Read the globally installed version of the package as reported by the
 * package manager itself. Returns null when the listing cannot be read or
 * parsed. The listing command may exit non-zero when the package is missing,
 * so stdout is parsed regardless of the status.
 */
function getInstalledGlobalVersion(pm) {
  try {
    const pmCommand = resolvePackageManagerCommand(pm);
    const result = spawnSync(pmCommand, getGlobalListArgs(pm), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
      ...getSpawnSyncBaseOptions(),
    });
    return String(result.stdout || '').match(GLOBAL_VERSION_PATTERN)?.[1] || null;
  } catch {
    return null;
  }
}

/**
 * Normalize a version string into an exact install target.
 * Returns the plain version or null when the value is not a concrete version.
 */
function normalizeTargetVersion(value) {
  const normalized = String(value ?? '').trim().replace(/^v/, '');
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(normalized) ? normalized : null;
}

/**
 * Get the update command for the detected package manager.
 * When an exact target version is given, it is pinned in the spec instead of
 * re-resolving the `latest` dist-tag at install time: the update check and the
 * package manager see different metadata, and dist-tag resolution can lag the
 * check behind a fresh release (stale packument cache, pnpm minimumReleaseAge).
 */
export function getUpdateCommand(pm = detectPackageManager(), options = {}) {
  // Every install path (CLI `openchamber update`, the update-install route)
  // builds its command here, so this is where the fork refuses: the fork is
  // not published to npm, and `npm install -g @openchamber/web` pulls
  // upstream over this build (measured 2026-09-15). Install from the release
  // assets per docs/release-promotion.md.
  throw new Error(
    `This build is not installed from npm. Update it from the GitHub Release assets of ${GITHUB_RELEASES_URL}, following docs/release-promotion.md`,
  );
}

/**
 * Get current installed version from package.json
 */
export function getCurrentVersion() {
  try {
    const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * The fork's newest published release, read from its GitHub Releases API.
 * A prerelease tag is still a release the fork published, so `latest` is the
 * honest answer; a tag that is not a version (a bad manual tag) is not.
 */
export function parseLatestReleaseTag(payload) {
  const tag = typeof payload?.tag_name === 'string' ? payload.tag_name.trim() : '';
  const version = tag.replace(/^v/, '');
  return /^\d+(\.\d+)*([-+][0-9A-Za-z.+-]+)?$/.test(version) ? version : null;
}

async function getLatestVersion() {
  try {
    const response = await fetch(`${GITHUB_RELEASES_API_URL}/latest`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'openchamber-update-check',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return null;
    return parseLatestReleaseTag(await response.json());
  } catch (error) {
    return null;
  }
}

/**
 * Compare semver-like version strings.
 */
function parseVersionForComparison(value) {
  const normalized = String(value || '').replace(/^v/, '').split('+')[0];
  const prereleaseIndex = normalized.indexOf('-');
  const core = prereleaseIndex >= 0 ? normalized.slice(0, prereleaseIndex) : normalized;
  const parts = core.split('.').map((part) => {
    const parsed = Number.parseInt(part || '0', 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });

  return {
    parts,
    prerelease: prereleaseIndex >= 0,
  };
}

function compareVersions(left, right) {
  const a = parseVersionForComparison(left);
  const b = parseVersionForComparison(right);
  const length = Math.max(a.parts.length, b.parts.length);

  for (let index = 0; index < length; index += 1) {
    const diff = (a.parts[index] || 0) - (b.parts[index] || 0);
    if (diff !== 0) return diff;
  }

  if (a.prerelease !== b.prerelease) {
    return a.prerelease ? -1 : 1;
  }

  return 0;
}

/** Release notes between the installed and the offered version, or undefined. */
async function fetchChangelogNotes(fromVersion, toVersion) {
  return (await fetchUpdateNotes(fromVersion, toVersion, compareVersions)) ?? undefined;
}

export async function checkForUpdates(options = {}) {
  const currentVersion = options.currentVersion || getCurrentVersion();
  const pm = detectPackageManager();
  const appType = normalizeAppType(options.appType);
  const platform = normalizePlatform(options.platform);

  const latestVersion = await getLatestVersion();

  if (!latestVersion || currentVersion === 'unknown') {
    return {
      available: false,
      currentVersion,
      error: 'Unable to determine versions',
    };
  }

  const available = compareVersions(latestVersion, currentVersion) > 0;
  let changelog;
  let downloadUrl;
  if (available) {
    changelog = await fetchChangelogNotes(currentVersion, latestVersion);
    if (appType === 'mobile-capacitor' && platform === 'android') {
      downloadUrl = await resolveAndroidApkUrl(latestVersion);
    }
  }

  return {
    available,
    version: latestVersion,
    currentVersion,
    body: changelog,
    releaseUrl: `${GITHUB_RELEASES_URL}/tag/v${latestVersion}`,
    downloadUrl,
    packageManager: pm,
    // The fork is not installed with a package manager command; the update
    // dialog points at the promotion runbook instead of a command to paste.
    updateCommand: 'see docs/release-promotion.md',
  };
}

/**
 * Execute the update (used by CLI).
 * When an exact target version is given, the globally installed version is
 * read back after the package manager exits: a zero exit status alone is not
 * proof the target landed (stale dist-tag resolution, pnpm release-age policy),
 * and the caller must not report success without the version matching.
 */
export function executeUpdate(pm = detectPackageManager(), options = {}) {
  let command;
  try {
    command = getUpdateCommand(pm, { targetVersion: options.targetVersion });
  } catch (error) {
    return { success: false, error: error.message };
  }
  if (!options?.silent) {
    console.log(`Updating ${PACKAGE_NAME} using ${pm}...`);
    console.log(`Running: ${command}`);
  }

  const result = spawnSync(command, {
    stdio: 'inherit',
    shell: true,
    ...getSpawnSyncBaseOptions(),
  });

  if (result.status !== 0) {
    return {
      success: false,
      exitCode: result.status,
      error: `Package manager exited with code ${result.status}`,
    };
  }

  const targetVersion = normalizeTargetVersion(options.targetVersion);
  if (!targetVersion) {
    return {
      success: true,
      exitCode: result.status,
      installedVersion: null,
    };
  }

  const installedVersion = getInstalledGlobalVersion(pm);
  if (!installedVersion) {
    return {
      success: false,
      exitCode: result.status,
      error: `Could not determine the globally installed ${PACKAGE_NAME} version after the update; not reporting success`,
    };
  }

  if (compareVersions(installedVersion, targetVersion) !== 0) {
    return {
      success: false,
      exitCode: result.status,
      error: `Installed ${PACKAGE_NAME} version ${installedVersion} does not match target ${targetVersion}. The package manager may have resolved different metadata or filtered the release.`,
    };
  }

  return {
    success: true,
    exitCode: result.status,
    installedVersion,
  };
}

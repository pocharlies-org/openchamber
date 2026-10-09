import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock child_process to prevent real spawnSync calls that would hang in tests
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 0, stdout: '/usr/local/bin', stderr: '' })),
}));

const {
  checkForUpdates,
  detectPackageManager,
  executeUpdate,
  getCurrentVersion,
  getUpdateCommand,
  parseLatestReleaseTag,
} = await import('./package-manager.js');

const LATEST_URL = 'api.github.com/repos/pocharlies-org/openchamber/releases/latest';

/** Helper: create a fetch mock that routes by URL pattern */
function createFetchMock() {
  const handlers = new Map();

  const mock = vi.fn((url, options) => {
    const urlStr = typeof url === 'string' ? url : url.toString();

    for (const [pattern, response] of handlers) {
      if (urlStr.includes(pattern)) {
        return Promise.resolve(response);
      }
    }

    return Promise.reject(new Error(`Unexpected fetch call: ${urlStr}`));
  });

  mock.when = (pattern, response) => {
    handlers.set(pattern, response);
    return mock;
  };

  return mock;
}

const releaseResponse = (tagName) => ({
  ok: true,
  json: async () => ({ tag_name: tagName }),
});

describe('checkForUpdates', () => {
  let fetchMock;
  let originalFetch;

  beforeEach(() => {
    fetchMock = createFetchMock();
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('reports an update from the fork\'s latest GitHub Release', async () => {
    fetchMock
      .when(LATEST_URL, releaseResponse('v1.10.0'))
      .when('raw.githubusercontent.com', {
        ok: true,
        text: async () => '## [1.10.0] - 2026-05-01\n\n- Great new feature',
      });

    const result = await checkForUpdates({ currentVersion: '1.9.10' });

    expect(result.available).toBe(true);
    expect(result.version).toBe('1.10.0');
    expect(result.currentVersion).toBe('1.9.10');
    expect(result.releaseUrl).toBe('https://github.com/pocharlies-org/openchamber/releases/tag/v1.10.0');
    expect(result.updateCommand).toContain('docs/release-promotion.md');
    // The fork never talks to the upstream update API or the npm registry.
    for (const [url] of fetchMock.mock.calls) {
      expect(String(url)).not.toContain('api.openchamber.dev');
      expect(String(url)).not.toContain('registry.npmjs.org');
    }
  });

  it('reports no update when the latest release is the installed version', async () => {
    fetchMock.when(LATEST_URL, releaseResponse('v1.9.10'));

    const result = await checkForUpdates({ currentVersion: '1.9.10' });

    expect(result.available).toBe(false);
  });

  it('reports no update when the latest release is a prerelease of the installed version', async () => {
    fetchMock.when(LATEST_URL, releaseResponse('v1.10.0-beta.1'));

    const result = await checkForUpdates({ currentVersion: '1.10.0' });

    expect(result.available).toBe(false);
  });

  it('reports no version when the releases endpoint is unreachable', async () => {
    fetchMock.when(LATEST_URL, Promise.reject(new Error('Network error')));

    const result = await checkForUpdates({ currentVersion: '1.9.10' });

    expect(result.available).toBe(false);
    expect(result.error).toBe('Unable to determine versions');
  });

  it('reports no version when the releases endpoint answers non-ok', async () => {
    fetchMock.when(LATEST_URL, { ok: false, status: 403, json: async () => ({}) });

    const result = await checkForUpdates({ currentVersion: '1.9.10' });

    expect(result.available).toBe(false);
    expect(result.error).toBe('Unable to determine versions');
  });

  it('reports no version when the latest tag is not a version', async () => {
    fetchMock.when(LATEST_URL, releaseResponse('nightly-latest'));

    const result = await checkForUpdates({ currentVersion: '1.9.10' });

    expect(result.available).toBe(false);
    expect(result.error).toBe('Unable to determine versions');
  });

  it('resolves an Android APK asset from the fork\'s release', async () => {
    fetchMock
      .when(LATEST_URL, releaseResponse('v1.10.0'))
      .when('raw.githubusercontent.com', { ok: true, text: async () => '' })
      .when('api.github.com/repos/pocharlies-org/openchamber/releases/tags/v1.10.0', {
        ok: true,
        json: async () => ({
          assets: [
            {
              name: 'OpenChamber-1.10.0-42-android.aab',
              browser_download_url: 'https://downloads.example/OpenChamber-1.10.0-42-android.aab',
            },
            {
              name: 'app-release.apk',
              browser_download_url: 'https://downloads.example/app-release.apk',
            },
            {
              name: 'OpenChamber-1.10.0-42-android.apk',
              browser_download_url: 'https://downloads.example/OpenChamber-1.10.0-42-android.apk',
            },
          ],
        }),
      });

    const result = await checkForUpdates({
      appType: 'mobile-capacitor',
      platform: 'android',
      currentVersion: '1.9.10',
    });

    expect(result.downloadUrl).toBe('https://downloads.example/OpenChamber-1.10.0-42-android.apk');
  });
});

describe('parseLatestReleaseTag', () => {
  it('accepts a version tag with or without the v prefix', () => {
    expect(parseLatestReleaseTag({ tag_name: 'v1.2.3' })).toBe('1.2.3');
    expect(parseLatestReleaseTag({ tag_name: '1.2.3' })).toBe('1.2.3');
  });

  it('accepts a prerelease tag', () => {
    expect(parseLatestReleaseTag({ tag_name: 'v1.2.3-beta.1' })).toBe('1.2.3-beta.1');
  });

  it('rejects tags that are not versions', () => {
    expect(parseLatestReleaseTag({ tag_name: 'latest' })).toBeNull();
    expect(parseLatestReleaseTag({ tag_name: 'v1.2.3; rm -rf /' })).toBeNull();
    expect(parseLatestReleaseTag({})).toBeNull();
    expect(parseLatestReleaseTag(null)).toBeNull();
  });
});

describe('getCurrentVersion', () => {
  it('is exported for the CLI update command', () => {
    expect(typeof getCurrentVersion).toBe('function');
    expect(getCurrentVersion()).toMatch(/^\d+\.\d+\.\d+|unknown$/);
  });
});

describe('getUpdateCommand', () => {
  it('refuses: the fork is not installed from npm', () => {
    expect(() => getUpdateCommand('npm', { targetVersion: '1.24.1' })).toThrow(/not installed from npm/);
    expect(() => getUpdateCommand('npm', { targetVersion: '1.24.1' })).toThrow(/docs\/release-promotion\.md/);
    expect(() => getUpdateCommand('npm')).toThrow(/not installed from npm/);
  });
});

describe('executeUpdate', () => {
  it('fails with the runbook pointer instead of running a package manager', () => {
    const result = executeUpdate('npm', { targetVersion: '1.24.1' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not installed from npm');
    expect(result.error).toContain('docs/release-promotion.md');
  });
});

describe('CLI update exports', () => {
  it('exports package-manager helpers used by the update command', () => {
    expect(typeof detectPackageManager).toBe('function');
    expect(typeof executeUpdate).toBe('function');
  });
});

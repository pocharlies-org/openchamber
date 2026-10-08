#!/usr/bin/env node
// Writes every brand value that cannot import brand/brand.json (the single source of the product's name,
// ids and icons) into the files that need it as text: the JSON copies the UI and the server bundle, the
// Electron package.json, the iOS Info.plists, Android strings.xml, index.html and the PWA manifest.
// Each value is located by its key, never by line number.
//
//   node scripts/brand-sync.mjs            write what differs
//   node scripts/brand-sync.mjs --check    write nothing, exit 1 if anything differs (CI and brand.test.mjs)
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { brandMarkMarkup } from './lib/brand-mark.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const at = (relative) => join(ROOT, relative);
const read = (relative) => readFileSync(at(relative), 'utf8');

const text = z.string().trim().min(1);
const BrandSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/, 'lowercase letters, digits and dashes'),
  displayName: text.max(12, 'must fit the iOS home-screen label (12 characters)'),
  productName: text,
  appId: z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2,}$/, 'a lowercase reverse-DNS id'),
  urlScheme: z.string().regex(/^[a-z][a-z0-9+.-]*$/, 'a lowercase URL scheme'),
  description: text,
  themeColor: z.string().regex(/^#[0-9a-f]{6}$/i, '#rrggbb'),
  repo: z.strictObject({ owner: text, name: text }),
  // The product's own channels; a product without them leaves the block empty and the UI draws no row.
  social: z.strictObject({
    discord: z.url().optional(),
    x: z.strictObject({ url: z.url(), handle: text }).optional(),
  }),
  icons: z.strictObject({ app: text, macos: text, small: text, mono: text }),
  legacy: z.strictObject({
    userDataDir: text,
    urlSchemes: z.array(text).min(1, 'list the schemes the old builds registered'),
    names: z.array(text),
    deviceLabels: z.array(text),
    nsisGuid: z.uuid(),
  }),
}).refine((brand) => !brand.legacy.urlSchemes.includes(brand.urlScheme), {
  path: ['urlScheme'],
  message: 'must differ from every legacy scheme: two apps claiming one scheme is a coin toss on iOS',
});

export function validateBrand(value) {
  const parsed = BrandSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`brand/brand.json: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`).join('; ')}`);
  }
  for (const path of Object.values(parsed.data.icons)) {
    if (!existsSync(at(path))) throw new Error(`brand/brand.json: icon master does not exist: ${path}`);
  }
  return parsed.data;
}

export const readBrand = () => validateBrand(JSON.parse(read('brand/brand.json')));

// ---------------------------------------------------------------- value writers (by key)
const escapeXml = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function replaceOnce(text, pattern, replacement, label) {
  if (!pattern.test(text)) throw new Error(`brand-sync: ${label} not found`);
  return text.replace(pattern, replacement);
}

const setPlistString = (text, key, value) => replaceOnce(
  text,
  new RegExp(`(<key>${escapeRegex(key)}</key>\\s*<string>)[^<]*(</string>)`),
  (_, open, close) => `${open}${escapeXml(value)}${close}`,
  `Info.plist key ${key}`,
);

const setAndroidString = (text, name, value) => replaceOnce(
  text,
  new RegExp(`(<string name="${escapeRegex(name)}">)[^<]*(</string>)`),
  (_, open, close) => `${open}${escapeXml(value)}${close}`,
  `strings.xml entry ${name}`,
);

const setJsonString = (text, key, value) => replaceOnce(
  text,
  new RegExp(`("${escapeRegex(key)}":\\s*")[^"]*(")`),
  (_, open, close) => `${open}${value}${close}`,
  `JSON key ${key}`,
);

// ---------------------------------------------------------------- targets
const usageText = (name) => ({
  local: `${name} connects to ${name} servers on your local network.`,
  camera: `${name} uses the camera to scan a server's pairing QR code.`,
  microphone: `${name} uses the microphone for voice dictation in the chat composer.`,
});

const electronPackage = (text, brand) => {
  const pkg = JSON.parse(text);
  pkg.description = `Electron desktop runtime for ${brand.displayName}`;
  pkg.author = brand.displayName;
  const build = pkg.build;
  build.appId = brand.appId;
  build.productName = brand.productName;
  build.mac.extendInfo.NSLocalNetworkUsageDescription = `${brand.displayName} needs access to devices and services on your local network.`;
  build.linux.desktop.entry.Name = brand.displayName;
  build.nsis.guid = brand.legacy.nsisGuid;
  build.publish = { provider: 'github', owner: brand.repo.owner, repo: brand.repo.name };
  return `${JSON.stringify(pkg, null, 2)}\n`;
};

const iosApp = (text, { displayName }) => {
  const usage = usageText(displayName);
  let out = setPlistString(text, 'CFBundleDisplayName', displayName);
  out = setPlistString(out, 'NSLocalNetworkUsageDescription', usage.local);
  out = setPlistString(out, 'NSCameraUsageDescription', usage.camera);
  return setPlistString(out, 'NSMicrophoneUsageDescription', usage.microphone);
};

const displayNameOnly = (text, { displayName }) => setPlistString(text, 'CFBundleDisplayName', displayName);

const androidStrings = (text, { displayName }) => setAndroidString(setAndroidString(text, 'app_name', displayName), 'title_activity_main', displayName);

const MARK_BLOCK = /(<!-- brand:mark:start -->)[\s\S]*?(<!-- brand:mark:end -->)/;

const indexHtml = (text, brand) => {
  const { displayName, description, themeColor } = brand;
  let out = replaceOnce(text, /(const defaultAppName = ')[^']*(')/, `$1${displayName}$2`, 'defaultAppName');
  out = replaceOnce(out, /(const defaultShortName = ')[^']*(')/, `$1${displayName}$2`, 'defaultShortName');
  out = replaceOnce(out, /(<meta name="apple-mobile-web-app-title" content=")[^"]*(")/g, `$1${displayName}$2`, 'apple-mobile-web-app-title');
  out = replaceOnce(out, /(<meta name="application-name" content=")[^"]*(")/, `$1${displayName}$2`, 'application-name');
  out = replaceOnce(out, /(<title>)[^<]*( - AI Coding Assistant<\/title>)/, `$1${displayName}$2`, 'title');
  out = replaceOnce(out, /(description: ')[^']*(',\s*id: )/, `$1${description}$2`, 'manifest description');
  out = replaceOnce(out, /(theme_color: ')[^']*(')/, `$1${themeColor}$2`, 'manifest theme_color');
  out = replaceOnce(out, /(<link rel="mask-icon" href="\/favicon\.svg" color=")[^"]*(")/, `$1${themeColor}$2`, 'mask-icon');
  out = replaceOnce(out, /(aria-label=")[^"]*( loading icon")/, `$1${displayName}$2`, 'splash aria-label');
  const mark = brandMarkMarkup(read(brand.icons.app), 'splash-');
  return replaceOnce(out, MARK_BLOCK, (_, start, end) => `${start}\n            ${mark}\n            ${end}`, 'brand:mark block');
};

const webManifest = (text, { displayName, description, themeColor }) => {
  let out = setJsonString(text, 'name', displayName);
  out = setJsonString(out, 'short_name', displayName);
  out = setJsonString(out, 'description', description);
  return setJsonString(out, 'theme_color', themeColor);
};

// The UI, the desktop splash and the server draw the mark from a generated module instead of carrying
// geometry in a component or a template.
const markModule = (typed) => (_, brand) => {
  const body = brandMarkMarkup(read(brand.icons.app), '@@').replaceAll('@@', '${idPrefix}');
  return `// Generated by scripts/brand-sync.mjs from ${brand.icons.app}. Do not edit: change the master and run \`bun run brand:sync\`.
export const BRAND_MARK_VIEW_BOX = '0 0 1024 1024';

/** Inner markup of the mark; \`idPrefix\` keeps gradient and mask ids unique per inlined copy. */
export const brandMarkBody = (idPrefix${typed ? ': string' : ''})${typed ? ': string' : ''} =>
  \`${body}\`;
`;
};

export const TARGETS = [
  { file: 'packages/web/server/lib/brand.json', build: (_, __, raw) => raw },
  { file: 'packages/ui/src/lib/brand.json', build: (_, __, raw) => raw },
  { file: 'packages/ui/src/lib/brandMark.ts', build: markModule(true) },
  { file: 'packages/web/server/lib/brand-mark.js', build: markModule(false) },
  { file: 'packages/electron/package.json', build: electronPackage },
  { file: 'packages/mobile/ios/App/App/Info.plist', build: iosApp },
  { file: 'packages/mobile/ios/App/OpenChamberWidget/Info.plist', build: displayNameOnly },
  { file: 'packages/mobile/ios/App/OpenChamberNotificationService/Info.plist', build: displayNameOnly },
  { file: 'packages/mobile/android/app/src/main/res/values/strings.xml', build: androidStrings },
  { file: 'packages/web/index.html', build: indexHtml },
  { file: 'packages/web/public/site.webmanifest', build: webManifest },
];

/** The files whose content differs from what brand.json says they must hold. */
export function brandDrift() {
  const raw = read('brand/brand.json');
  const brand = validateBrand(JSON.parse(raw));
  const stale = [];
  for (const target of TARGETS) {
    const current = existsSync(at(target.file)) ? read(target.file) : '';
    const wanted = target.build(current, brand, raw);
    if (wanted !== current) stale.push({ file: target.file, wanted });
  }
  return stale;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes('--check');
  const stale = brandDrift();
  if (check) {
    if (stale.length > 0) {
      console.error(`brand-sync: ${stale.length} file(s) differ from brand/brand.json:\n${stale.map((s) => `  ${s.file}`).join('\n')}\nRun: bun run brand:sync`);
      process.exit(1);
    }
    console.log('brand-sync: every target matches brand/brand.json');
  } else {
    for (const { file, wanted } of stale) writeFileSync(at(file), wanted);
    console.log(`brand-sync: wrote ${stale.length} file(s)${stale.length ? `:\n${stale.map((s) => `  ${s.file}`).join('\n')}` : ''}`);
  }
}

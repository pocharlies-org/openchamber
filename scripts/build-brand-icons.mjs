#!/usr/bin/env node
// Rasterizes the brand's SVG masters (brand/icons, named by brand/brand.json `icons`) into every platform file.
// Nothing here draws brand geometry: change the icon by replacing a master, run this, commit the files and
// brand/icons/icons.lock. Run from the repo root after `bun install`:
//
//   node scripts/build-brand-icons.mjs              write the portable outputs and the lock
//   node scripts/build-brand-icons.mjs --lock-check write nothing, exit 1 if a master or `icons` changed
//                                                   since the lock was written (CI and brand.test.mjs)
//   node scripts/build-brand-icons.mjs --mac        also rebuild the macOS 26 icon (AppIcon.icon layers and
//                                                   Assets.car), which needs `actool`: run it on the MacBook
//                                                   or a macos-26 runner, never on the x86
//
// Which master serves which size is the one table below: `app` (full-bleed, from 48 px up), `small` (the
// optical glyph, 16 to 32 px), `macos` (the squircle for .icns and desktop PNGs), `mono` (one ink: tray and
// Android notification icon).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, readBrand } from './brand-sync.mjs';
import { brandMarkMarkup } from './lib/brand-mark.mjs';

const LOCK = 'brand/icons/icons.lock';
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

/** What the lock must say for the masters and `icons` fields as they are now. */
export function expectedLock(brand) {
  const sha = {};
  for (const [key, path] of Object.entries(brand.icons)) sha[key] = sha256(readFileSync(join(ROOT, path)));
  return { icons: brand.icons, sha256: sha };
}

/** Empty when the lock matches the masters; otherwise what differs. */
export function lockProblems(brand) {
  if (!existsSync(join(ROOT, LOCK))) return [`${LOCK} is missing: run bun run brand:icons`];
  const lock = JSON.parse(readFileSync(join(ROOT, LOCK), 'utf8'));
  const want = expectedLock(brand);
  const problems = [];
  for (const key of Object.keys(want.icons)) {
    if (lock.icons?.[key] !== want.icons[key]) problems.push(`icons.${key} changed (${lock.icons?.[key]} -> ${want.icons[key]})`);
    else if (lock.sha256?.[key] !== want.sha256[key]) problems.push(`${want.icons[key]} changed since the lock was written`);
  }
  return problems;
}

const cli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (cli && process.argv.includes('--lock-check')) {
  const problems = lockProblems(readBrand());
  if (problems.length > 0) {
    console.error(`brand icons: the masters differ from ${LOCK}:\n${problems.map((p) => `  ${p}`).join('\n')}\nRun: bun run brand:icons`);
    process.exit(1);
  }
  console.log(`brand icons: ${LOCK} matches the masters`);
} else if (cli) {
  await build(readBrand(), process.argv.includes('--mac'));
}

async function build(brand, mac) {
  const require = createRequire(import.meta.url);
  const sharp = require('sharp');
  const master = (key) => readFileSync(join(ROOT, brand.icons[key]));
  const stops = (svg, id) => [...new RegExp(`<linearGradient id="${id}"[^>]*>([\\s\\S]*?)</linearGradient>`).exec(svg)[1].matchAll(/stop-color="(#[0-9a-f]{6})"/gi)].map((m) => m[1]);

  // Background of the app icon (its own gradient), and the light counterpart the splash screens use.
  const [DARK_TOP, DARK_BOTTOM] = stops(master('app').toString(), 'bgr');
  const LIGHT_BG = '#f4f3ef';

  const markSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">${brandMarkMarkup(master('app').toString(), 'm-')}</svg>`);
  const sources = { app: master('app'), macos: master('macos'), small: master('small'), mono: master('mono'), mark: markSvg };

  // The vector master rasterized at its own size (not resampled from 1024), so small sizes stay crisp.
  const raster = (key, size) => sharp(sources[key], { density: Math.max(1, (72 * size) / 1024) }).resize(size, size);
  const out = (rel) => { const path = join(ROOT, rel); mkdirSync(dirname(path), { recursive: true }); return path; };
  const png = (pipeline, rel, { flatten } = {}) => {
    const base = flatten ? pipeline.flatten({ background: flatten }).removeAlpha() : pipeline;
    return base.png({ compressionLevel: 9 }).toFile(out(rel));
  };
  const pngBuffer = (pipeline) => pipeline.png({ compressionLevel: 9 }).toBuffer();
  const copySvg = (key, rel) => writeFileSync(out(rel), sources[key]);
  // Optical choice: the 16-32 px glyph below 48 px, the full master from there up.
  const forSize = (size) => (size <= 32 ? 'small' : 'app');

  // Windows ICO: BMP entries below 128 px, PNG from there up.
  async function bmpEntry(pipeline, size) {
    const { data } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const head = Buffer.alloc(40);
    head.writeUInt32LE(40, 0); head.writeInt32LE(size, 4); head.writeInt32LE(size * 2, 8); head.writeUInt16LE(1, 12); head.writeUInt16LE(32, 14);
    const px = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4, o = ((size - 1 - y) * size + x) * 4;
      px[o] = data[i + 2]; px[o + 1] = data[i + 1]; px[o + 2] = data[i]; px[o + 3] = data[i + 3];
    }
    head.writeUInt32LE(px.length, 20);
    return Buffer.concat([head, px, Buffer.alloc(Math.ceil(size / 32) * 4 * size)]);
  }
  async function ico(rel, sizes) {
    const images = [];
    for (const size of sizes) {
      const pipeline = raster(forSize(size), size);
      images.push({ size, buf: size >= 128 ? await pngBuffer(pipeline) : await bmpEntry(pipeline, size) });
    }
    const dir = Buffer.alloc(6 + 16 * images.length);
    dir.writeUInt16LE(1, 2); dir.writeUInt16LE(images.length, 4);
    let offset = dir.length;
    images.forEach(({ size, buf }, i) => {
      const base = 6 + i * 16;
      dir.writeUInt8(size >= 256 ? 0 : size, base); dir.writeUInt8(size >= 256 ? 0 : size, base + 1);
      dir.writeUInt16LE(1, base + 4); dir.writeUInt16LE(32, base + 6); dir.writeUInt32LE(buf.length, base + 8); dir.writeUInt32LE(offset, base + 12);
      offset += buf.length;
    });
    writeFileSync(out(rel), Buffer.concat([dir, ...images.map((image) => image.buf)]));
  }
  async function icns(rel, make) {
    const types = [['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024], ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512]];
    const parts = [];
    for (const [type, size] of types) {
      const data = await pngBuffer(make(size));
      const header = Buffer.alloc(8); header.write(type, 0, 'ascii'); header.writeUInt32BE(data.length + 8, 4);
      parts.push(header, data);
    }
    const body = Buffer.concat(parts);
    const header = Buffer.alloc(8); header.write('icns', 0, 'ascii'); header.writeUInt32BE(body.length + 8, 4);
    writeFileSync(out(rel), Buffer.concat([header, body]));
  }

  // The mark centred on a flat colour: launch images.
  const onColor = (width, height, color, share = 0.3) => {
    const box = Math.round(Math.min(width, height) * share);
    return pngBuffer(raster('mark', box)).then((input) => sharp({ create: { width, height, channels: 4, background: color } }).composite([{ input }]));
  };
  // Solid-colour or gradient plates for the Android and Capacitor backgrounds.
  const plate = (size, top, bottom = top) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><defs><linearGradient id="p" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient></defs><rect width="${size}" height="${size}" fill="url(#p)"/></svg>`));
  const round = (pipeline, size) => pipeline.composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}"/></svg>`), blend: 'dest-in' }]);
  // Maskable PWA icons keep their art inside the central 80 % circle: the master shrinks and its own edge colours fill the rest.
  const maskable = async (size) => {
    const inner = Math.round(size * 0.9);
    const pad = Math.floor((size - inner) / 2);
    return sharp(await pngBuffer(raster('app', inner))).extend({ top: pad, bottom: size - inner - pad, left: pad, right: size - inner - pad, extendWith: 'copy' });
  };

  const E = 'packages/electron/resources/icons';
  const W = 'packages/web/public';
  const M = 'packages/mobile';
  const AND = `${M}/android/app/src/main/res`;
  const jobs = [];

  // Electron: macOS .icns, Windows .ico, Linux svg/png, dev build (the same icon in greys).
  jobs.push(icns(`${E}/icon.icns`, (size) => raster('macos', size)));
  jobs.push(icns(`${E}/dev-icon.icns`, (size) => raster('macos', size).grayscale()));
  jobs.push(ico(`${E}/icon.ico`, [16, 24, 32, 48, 64, 128, 256]));
  copySvg('macos', `${E}/app-icon.svg`);
  copySvg('small', `${E}/icon-win.svg`);
  jobs.push(png(raster('macos', 1024), `${E}/icon.png`));
  jobs.push(png(raster('macos', 512), `${E}/app-icon.png`));
  jobs.push(png(raster('macos', 1024).grayscale(), `${E}/dev-icon.png`));

  // macOS menu bar (template images: only the alpha counts). Calm = dimmer, unread = full ink, and the busy
  // "breathing" eases between the two; the glyph itself is the designer's mono master.
  const TRAY_CALM_ALPHA = 0.55;
  const TRAY_BREATH_FRAMES = 16; // main.mjs TRAY_BREATH_FRAME_COUNT
  const trayFrame = async (size, alpha, rel) => {
    const { data, info } = await raster('mono', size).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let i = 3; i < data.length; i += 4) data[i] = Math.round(data[i] * alpha);
    return sharp(data, { raw: info }).png({ compressionLevel: 9 }).toFile(out(rel));
  };
  const ease = (t) => t * t * (3 - 2 * t);
  const TRAY = `${E}/tray`;
  for (const [suffix, size] of [['', 18], ['@2x', 36]]) {
    jobs.push(trayFrame(size, TRAY_CALM_ALPHA, `${TRAY}/trayTemplate-idle${suffix}.png`));
    jobs.push(trayFrame(size, 1, `${TRAY}/trayTemplate-unseen${suffix}.png`));
    for (let i = 0; i < TRAY_BREATH_FRAMES; i++) {
      const alpha = TRAY_CALM_ALPHA + (1 - TRAY_CALM_ALPHA) * ease(i / (TRAY_BREATH_FRAMES - 1));
      jobs.push(trayFrame(size, alpha, `${TRAY}/trayTemplate-breath-${String(i).padStart(2, '0')}${suffix}.png`));
    }
  }

  // Web: favicon, apple-touch, PWA, transparent marks.
  copySvg('small', `${W}/favicon.svg`);
  jobs.push(png(raster('small', 16), `${W}/favicon-16.png`));
  jobs.push(png(raster('small', 32), `${W}/favicon-32.png`));
  jobs.push(png(raster('app', 64), `${W}/favicon.png`));
  copySvg('app', `${W}/apple-touch-icon.svg`);
  for (const size of [120, 152, 167, 180]) jobs.push(png(raster('app', size), `${W}/apple-touch-icon-${size}x${size}.png`));
  jobs.push(png(raster('app', 180), `${W}/apple-touch-icon.png`));
  for (const size of [192, 512]) {
    jobs.push(png(raster('app', size), `${W}/pwa-${size}.png`));
    jobs.push(maskable(size).then((pipeline) => png(pipeline, `${W}/pwa-maskable-${size}.png`)));
  }
  for (const theme of ['light', 'dark']) {
    jobs.push(png(raster('mark', 192), `${W}/logo-${theme}-192x192.png`));
    copySvg('mark', `${W}/logo-${theme}-512x512.svg`);
  }

  // iOS: AppIcon 1024 opaque; launch images light and dark (Splash.imageset).
  jobs.push(png(raster('app', 1024), `${M}/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png`, { flatten: DARK_BOTTOM }));
  for (const n of ['', '-1', '-2']) {
    jobs.push(onColor(2732, 2732, LIGHT_BG).then((p) => png(p, `${M}/ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732${n}.png`, { flatten: LIGHT_BG })));
    jobs.push(onColor(2732, 2732, DARK_BOTTOM).then((p) => png(p, `${M}/ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732-dark${n}.png`, { flatten: DARK_BOTTOM })));
  }
  writeFileSync(out(`${M}/ios/App/App/Assets.xcassets/Splash.imageset/Contents.json`), `${JSON.stringify({
    images: [['-2', '1x'], ['-1', '2x'], ['', '3x']].flatMap(([n, scale]) => [
      { idiom: 'universal', filename: `splash-2732x2732${n}.png`, scale },
      { appearances: [{ appearance: 'luminosity', value: 'dark' }], idiom: 'universal', filename: `splash-2732x2732-dark${n}.png`, scale },
    ]),
    info: { version: 1, author: 'xcode' },
  }, null, 2)}\n`);

  // Capacitor asset sources, Android launcher, notification icon and splash.
  jobs.push(png(raster('app', 1024), `${M}/assets/icon-only.png`));
  jobs.push(png(raster('mark', 1024), `${M}/assets/icon-foreground.png`));
  jobs.push(png(plate(1024, DARK_TOP, DARK_BOTTOM), `${M}/assets/icon-background.png`));
  const densities = { ldpi: 36, mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
  for (const [density, size] of Object.entries(densities)) {
    jobs.push(png(raster('app', size), `${AND}/mipmap-${density}/ic_launcher.png`));
    jobs.push(png(round(raster('app', size), size), `${AND}/mipmap-${density}/ic_launcher_round.png`));
    // adaptive icon: mipmap-anydpi-v26 insets this foreground 16.7 %, so it is drawn like a legacy icon
    jobs.push(png(raster('mark', size), `${AND}/mipmap-${density}/ic_launcher_foreground.png`));
    jobs.push(png(plate(size, DARK_BOTTOM), `${AND}/mipmap-${density}/ic_launcher_background.png`));
  }
  for (const [density, size] of Object.entries({ mdpi: 24, hdpi: 36, xhdpi: 48, xxhdpi: 72, xxxhdpi: 96 })) {
    jobs.push(png(raster('mono', size), `${AND}/drawable-${density}/ic_stat_notify.png`));
  }
  const splashes = { 'drawable': [480, 320], 'drawable-land-mdpi': [480, 320], 'drawable-land-hdpi': [800, 480], 'drawable-land-xhdpi': [1280, 720], 'drawable-land-xxhdpi': [1600, 960], 'drawable-land-xxxhdpi': [1920, 1280], 'drawable-port-mdpi': [320, 480], 'drawable-port-hdpi': [480, 800], 'drawable-port-xhdpi': [720, 1280], 'drawable-port-xxhdpi': [960, 1600], 'drawable-port-xxxhdpi': [1280, 1920] };
  writeFileSync(out(`${AND}/values/ic_launcher_background.xml`), `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${DARK_BOTTOM.toUpperCase()}</color>\n</resources>\n`);
  for (const [dir, [width, height]] of Object.entries(splashes)) {
    jobs.push(onColor(width, height, DARK_BOTTOM, 0.35).then((p) => png(p, `${AND}/${dir}/splash.png`, { flatten: DARK_BOTTOM })));
  }

  await Promise.all(jobs);
  writeFileSync(out(LOCK), `${JSON.stringify(expectedLock(brand), null, 2)}\n`);

  if (mac) {
    // Icon Composer layers (macOS 26): the mark on a transparent square; actool compiles them into Assets.car.
    const layers = ['app-icon-glyph-dark 4.png', 'app-icon-glyph-light 2.png'];
    await Promise.all(layers.map((name) => png(raster('mark', 1024), `${E}/AppIcon.icon/Assets/${name}`)));
    execFileSync(process.execPath, [join(ROOT, 'packages/electron/scripts/generate-macos-icon-assets.cjs')], { stdio: 'inherit' });
  }
  console.log(`${brand.displayName} icons: ${jobs.length} raster jobs, ${LOCK} written${mac ? ', AppIcon.icon and Assets.car rebuilt' : ' (Assets.car and AppIcon.icon wait for --mac)'}`);
}

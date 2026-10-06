#!/usr/bin/env node
// AgentChamber icon set (DGX-514). One geometry, every platform file.
// Run from the repo root after `bun install`:  node docs/brand/agentchamber/build-icons.mjs
// Colours are the values of the company design-token template
// (pocharlies-org/dgx-infra k8s/apps/chat/tools/design_tokens_template.dc.html).
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const BRAND = join(ROOT, 'docs/brand/agentchamber');

const DARK = { bg: '#101012', surface2: '#26262c', text: '#f2f2f2', accent: '#ff5a1f' };
const LIGHT = { bg: '#f4f3ef', surface2: '#eceae4', text: '#17171a', accent: '#ee4f0c' };
const C30 = Math.cos(Math.PI / 6);
const r = (n) => Math.round(n * 100) / 100;
const pts = (...p) => p.map(([x, y]) => `${r(x)} ${r(y)}`).join(' L');

// Isometric cube centred on (cx, cy) with edge e: open top face, an accent rhombus inside it.
function cube({ cx, cy, e, sw, stroke, left, right, top = 'none', accent, glow = false, outline = null, k = 0.5, id = 'g' }) {
  const T = [cx, cy - e], L = [cx - e * C30, cy - e / 2], R = [cx + e * C30, cy - e / 2], F = [cx, cy];
  const BL = [cx - e * C30, cy + e / 2], BR = [cx + e * C30, cy + e / 2], B = [cx, cy + e];
  const tc = [cx, cy - e / 2];
  const D = [[tc[0], tc[1] - (k * e) / 2], [tc[0] - k * e * C30, tc[1]], [tc[0], tc[1] + (k * e) / 2], [tc[0] + k * e * C30, tc[1]]];
  const j = `stroke="${stroke}" stroke-width="${r(sw)}" stroke-linejoin="round"`;
  const o = [];
  if (outline) {
    const oe = e + sw * 1.6;
    o.push(`<path d="M${pts([cx, cy - oe], [cx + oe * C30, cy - oe / 2], [cx + oe * C30, cy + oe / 2], [cx, cy + oe], [cx - oe * C30, cy + oe / 2], [cx - oe * C30, cy - oe / 2])} Z" fill="${outline}"/>`);
  }
  o.push(`<path d="M${pts(F, L, BL, B)} Z" ${left} ${j}/>`);
  o.push(`<path d="M${pts(F, R, BR, B)} Z" ${right} ${j}/>`);
  if (glow) {
    o.push(`<defs><radialGradient id="${id}" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="${accent}" stop-opacity="0.55"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></radialGradient><clipPath id="${id}c"><path d="M${pts(T, L, F, R)} Z"/></clipPath></defs>`);
    o.push(`<ellipse clip-path="url(#${id}c)" cx="${r(tc[0])}" cy="${r(tc[1])}" rx="${r(e * C30)}" ry="${r(e / 2)}" fill="url(#${id})"/>`);
  }
  o.push(`<path d="M${pts(T, L, F, R)} Z" fill="${top}" ${j}/>`);
  o.push(`<path d="M${pts(...D)} Z" fill="${accent}"/>`);
  return o.join('');
}

const svg = (w, h, body, extra = '') => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"${extra}>${body}</svg>`;
const swFor = (s) => 0.9 + 0.02 * s; // optical stroke: thicker relative weight at small sizes
const kFor = (s) => (s <= 32 ? 0.6 : 0.5); // bigger rhombus where pixels are scarce

// macOS / Linux: dark squircle on a 1024 grid (824 body, 100 margin, rx 185), like the current app-icon.
function tile(s, theme = DARK) {
  const u = s / 1024, light = theme === LIGHT;
  const ink = light ? theme.text : '#ffffff';
  const body = [
    `<defs><linearGradient id="bgr" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${light ? '#ffffff' : theme.surface2}"/><stop offset="1" stop-color="${light ? theme.surface2 : theme.bg}"/></linearGradient>`,
    `<filter id="sh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="${r(12 * u)}" stdDeviation="${r(14 * u)}" flood-color="#000" flood-opacity="0.45"/></filter></defs>`,
    `<rect x="${r(100 * u)}" y="${r(100 * u)}" width="${r(824 * u)}" height="${r(824 * u)}" rx="${r(185 * u)}" fill="url(#bgr)"${s >= 64 ? ' filter="url(#sh)"' : ''}/>`,
    cube({ cx: s / 2, cy: s / 2, e: (s <= 32 ? 330 : 275) * u, sw: Math.max(swFor(s) * (s <= 32 ? 1 : 0.8), 18 * u), stroke: ink, left: `fill="${ink}" fill-opacity="${light ? 0.1 : 0.16}"`, right: `fill="${ink}" fill-opacity="${light ? 0.22 : 0.32}"`, accent: theme.accent, glow: s >= 64, k: kFor(s) }),
  ].join('');
  return svg(s, s, body);
}

// iOS, PWA, apple-touch, Android legacy: full bleed, opaque, glyph inside the 80 % safe circle.
function bleed(s, e = 0.29) {
  const body = [
    `<defs><linearGradient id="bgr" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${DARK.surface2}"/><stop offset="1" stop-color="${DARK.bg}"/></linearGradient></defs>`,
    `<rect width="${s}" height="${s}" fill="url(#bgr)"/>`,
    cube({ cx: s / 2, cy: s / 2, e: e * s, sw: Math.max(swFor(s) * 0.8, 0.018 * s), stroke: '#ffffff', left: 'fill="#ffffff" fill-opacity="0.16"', right: 'fill="#ffffff" fill-opacity="0.32"', accent: DARK.accent, glow: s >= 64, k: kFor(s) }),
  ].join('');
  return svg(s, s, body);
}

// Windows: transparent, cube to the edges, solid faces, dark rim so it reads on light and dark taskbars.
function win(s) {
  return svg(s, s, cube({ cx: s / 2, cy: s / 2, e: s * 0.45, sw: swFor(s) * (s <= 32 ? 0.9 : 0.75), stroke: '#ffffff', left: 'fill="#3a3a41"', right: 'fill="#55555d"', top: DARK.surface2, accent: DARK.accent, outline: '#000000', k: kFor(s) }));
}

// Transparent mark on a given ink (UI logo, light/dark logos, glyph layers, splash).
function mark(s, ink, accent, e = 0.45, faces = [0.16, 0.32]) {
  return svg(s, s, cube({ cx: s / 2, cy: s / 2, e: s * e, sw: swFor(s) * 0.85, stroke: ink, left: `fill="${ink}" fill-opacity="${faces[0]}"`, right: `fill="${ink}" fill-opacity="${faces[1]}"`, accent, k: kFor(s) }));
}

// Favicon SVG: monochrome currentColor that follows prefers-color-scheme, plus the accent rhombus.
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
  <style>:root{color:${LIGHT.text}}.a{fill:${LIGHT.accent}}@media (prefers-color-scheme: dark){:root{color:${DARK.text}}.a{fill:${DARK.accent}}}</style>
  <!-- AgentChamber: the chamber (isometric cube, open top) with the agent (accent rhombus) inside -->
  ${cube({ cx: 16, cy: 16, e: 14, sw: 2, stroke: 'currentColor', left: 'fill="currentColor" fill-opacity="0.25"', right: 'fill="currentColor" fill-opacity="0.45"', accent: 'X', k: 0.6 }).replace('fill="X"', 'class="a"')}
</svg>
`;

function splash(w, h, theme) {
  const s = Math.min(w, h) * 0.16; // glyph box; the iOS crop keeps the centre 1200 px of 2732
  const ink = theme === DARK ? '#ffffff' : theme.text;
  const body = `<rect width="${w}" height="${h}" fill="${theme.bg}"/>` + cube({ cx: w / 2, cy: h / 2, e: s / 2, sw: s * 0.035, stroke: ink, left: `fill="${ink}" fill-opacity="0.12"`, right: `fill="${ink}" fill-opacity="0.24"`, accent: theme.accent, k: 0.5 });
  return svg(w, h, body);
}

// ---------------------------------------------------------------- writers
const out = (rel) => { const p = join(ROOT, rel); mkdirSync(dirname(p), { recursive: true }); return p; };
const png = (svgText, rel, { flatten } = {}) => {
  let img = sharp(Buffer.from(svgText), { density: 72 });
  if (flatten) img = img.flatten({ background: flatten }).removeAlpha();
  return img.png({ compressionLevel: 9 }).toFile(out(rel));
};
const pngBuf = (svgText) => sharp(Buffer.from(svgText), { density: 72 }).png({ compressionLevel: 9 }).toBuffer();

async function bmpEntry(svgText, s) { // 32-bit BGRA DIB + empty AND mask, bottom-up
  const { data } = await sharp(Buffer.from(svgText), { density: 72 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const head = Buffer.alloc(40);
  head.writeUInt32LE(40, 0); head.writeInt32LE(s, 4); head.writeInt32LE(s * 2, 8); head.writeUInt16LE(1, 12); head.writeUInt16LE(32, 14);
  const px = Buffer.alloc(s * s * 4);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const i = (y * s + x) * 4, o = ((s - 1 - y) * s + x) * 4;
    px[o] = data[i + 2]; px[o + 1] = data[i + 1]; px[o + 2] = data[i]; px[o + 3] = data[i + 3];
  }
  head.writeUInt32LE(px.length, 20);
  return Buffer.concat([head, px, Buffer.alloc(Math.ceil(s / 32) * 4 * s)]);
}

async function ico(rel, sizes, make) {
  const imgs = [];
  for (const s of sizes) imgs.push({ s, buf: s >= 128 ? await pngBuf(make(s)) : await bmpEntry(make(s), s) });
  const dir = Buffer.alloc(6 + 16 * imgs.length);
  dir.writeUInt16LE(1, 2); dir.writeUInt16LE(imgs.length, 4);
  let off = dir.length;
  imgs.forEach(({ s, buf }, i) => {
    const b = 6 + i * 16;
    dir.writeUInt8(s >= 256 ? 0 : s, b); dir.writeUInt8(s >= 256 ? 0 : s, b + 1);
    dir.writeUInt16LE(1, b + 4); dir.writeUInt16LE(32, b + 6); dir.writeUInt32LE(buf.length, b + 8); dir.writeUInt32LE(off, b + 12);
    off += buf.length;
  });
  writeFileSync(out(rel), Buffer.concat([dir, ...imgs.map((x) => x.buf)]));
}

async function icns(rel, make) {
  const types = [['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024], ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512]];
  const parts = [];
  for (const [t, s] of types) {
    const data = await pngBuf(make(s));
    const h = Buffer.alloc(8); h.write(t, 0, 'ascii'); h.writeUInt32BE(data.length + 8, 4);
    parts.push(h, data);
  }
  const body = Buffer.concat(parts);
  const h = Buffer.alloc(8); h.write('icns', 0, 'ascii'); h.writeUInt32BE(body.length + 8, 4);
  writeFileSync(out(rel), Buffer.concat([h, body]));
}

// ---------------------------------------------------------------- build
const E = 'packages/electron/resources/icons';
const W = 'packages/web/public';
const M = 'packages/mobile';
const AND = `${M}/android/app/src/main/res`;
const jobs = [];

// Masters, kept next to this script.
writeFileSync(join(BRAND, 'agentchamber-app.svg'), tile(1024) + '\n');
writeFileSync(join(BRAND, 'agentchamber-app-light.svg'), tile(1024, LIGHT) + '\n');
writeFileSync(join(BRAND, 'agentchamber-ios.svg'), bleed(1024) + '\n');
writeFileSync(join(BRAND, 'agentchamber-win.svg'), win(1024) + '\n');
writeFileSync(join(BRAND, 'agentchamber-mark.svg'), FAVICON_SVG);

// Electron: macOS .icns, Windows .ico, Linux svg/png, dev build (light tile), macOS 26 Icon Composer layers.
jobs.push(icns(`${E}/icon.icns`, (s) => tile(s)));
jobs.push(icns(`${E}/dev-icon.icns`, (s) => tile(s, LIGHT)));
jobs.push(ico(`${E}/icon.ico`, [16, 24, 32, 48, 64, 128, 256], win));
writeFileSync(out(`${E}/app-icon.svg`), tile(1024) + '\n');
writeFileSync(out(`${E}/icon-win.svg`), win(1024) + '\n');
jobs.push(png(tile(1024), `${E}/icon.png`));
jobs.push(png(tile(512), `${E}/app-icon.png`));
jobs.push(png(tile(1024, LIGHT), `${E}/dev-icon.png`));
const glyph = (ink, faces) => svg(1024, 1024, cube({ cx: 512, cy: 576, e: 440, sw: 22, stroke: ink, left: `fill="${ink}" fill-opacity="${faces[0]}"`, right: `fill="${ink}" fill-opacity="${faces[1]}"`, accent: DARK.accent, k: 0.5 }));
jobs.push(png(glyph('#ffffff', [0.18, 0.36]), `${E}/AppIcon.icon/Assets/app-icon-glyph-dark 4.png`));
jobs.push(png(glyph(LIGHT.text, [0.12, 0.26]), `${E}/AppIcon.icon/Assets/app-icon-glyph-light 2.png`));

// Web: favicon (svg + png), apple-touch, PWA, light/dark logos.
writeFileSync(out(`${W}/favicon.svg`), FAVICON_SVG);
jobs.push(png(tile(16), `${W}/favicon-16.png`));
jobs.push(png(tile(32), `${W}/favicon-32.png`));
jobs.push(png(tile(64), `${W}/favicon.png`));
writeFileSync(out(`${W}/apple-touch-icon.svg`), bleed(180) + '\n');
for (const s of [120, 152, 167, 180]) jobs.push(png(bleed(s), `${W}/apple-touch-icon-${s}x${s}.png`));
jobs.push(png(bleed(180), `${W}/apple-touch-icon.png`));
for (const s of [192, 512]) {
  jobs.push(png(bleed(s), `${W}/pwa-${s}.png`));
  jobs.push(png(bleed(s, 0.27), `${W}/pwa-maskable-${s}.png`));
}
jobs.push(png(mark(192, LIGHT.text, LIGHT.accent), `${W}/logo-light-192x192.png`));
jobs.push(png(mark(192, '#ffffff', DARK.accent), `${W}/logo-dark-192x192.png`));
writeFileSync(out(`${W}/logo-light-512x512.svg`), mark(512, LIGHT.text, LIGHT.accent) + '\n');
writeFileSync(out(`${W}/logo-dark-512x512.svg`), mark(512, '#ffffff', DARK.accent) + '\n');

// iOS: AppIcon 1024 opaque; launch image light + dark (Splash.imageset).
jobs.push(png(bleed(1024), `${M}/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png`, { flatten: DARK.bg }));
for (const n of ['', '-1', '-2']) {
  jobs.push(png(splash(2732, 2732, LIGHT), `${M}/ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732${n}.png`, { flatten: LIGHT.bg }));
  jobs.push(png(splash(2732, 2732, DARK), `${M}/ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732-dark${n}.png`, { flatten: DARK.bg }));
}

// Capacitor asset sources + Android launcher and splash.
jobs.push(png(bleed(1024), `${M}/assets/icon-only.png`));
jobs.push(png(svg(1024, 1024, cube({ cx: 512, cy: 512, e: 270, sw: 20, stroke: '#ffffff', left: 'fill="#ffffff" fill-opacity="0.16"', right: 'fill="#ffffff" fill-opacity="0.32"', accent: DARK.accent, glow: true })), `${M}/assets/icon-foreground.png`));
jobs.push(png(svg(1024, 1024, `<defs><linearGradient id="b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${DARK.surface2}"/><stop offset="1" stop-color="${DARK.bg}"/></linearGradient></defs><rect width="1024" height="1024" fill="url(#b)"/>`), `${M}/assets/icon-background.png`));
const dens = { ldpi: 36, mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [d, s] of Object.entries(dens)) {
  jobs.push(png(bleed(s), `${AND}/mipmap-${d}/ic_launcher.png`));
  jobs.push(png(svg(s, s, `<clipPath id="c"><circle cx="${s / 2}" cy="${s / 2}" r="${s / 2}"/></clipPath><g clip-path="url(#c)">${bleed(s).replace(/^<svg[^>]*>|<\/svg>$/g, '')}</g>`), `${AND}/mipmap-${d}/ic_launcher_round.png`));
  // adaptive icon: mipmap-anydpi-v26 insets this foreground 16.7 %, so it is drawn like a legacy icon
  jobs.push(png(svg(s, s, cube({ cx: s / 2, cy: s / 2, e: s * 0.38, sw: swFor(s) * 0.8, stroke: '#ffffff', left: 'fill="#ffffff" fill-opacity="0.16"', right: 'fill="#ffffff" fill-opacity="0.32"', accent: DARK.accent, k: kFor(s) })), `${AND}/mipmap-${d}/ic_launcher_foreground.png`));
  jobs.push(png(svg(s, s, `<rect width="${s}" height="${s}" fill="${DARK.bg}"/>`), `${AND}/mipmap-${d}/ic_launcher_background.png`));
}
const splashes = { 'drawable': [480, 320], 'drawable-land-mdpi': [480, 320], 'drawable-land-hdpi': [800, 480], 'drawable-land-xhdpi': [1280, 720], 'drawable-land-xxhdpi': [1600, 960], 'drawable-land-xxxhdpi': [1920, 1280], 'drawable-port-mdpi': [320, 480], 'drawable-port-hdpi': [480, 800], 'drawable-port-xhdpi': [720, 1280], 'drawable-port-xxhdpi': [960, 1600], 'drawable-port-xxxhdpi': [1280, 1920] };
writeFileSync(out(`${AND}/values/ic_launcher_background.xml`), `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${DARK.bg.toUpperCase()}</color>\n</resources>\n`);
writeFileSync(out(`${M}/ios/App/App/Assets.xcassets/Splash.imageset/Contents.json`), JSON.stringify({
  images: [['-2', '1x'], ['-1', '2x'], ['', '3x']].flatMap(([n, scale]) => [
    { idiom: 'universal', filename: `splash-2732x2732${n}.png`, scale },
    { appearances: [{ appearance: 'luminosity', value: 'dark' }], idiom: 'universal', filename: `splash-2732x2732-dark${n}.png`, scale },
  ]),
  info: { version: 1, author: 'xcode' },
}, null, 2) + '\n');
for (const [d, [w, h]] of Object.entries(splashes)) jobs.push(png(splash(w, h, DARK), `${AND}/${d}/splash.png`, { flatten: DARK.bg }));

await Promise.all(jobs);
console.log(`AgentChamber icons: ${jobs.length} raster jobs + svg masters written`);

// Reads the designer's SVG masters (brand/icons/*.svg) and derives the inline pieces that cannot be
// rasters: the full-colour mark (the artwork without its tile) and the one-ink sprite symbol.
// The geometry always comes from the master; nothing here draws.

const BG_RECT = /\s*<rect width="1024" height="1024"[^>]*fill="url\(#bgr\)"\/>/;
const GLOW = /\s*<circle [^>]*fill="url\(#glow\)"\/>/;
const TILE_ONLY_IDS = new Set(['bgr', 'glow', 'sh']);

const prefixIds = (markup, prefix) => {
  const ids = [...markup.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  let out = markup;
  for (const id of ids) {
    out = out.replaceAll(`id="${id}"`, `id="${prefix}${id}"`).replaceAll(`url(#${id})`, `url(#${prefix}${id})`);
  }
  return out;
};

/**
 * The full-colour mark of the app icon, without the background tile and the glow behind it.
 * `idPrefix` keeps ids unique when the mark is inlined more than once in a document
 * (a gradient inside a hidden copy does not paint for the visible one).
 */
export function brandMarkMarkup(iconSvg, idPrefix) {
  const defs = [...iconSvg.matchAll(/<(linearGradient|radialGradient|filter)\b[\s\S]*?<\/\1>/g)]
    .map((m) => m[0])
    .filter((def) => !TILE_ONLY_IDS.has(/\bid="([^"]+)"/.exec(def)?.[1]));
  const body = iconSvg.slice(iconSvg.indexOf('</defs>') + '</defs>'.length, iconSvg.lastIndexOf('</svg>'))
    .replace(BG_RECT, '')
    .replace(GLOW, '');
  const markup = `<defs>${defs.join('')}</defs>${body}`.replace(/>\s+</g, '><').trim();
  if (!markup.includes('<mask') || /url\(#(bgr|glow|sh)\)/.test(markup)) {
    throw new Error('brand icon master has an unexpected structure: cannot separate the mark from its tile');
  }
  return prefixIds(markup, idPrefix);
}

/** The one-ink glyph as a 24x24 sprite symbol body painted with currentColor. */
export function brandMonoSpriteMarkup(monoSvg) {
  // Black inside a <mask> means "cut here": only the paint outside it becomes the ink.
  const body = monoSvg.slice(monoSvg.indexOf('</defs>') + '</defs>'.length, monoSvg.lastIndexOf('</svg>'))
    .replace(/(<mask\b[\s\S]*?<\/mask>)|#000\b/g, (match, mask) => mask ?? 'currentColor')
    .replace(/>\s+</g, '><')
    .trim();
  if (!body.includes('currentColor') || body.includes('url(#bgr)')) {
    throw new Error('brand mono master has an unexpected structure');
  }
  return `<g transform="scale(${24 / 1024})">${prefixIds(body, 'oc-brand-')}</g>`;
}

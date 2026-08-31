import polygonClipping from '../../vendor/polygon-clipping.js';
import { closeRing, dedupe } from '../core/geom.js';

const CURVE_STEPS = 6;

function quadPoints(x0, y0, cx, cy, x1, y1) {
  const pts = [];
  for (let i = 1; i <= CURVE_STEPS; i++) {
    const t = i / CURVE_STEPS;
    const mt = 1 - t;
    pts.push([
      mt * mt * x0 + 2 * mt * t * cx + t * t * x1,
      mt * mt * y0 + 2 * mt * t * cy + t * t * y1,
    ]);
  }
  return pts;
}

function cubicPoints(x0, y0, c1x, c1y, c2x, c2y, x1, y1) {
  const pts = [];
  for (let i = 1; i <= CURVE_STEPS; i++) {
    const t = i / CURVE_STEPS;
    const mt = 1 - t;
    pts.push([
      mt ** 3 * x0 + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t ** 3 * x1,
      mt ** 3 * y0 + 3 * mt * mt * t * c1y + 3 * mt * t * t * c2y + t ** 3 * y1,
    ]);
  }
  return pts;
}

function glyphRings(glyph) {
  if (!glyph || !glyph.o) return [];
  const tokens = glyph.o.split(/\s+/).filter(Boolean);
  const rings = [];
  let current = null;
  let x = 0;
  let y = 0;
  let i = 0;

  const push = (pts) => {
    for (const p of pts) current.push(p);
    const last = pts[pts.length - 1];
    x = last[0];
    y = last[1];
  };

  while (i < tokens.length) {
    const cmd = tokens[i++];
    switch (cmd) {
      case 'm':
        if (current && current.length >= 3) rings.push(current);
        x = parseFloat(tokens[i++]);
        y = parseFloat(tokens[i++]);
        current = [[x, y]];
        break;
      case 'l': {
        if (!current) break;
        const nx = parseFloat(tokens[i++]);
        const ny = parseFloat(tokens[i++]);
        push([[nx, ny]]);
        break;
      }
      case 'q': {
        if (!current) break;
        const ex = parseFloat(tokens[i++]);
        const ey = parseFloat(tokens[i++]);
        const cx = parseFloat(tokens[i++]);
        const cy = parseFloat(tokens[i++]);
        push(quadPoints(x, y, cx, cy, ex, ey));
        break;
      }
      case 'b': {
        if (!current) break;
        const ex = parseFloat(tokens[i++]);
        const ey = parseFloat(tokens[i++]);
        const c1x = parseFloat(tokens[i++]);
        const c1y = parseFloat(tokens[i++]);
        const c2x = parseFloat(tokens[i++]);
        const c2y = parseFloat(tokens[i++]);
        push(cubicPoints(x, y, c1x, c1y, c2x, c2y, ex, ey));
        break;
      }
      case 'z':
        if (current && current.length >= 3) rings.push(current);
        current = null;
        break;
      default:
        i++;
        break;
    }
  }
  if (current && current.length >= 3) rings.push(current);
  return rings;
}

function glyphMultiPolygon(glyph) {
  const rings = glyphRings(glyph)
    .map((r) => closeRing(dedupe(r)))
    .filter((r) => r.length >= 4);
  if (!rings.length) return [];
  if (rings.length === 1) return [[rings[0]]];
  try {
    return polygonClipping.xor(...rings.map((r) => [[r]]));
  } catch {
    return rings.map((r) => [r]);
  }
}

function transformMp(mp, scale, dx, dy) {
  return mp.map((poly) =>
    poly.map((ring) => ring.map(([x, y]) => [x * scale + dx, y * scale + dy]))
  );
}

export function layoutText(font, text, opts = {}) {
  const { size = 6, tracking = 0, align = 'center', x = 0, y = 0, maxWidth = 0 } = opts;
  if (!font || !text) return { polygons: [], width: 0, height: 0, scale: 0 };

  const data = font.data || font;
  const resolution = data.resolution || 1000;
  let scale = size / resolution;

  const chars = Array.from(text);
  const measure = (s) => {
    let w = 0;
    for (const ch of chars) {
      const g = data.glyphs[ch] || data.glyphs['?'];
      if (!g) continue;
      w += g.ha * s + tracking;
    }
    return w - (chars.length ? tracking : 0);
  };

  let width = measure(scale);
  if (maxWidth > 0 && width > maxWidth) {
    scale *= maxWidth / width;
    width = measure(scale);
  }

  let cursor = align === 'center' ? x - width / 2 : align === 'right' ? x - width : x;

  const polygons = [];
  for (const ch of chars) {
    const glyph = data.glyphs[ch] || data.glyphs['?'];
    if (!glyph) continue;
    if (ch !== ' ') {
      const mp = glyphMultiPolygon(glyph);
      for (const poly of transformMp(mp, scale, cursor, y)) polygons.push(poly);
    }
    cursor += glyph.ha * scale + tracking;
  }

  return {
    polygons,
    width,
    height: (data.boundingBox?.yMax ?? resolution * 0.7) * scale,
    scale,
  };
}

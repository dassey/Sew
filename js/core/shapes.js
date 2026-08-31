import { closeRing } from './geom.js';

function rotate(ring, radians) {
  if (!radians) return ring;
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return ring.map(([x, y]) => [x * c - y * s, x * s + y * c]);
}

export function inscribedRadiusOf(ring) {
  let minDist = Infinity;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? -(x1 * dx + y1 * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    minDist = Math.min(minDist, Math.hypot(x1 + t * dx, y1 + t * dy));
  }
  return isFinite(minDist) ? minDist : 0;
}

function scaleToExtent(ring, size) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const span = Math.max(maxX - minX, maxY - minY);
  if (!(span > 0)) return ring;
  const k = size / span;
  const cx = ((minX + maxX) / 2) * k;
  const cy = ((minY + maxY) / 2) * k;
  return ring.map(([x, y]) => [x * k - cx, y * k - cy]);
}

function regularPolygon(sides, radius, phase = 0) {
  const ring = [];
  for (let i = 0; i < sides; i++) {
    const a = phase + (i / sides) * Math.PI * 2;
    ring.push([Math.cos(a) * radius, Math.sin(a) * radius]);
  }
  return closeRing(ring);
}

function roundedRect(halfW, halfH, r, segments = 8) {
  const rr = Math.min(r, halfW, halfH);
  const ring = [];
  const corners = [
    [halfW - rr, halfH - rr, 0],
    [-halfW + rr, halfH - rr, Math.PI / 2],
    [-halfW + rr, -halfH + rr, Math.PI],
    [halfW - rr, -halfH + rr, (3 * Math.PI) / 2],
  ];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= segments; i++) {
      const a = a0 + (i / segments) * (Math.PI / 2);
      ring.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
    }
  }
  return closeRing(ring);
}

function heartOutline(radius, steps = 160) {
  const raw = [];
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < steps; i++) {
    const t = Math.PI * 2 * (1 - i / steps);
    const x = 16 * Math.sin(t) ** 3;
    const y =
      13 * Math.cos(t) -
      5 * Math.cos(2 * t) -
      2 * Math.cos(3 * t) -
      Math.cos(4 * t);
    raw.push([x, y]);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const midY = (minY + maxY) / 2;
  const k = radius / 12;
  return closeRing(raw.map(([x, y]) => [x * k, (y - midY) * k]));
}

function starOutline(points, radius, innerRatio = 0.45) {
  const ring = [];
  const total = points * 2;
  for (let i = 0; i < total; i++) {
    const a = Math.PI / 2 + (i / total) * Math.PI * 2;
    const r = i % 2 === 0 ? radius : radius * innerRatio;
    ring.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return closeRing(ring);
}

export const SHAPES = [
  { id: 'circle', label: 'Circle' },
  { id: 'square', label: 'Square' },
  { id: 'rounded', label: 'Rounded square' },
  { id: 'rectangle', label: 'Rectangle' },
  { id: 'hexagon', label: 'Hexagon' },
  { id: 'octagon', label: 'Octagon' },
  { id: 'triangle', label: 'Triangle' },
  { id: 'heart', label: 'Heart' },
  { id: 'star', label: 'Star' },
  { id: 'custom', label: 'Custom polygon' },
];

export function buildShapeRing({
  shape = 'circle',
  radius = 100,
  rotation = 0,
  aspect = 1.5,
  custom = null,
} = {}) {
  const rad = (-rotation * Math.PI) / 180;
  let ring;

  switch (shape) {
    case 'square':
      ring = roundedRect(radius, radius, 0, 1);
      break;
    case 'rounded':
      ring = roundedRect(radius, radius, radius * 0.22, 10);
      break;
    case 'rectangle': {
      const a = Math.max(0.25, Math.min(4, aspect));
      ring = a >= 1
        ? roundedRect(radius * a, radius, 0, 1)
        : roundedRect(radius, radius / a, 0, 1);
      break;
    }
    case 'hexagon':
      ring = regularPolygon(6, radius, Math.PI / 6);
      break;
    case 'octagon':
      ring = regularPolygon(8, radius, Math.PI / 8);
      break;
    case 'triangle':
      ring = regularPolygon(3, radius, Math.PI / 2);
      break;
    case 'heart':
      ring = heartOutline(radius);
      break;
    case 'star':
      ring = starOutline(5, radius);
      break;
    case 'custom':
      ring = custom && custom.length >= 3
        ? closeRing(custom.map(([x, y]) => [x, y]))
        : regularPolygon(64, radius);
      break;
    case 'circle':
    default:
      ring = regularPolygon(96, radius);
      break;
  }

  return scaleToExtent(rotate(ring, rad), radius * 2);
}

export function buildShapeMultiPolygon(opts) {
  return [[buildShapeRing(opts)]];
}

export function shapeOuterRadius(opts) {
  const ring = buildShapeRing(opts);
  let max = 0;
  for (const [x, y] of ring) max = Math.max(max, Math.hypot(x, y));
  return max;
}

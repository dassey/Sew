import {
  convexHull,
  intersection,
  orientedBounds,
  ringArea,
  snapMultiPolygon,
  triangulatePolygon,
} from './geom.js';
import { extrudePolygon, orientPolygon } from './mesh.js';

const snapZ = (z) => Math.round(z * 1000) / 1000;

const PITCH = {
  gabled: (ob, ms) => Math.min(ob.halfWidth * 0.72, 6 * ms),
  skillion: (ob, ms) => Math.min(ob.halfWidth * 0.4, 4 * ms),
  pyramidal: (ob, ms) => Math.min(ob.halfWidth * 0.9, 8 * ms),
};

export function addRoof(mesh, poly, z0, totalH, spec, opts = {}) {
  if (!mesh || !spec || spec.shape === 'flat') return null;
  if (poly.length !== 1) return null;
  const ring = poly[0];

  const ob = orientedBounds(ring);
  if (!ob || ob.halfWidth < (opts.minHalfWidthMm ?? 0.35)) return null;

  let shape = spec.shape;
  if (shape === 'pyramidal' && convexity(ring) < 0.8) {
    shape = 'gabled';
  }

  const metreScale = opts.metreScale ?? 1;
  let rise =
    spec.heightM != null
      ? spec.heightM * metreScale
      : PITCH[shape](ob, metreScale);
  rise = Math.min(rise, totalH * 0.6);
  if (rise < (opts.minRoofMm ?? 0.2)) return null;

  const ridgeZ = snapZ(z0 + totalH);
  const wallTop = snapZ(ridgeZ - rise);
  if (ridgeZ - wallTop <= 0) return null;

  let built = false;
  if (shape === 'gabled') {
    built = gabled(mesh, poly, ob, spec, wallTop, ridgeZ);
  } else if (shape === 'skillion') {
    built = skillion(mesh, poly, ob, spec, wallTop, ridgeZ);
  } else if (shape === 'pyramidal') {
    built = pyramid(mesh, poly, ob, wallTop, ridgeZ);
  }
  return built ? wallTop : null;
}

function convexity(ring) {
  const hull = convexHull(ring);
  if (hull.length < 3) return 0;
  const hullArea = Math.abs(ringArea(hull));
  return hullArea > 0 ? Math.abs(ringArea(ring)) / hullArea : 0;
}

function ridgeHalfPlane(ob, side, reach) {
  const { cx, cy, ux, uy, vx, vy } = ob;
  const R = reach;
  return [[
    [cx - ux * R, cy - uy * R],
    [cx + ux * R, cy + uy * R],
    [cx + ux * R + side * vx * R, cy + uy * R + side * vy * R],
    [cx - ux * R + side * vx * R, cy - uy * R + side * vy * R],
    [cx - ux * R, cy - uy * R],
  ]];
}

function gabled(mesh, poly, ob, spec, wallTop, ridgeZ) {
  let { cx, cy, ux, uy, vx, vy, halfLength, halfWidth } = ob;
  if (spec.orientation === 'across') {
    [ux, uy, vx, vy] = [vx, vy, ux, uy];
    [halfLength, halfWidth] = [halfWidth, halfLength];
  }
  if (halfWidth < 1e-6) return false;

  const rise = ridgeZ - wallTop;
  const zAt = (x, y) => {
    const d = Math.abs((x - cx) * vx + (y - cy) * vy);
    return snapZ(wallTop + rise * Math.max(0, 1 - d / halfWidth));
  };

  const axes = { cx, cy, ux, uy, vx, vy };
  const reach = halfLength + halfWidth + 10;
  let built = 0;
  for (const side of [1, -1]) {
    for (const piece of intersection([poly], ridgeHalfPlane(axes, side, reach))) {
      if (extrudePolygon(mesh, piece, wallTop, zAt)) built++;
    }
  }
  return built > 0;
}

function skillion(mesh, poly, ob, spec, wallTop, ridgeZ) {
  let dx, dy;
  if (spec.directionDeg != null) {
    const rad = (spec.directionDeg * Math.PI) / 180;
    dx = Math.sin(rad);
    dy = Math.cos(rad);
  } else {
    dx = ob.vx;
    dy = ob.vy;
  }
  let min = Infinity;
  let max = -Infinity;
  for (const [x, y] of poly[0]) {
    const d = x * dx + y * dy;
    if (d < min) min = d;
    if (d > max) max = d;
  }
  const span = max - min;
  if (span < 1e-6) return false;

  const rise = ridgeZ - wallTop;
  const zAt = (x, y) =>
    snapZ(wallTop + (rise * (max - (x * dx + y * dy))) / span);
  return extrudePolygon(mesh, poly, wallTop, zAt);
}

function pyramid(mesh, poly, ob, wallTop, ridgeZ) {
  const snapped = snapMultiPolygon([poly])[0];
  if (!snapped) return false;
  const tri = triangulatePolygon(orientPolygon(snapped));
  if (!tri) return false;

  const { flat, indices, boundary } = tri;
  const base = mesh.vertexCount;
  for (let i = 0; i < flat.length / 2; i++) {
    mesh.addVertex(flat[i * 2], flat[i * 2 + 1], wallTop);
  }
  for (let i = 0; i < indices.length; i += 3) {
    mesh.addTriangle(base + indices[i + 2], base + indices[i + 1], base + indices[i]);
  }
  const apex = mesh.addVertex(ob.cx, ob.cy, ridgeZ);
  for (const [ia, ib] of boundary) {
    mesh.addTriangle(base + ia, base + ib, apex);
  }
  return true;
}

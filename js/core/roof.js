/**
 * Pitched roofs.
 *
 * A roof is a separate closed solid that sits face-to-face on top of its
 * building prism — the same stacking the plate already uses between parts, so
 * nothing here touches the ground partition. Keeping the roof out of the wall
 * prism buys two things: the building extrusion below stays the plain flat
 * prism it always was, and the roofs can be their own colour.
 *
 * The geometry rests on one observation: split a footprint along its ridge
 * line and the height of each half's roof plane is a *linear* function of
 * x and y — so any triangulation of the half is exactly planar, and the
 * existing extruder with a per-vertex top does all the work. The ridge is
 * taken from the footprint's minimum-area oriented bounding box, which reads
 * the long axis correctly even for footprints the plate edge has clipped.
 *
 * Every z is snapped to the micron grid before it reaches the mesh. That
 * makes "the eave meets the wall top" an exact equality, which is what lets
 * the extruder skip the zero-height wall there instead of emitting zero-area
 * facets — and it keeps the two halves' ridge vertices bit-identical, so each
 * half is independently watertight and the pair merely share faces.
 */

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

/**
 * Default rises when OSM tags no roof height: a fixed pitch from the
 * eave-to-ridge run, capped in real metres so a wide hall gets a plausible
 * roof rather than a mountain. Both terms are in mm of print — `ms` is the
 * print scale in mm per metre.
 */
const PITCH = {
  gabled: (ob, ms) => Math.min(ob.halfWidth * 0.72, 6 * ms), // ~36° pitch
  skillion: (ob, ms) => Math.min(ob.halfWidth * 0.4, 4 * ms),
  pyramidal: (ob, ms) => Math.min(ob.halfWidth * 0.9, 8 * ms),
};

/**
 * Try to put a pitched roof on one building footprint.
 *
 * The roof occupies the top of the building's height rather than adding to
 * it, so the skyline silhouette is exactly as tall as before — the mass is
 * carved, not stacked.
 *
 * @param {MeshBuilder} mesh   the roofs part
 * @param {Array} poly         one polygon, mm (outer ring + holes)
 * @param {number} z0          bottom of the building, mm
 * @param {number} totalH      building height above z0, mm
 * @param {object} spec        from tags.roofSpec()
 * @param {object} [opts]      {metreScale, minRoofMm, minHalfWidthMm}
 * @returns {number|null}      the wall-top z when a roof was built — the
 *                             caller extrudes the prism up to it — or null,
 *                             meaning keep the plain full-height prism.
 */
export function addRoof(mesh, poly, z0, totalH, spec, opts = {}) {
  if (!mesh || !spec || spec.shape === 'flat') return null;
  // A hole means a courtyard; the cheap ridge model would roof right over it.
  if (poly.length !== 1) return null;
  const ring = poly[0];

  const ob = orientedBounds(ring);
  if (!ob || ob.halfWidth < (opts.minHalfWidthMm ?? 0.35)) return null;

  let shape = spec.shape;
  if (shape === 'pyramidal' && convexity(ring) < 0.8) {
    // An apex over the centre of a concave footprint hangs in the void.
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

/** A rectangle covering everything on one side of the ridge line. */
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

/**
 * Two planes meeting at a ridge along the footprint's long axis. The gable
 * ends fall out by themselves: on the end walls the roof edge climbs from
 * eave to ridge, and the extruder's varying-height walls fill the pediment.
 */
function gabled(mesh, poly, ob, spec, wallTop, ridgeZ) {
  let { cx, cy, ux, uy, vx, vy, halfLength, halfWidth } = ob;
  if (spec.orientation === 'across') {
    // Mapped on terraces where each house is wider than it is deep.
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

/** One plane, high on the side opposite `roof:direction`. */
function skillion(mesh, poly, ob, spec, wallTop, ridgeZ) {
  let dx, dy;
  if (spec.directionDeg != null) {
    // Compass degrees, clockwise from north; +y is north in plate space.
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

/** A fan from the boundary to an apex over the box centre. */
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
  // Underside, reversed to face down.
  for (let i = 0; i < indices.length; i += 3) {
    mesh.addTriangle(base + indices[i + 2], base + indices[i + 1], base + indices[i]);
  }
  const apex = mesh.addVertex(ob.cx, ob.cy, ridgeZ);
  for (const [ia, ib] of boundary) {
    mesh.addTriangle(base + ia, base + ib, apex);
  }
  return true;
}

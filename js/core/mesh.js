/**
 * Triangle-soup accumulator with the extrusion primitives the model builder
 * needs. Geometry is indexed (compact in the viewer) and Z-up throughout so
 * that STL/3MF export is a straight copy with no axis juggling.
 */

import { ringArea, triangulatePolygon, snapMultiPolygon } from './geom.js';

const GROWTH = 1.6;

export class MeshBuilder {
  constructor(name, initialVerts = 1024) {
    this.name = name;
    this.positions = new Float32Array(initialVerts * 3);
    this.vertexCount = 0;
    this.indices = [];
  }

  _reserve(extraVerts) {
    const needed = (this.vertexCount + extraVerts) * 3;
    if (needed <= this.positions.length) return;
    let size = Math.max(this.positions.length || 3, 3);
    while (size < needed) size = Math.ceil(size * GROWTH);
    const next = new Float32Array(size);
    next.set(this.positions.subarray(0, this.vertexCount * 3));
    this.positions = next;
  }

  addVertex(x, y, z) {
    this._reserve(1);
    const i = this.vertexCount * 3;
    this.positions[i] = x;
    this.positions[i + 1] = y;
    this.positions[i + 2] = z;
    return this.vertexCount++;
  }

  addTriangle(a, b, c) {
    this.indices.push(a, b, c);
  }

  addQuad(a, b, c, d) {
    this.indices.push(a, b, c, a, c, d);
  }

  get triangleCount() {
    return this.indices.length / 3;
  }

  isEmpty() {
    return this.indices.length === 0;
  }

  /** Trim the position buffer and hand back plain typed arrays. */
  finish() {
    return {
      name: this.name,
      positions: this.positions.slice(0, this.vertexCount * 3),
      indices:
        this.vertexCount > 65535
          ? new Uint32Array(this.indices)
          : new Uint16Array(this.indices),
      triangleCount: this.triangleCount,
    };
  }

  /**
   * Signed volume via the divergence theorem. A watertight, correctly wound
   * mesh yields a positive value; a negative or wildly small one is a reliable
   * smoke test that winding or capping went wrong.
   */
  volume() {
    let v = 0;
    const p = this.positions;
    for (let i = 0; i < this.indices.length; i += 3) {
      const a = this.indices[i] * 3;
      const b = this.indices[i + 1] * 3;
      const c = this.indices[i + 2] * 3;
      const ax = p[a], ay = p[a + 1], az = p[a + 2];
      const bx = p[b], by = p[b + 1], bz = p[b + 2];
      const cx = p[c], cy = p[c + 1], cz = p[c + 2];
      v +=
        ax * (by * cz - bz * cy) -
        ay * (bx * cz - bz * cx) +
        az * (bx * cy - by * cx);
    }
    return v / 6;
  }

  bounds() {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    const p = this.positions;
    for (let i = 0; i < this.vertexCount * 3; i += 3) {
      if (p[i] < minX) minX = p[i];
      if (p[i] > maxX) maxX = p[i];
      if (p[i + 1] < minY) minY = p[i + 1];
      if (p[i + 1] > maxY) maxY = p[i + 1];
      if (p[i + 2] < minZ) minZ = p[i + 2];
      if (p[i + 2] > maxZ) maxZ = p[i + 2];
    }
    return { minX, minY, minZ, maxX, maxY, maxZ };
  }
}

/**
 * Force outer rings counter-clockwise and holes clockwise.
 *
 * This matters for the *side walls*, not the caps. Earcut normalises ring
 * winding internally, so its triangles always come out counter-clockwise in XY
 * whatever it was handed — which is why the top cap is reliably +Z and the
 * bottom cap is reliably -Z after reversing. The walls have no such safety net:
 * they read the ring directly, and only produce outward normals when the solid
 * is consistently on the left of travel. Feed them a clockwise shell and every
 * wall faces inward while the caps still face out, which is both inside-out
 * *and* full of unpaired edges.
 */
export function orientPolygon(poly) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const ring = poly[i];
    const wantCCW = i === 0;
    const isCCW = ringArea(ring) > 0;
    out.push(isCCW === wantCCW ? ring : [...ring].reverse());
  }
  return out;
}

/**
 * Extrude a polygon into a closed prism.
 *
 * @param {MeshBuilder} mesh
 * @param {Array} poly           outer ring + holes, mm
 * @param {number|Function} bottom  z, or (x, y) => z
 * @param {number|Function} top     z, or (x, y) => z
 * @param {object} [opts]
 * @param {boolean} [opts.capBottom=true]  emit the underside (skip when the
 *                                         prism sits on another solid)
 */
export function extrudePolygon(mesh, poly, bottom, top, opts = {}) {
  const { capBottom = true } = opts;

  // Snap to the micron grid before triangulating.
  //
  // Boolean output routinely places vertices a few nanometres apart. Left
  // alone they survive in memory but collapse when a file format rounds them —
  // 3MF writes millimetres to three decimals — turning a valid triangle into a
  // zero-area facet that every mesh checker flags. Quantising here means the
  // rounding on export is exact, and identical positions stay identical, so
  // neighbouring parts still meet perfectly.
  const snapped = snapMultiPolygon(poly.length ? [poly] : [])[0];
  if (!snapped) return false;

  const oriented = orientPolygon(snapped);
  const tri = triangulatePolygon(oriented);
  if (!tri) return false;

  const zBottom = typeof bottom === 'function' ? bottom : () => bottom;
  const zTop = typeof top === 'function' ? top : () => top;

  const { flat, indices } = tri;
  const nVerts = flat.length / 2;

  // Caps share the triangulation; walls are welded per ring below.
  const topBase = mesh.vertexCount;
  for (let i = 0; i < nVerts; i++) {
    const x = flat[i * 2];
    const y = flat[i * 2 + 1];
    mesh.addVertex(x, y, zTop(x, y));
  }
  for (let i = 0; i < indices.length; i += 3) {
    mesh.addTriangle(
      topBase + indices[i],
      topBase + indices[i + 1],
      topBase + indices[i + 2]
    );
  }

  let bottomBase = -1;
  if (capBottom) {
    bottomBase = mesh.vertexCount;
    for (let i = 0; i < nVerts; i++) {
      const x = flat[i * 2];
      const y = flat[i * 2 + 1];
      mesh.addVertex(x, y, zBottom(x, y));
    }
    for (let i = 0; i < indices.length; i += 3) {
      // Reversed winding so the underside faces -Z.
      mesh.addTriangle(
        bottomBase + indices[i + 2],
        bottomBase + indices[i + 1],
        bottomBase + indices[i]
      );
    }
  }

  // Walls follow the *triangulation's* boundary rather than the input rings.
  // The two are normally identical, but when earcut disagrees it is the
  // triangulation that the caps were actually built from — welding to anything
  // else leaves the solid open. Each boundary half-edge runs with the cap
  // interior on its left, so the same winding rule gives outward normals for
  // shell and hole walls alike.
  //
  // A wall of exactly zero height is no wall at all: where a sloped top cap
  // comes down to meet the bottom cap — a roof at its eave — the two cap
  // boundary edges pair with each other directly, and emitting a quad there
  // would only add zero-area facets for the exporter to trip over. Zero at
  // one end only means the quad degenerates to a triangle. The comparisons
  // are exact on purpose: sloped tops are snapped to the micron grid, so a
  // zero-height edge is exactly zero, never merely small.
  for (const [ia, ib] of tri.boundary) {
    const x1 = flat[ia * 2];
    const y1 = flat[ia * 2 + 1];
    const x2 = flat[ib * 2];
    const y2 = flat[ib * 2 + 1];
    const zb1 = zBottom(x1, y1);
    const zb2 = zBottom(x2, y2);
    const zt1 = zTop(x1, y1);
    const zt2 = zTop(x2, y2);
    if (zt1 === zb1 && zt2 === zb2) continue;
    const b1 = mesh.addVertex(x1, y1, zb1);
    const b2 = mesh.addVertex(x2, y2, zb2);
    if (zt1 === zb1) {
      mesh.addTriangle(b1, b2, mesh.addVertex(x2, y2, zt2));
    } else if (zt2 === zb2) {
      mesh.addTriangle(b1, b2, mesh.addVertex(x1, y1, zt1));
    } else {
      const t2 = mesh.addVertex(x2, y2, zt2);
      const t1 = mesh.addVertex(x1, y1, zt1);
      mesh.addQuad(b1, b2, t2, t1);
    }
  }
  return true;
}

/** Extrude every polygon of a multipolygon. Returns how many succeeded. */
export function extrudeMultiPolygon(mesh, mp, bottom, top, opts) {
  let n = 0;
  for (const poly of mp) {
    if (extrudePolygon(mesh, poly, bottom, top, opts)) n++;
  }
  return n;
}

/** Vertical cone/cylinder — tree canopies and map pins. */
export function addCone(mesh, cx, cy, z0, z1, rBottom, rTop, segments = 8) {
  const ringIdx = [];
  const topIdx = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    ringIdx.push(mesh.addVertex(cx + c * rBottom, cy + s * rBottom, z0));
    topIdx.push(mesh.addVertex(cx + c * rTop, cy + s * rTop, z1));
  }

  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    if (rTop > 1e-4) {
      mesh.addQuad(ringIdx[i], ringIdx[j], topIdx[j], topIdx[i]);
    } else {
      mesh.addTriangle(ringIdx[i], ringIdx[j], topIdx[i]);
    }
  }

  const centreBottom = mesh.addVertex(cx, cy, z0);
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    mesh.addTriangle(centreBottom, ringIdx[j], ringIdx[i]);
  }
  if (rTop > 1e-4) {
    const centreTop = mesh.addVertex(cx, cy, z1);
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments;
      mesh.addTriangle(centreTop, topIdx[i], topIdx[j]);
    }
  }
}

/** Merge several finished meshes into one buffer pair (for single-file STL). */
export function mergeMeshes(meshes) {
  let vTotal = 0;
  let iTotal = 0;
  for (const m of meshes) {
    vTotal += m.positions.length / 3;
    iTotal += m.indices.length;
  }
  const positions = new Float32Array(vTotal * 3);
  const indices = new Uint32Array(iTotal);
  let vOff = 0;
  let iOff = 0;
  for (const m of meshes) {
    positions.set(m.positions, vOff * 3);
    for (let i = 0; i < m.indices.length; i++) {
      indices[iOff + i] = m.indices[i] + vOff;
    }
    vOff += m.positions.length / 3;
    iOff += m.indices.length;
  }
  return { positions, indices };
}

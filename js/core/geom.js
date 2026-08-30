/**
 * 2D polygon toolkit.
 *
 * Everything downstream speaks the polygon-clipping data model so that boolean
 * ops are free of conversion cost:
 *
 *   Point        = [x, y]
 *   Ring         = Point[]            (closed; first point repeated at the end)
 *   Polygon      = Ring[]             (outer ring first, then holes)
 *   MultiPolygon = Polygon[]
 *
 * Units are millimetres in model space throughout.
 */

import polygonClipping from '../../vendor/polygon-clipping.js';
import earcut from '../../vendor/earcut.js';

/* ------------------------------------------------------------------ *
 * Boolean operations
 * ------------------------------------------------------------------ */

/** Printers resolve ~10 microns; 1 micron is well past anything visible. */
const SNAP_MM = 0.001;

/**
 * Round every coordinate onto a fixed grid and drop the duplicates that
 * creates.
 *
 * polygon-clipping's sweep line is exact-arithmetic in principle but fails in
 * practice on *nearly* coincident points — the classic "Unable to find segment
 * in SweepLine tree" — and OSM geometry, once projected and scaled to
 * millimetres, is full of vertices a few nanometres apart. Collapsing them onto
 * a grid turns "nearly the same point" into "the same point", which the
 * algorithm handles correctly.
 */
export function snapMultiPolygon(mp, step = SNAP_MM) {
  const k = 1 / step;
  const out = [];
  for (const poly of mp) {
    const rings = [];
    for (const ring of poly) {
      const snapped = [];
      for (const [x, y] of ring) {
        const px = Math.round(x * k) / k;
        const py = Math.round(y * k) / k;
        const last = snapped[snapped.length - 1];
        if (!last || last[0] !== px || last[1] !== py) snapped.push([px, py]);
      }
      const closed = closeRing(snapped);
      if (closed.length >= 4) rings.push(closed);
    }
    if (rings.length) out.push(rings);
  }
  return out;
}

/**
 * Every boolean call goes through this guard.
 *
 * First attempt runs on the input as-is. If the sweep line throws, the inputs
 * are snapped to the micron grid and it is retried — which recovers the great
 * majority of real failures. Only if that also throws do we fall back, because
 * one pathological way must never take down an entire model build.
 */
function guarded(op, fallback, ...args) {
  try {
    const out = polygonClipping[op](...args);
    return out && out.length ? out : [];
  } catch {
    try {
      const out = polygonClipping[op](...args.map((a) => snapMultiPolygon(a)));
      return out && out.length ? out : [];
    } catch (second) {
      console.warn(`[geom] ${op} failed even after snapping: ${second.message}`);
      return fallback;
    }
  }
}

/** Normalise/merge a multipolygon; also repairs self-intersections. */
export function normalize(mp) {
  if (!mp || !mp.length) return [];
  return guarded('union', mp, mp);
}

/**
 * Union a large pile of polygons in chunks.
 *
 * Sweep-line cost grows super-linearly with segment count, and so does the
 * chance of hitting a robustness bug. Merging a dense city's road buffers in
 * batches keeps each sweep small, and confines any failure that does happen to
 * one batch instead of losing the whole layer.
 */
export function unionBatched(polys, batchSize = 200) {
  if (!polys.length) return [];
  if (polys.length <= batchSize) return normalize(polys);

  let level = [];
  for (let i = 0; i < polys.length; i += batchSize) {
    level.push(normalize(polys.slice(i, i + batchSize)));
  }
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? union(level[i], level[i + 1]) : level[i]);
    }
    level = next;
  }
  return level[0] || [];
}

export function union(a, b) {
  if (!a || !a.length) return b && b.length ? normalize(b) : [];
  if (!b || !b.length) return normalize(a);
  return guarded('union', a, a, b);
}

export function difference(a, b) {
  if (!a || !a.length) return [];
  if (!b || !b.length) return a;
  return guarded('difference', a, a, b);
}

export function intersection(a, b) {
  if (!a || !a.length || !b || !b.length) return [];
  return guarded('intersection', [], a, b);
}

/**
 * Subtract every mask in turn. Used to build the disjoint layer partition,
 * where each successive layer is carved out of what the ones above left behind.
 */
export function differenceAll(subject, masks) {
  let out = subject;
  for (const m of masks) {
    if (!out.length) break;
    if (m && m.length) out = difference(out, m);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Ring utilities
 * ------------------------------------------------------------------ */

/**
 * Signed shoelace area. Positive means counter-clockwise, which is the
 * convention the whole extruder depends on — see `orientPolygon`.
 */
export function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return a / 2;
}

export function closeRing(ring) {
  if (ring.length < 2) return ring;
  const a = ring[0];
  const b = ring[ring.length - 1];
  if (a[0] !== b[0] || a[1] !== b[1]) return [...ring, [a[0], a[1]]];
  return ring;
}

/** Total surface area of a multipolygon (outer rings minus holes), mm². */
export function multiPolygonArea(mp) {
  let total = 0;
  for (const poly of mp) {
    for (let i = 0; i < poly.length; i++) {
      const a = Math.abs(ringArea(poly[i]));
      total += i === 0 ? a : -a;
    }
  }
  return total;
}

/**
 * Discard slivers that would print as nothing but stringing.
 *
 * Only whole polygons are dropped, never holes. A hole is where a
 * higher-priority layer has already claimed the ground — a small building
 * poking into a road, say — so filling one in does not remove a sliver, it
 * makes two parts overlap and puts the wrong colour on top.
 */
export function dropTinyPolygons(mp, minArea) {
  return mp.filter((poly) => Math.abs(ringArea(poly[0])) >= minArea);
}

export function boundsOf(mp) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const poly of mp) {
    for (const [x, y] of poly[0]) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX, maxY };
}

/** Convex hull (monotone chain), counter-clockwise, duplicates dropped. */
export function convexHull(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const uniq = [];
  for (const p of pts) {
    const q = uniq[uniq.length - 1];
    if (!q || q[0] !== p[0] || q[1] !== p[1]) uniq.push(p);
  }
  if (uniq.length < 3) return uniq;
  const cross = (o, a, b) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of uniq) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper = [];
  for (let i = uniq.length - 1; i >= 0; i--) {
    const p = uniq[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Minimum-area oriented bounding box, via rotating calipers over the hull.
 *
 * The roof builder reads the long axis as the ridge direction, which is the
 * right guess for nearly every house — including footprints already clipped
 * by the plate edge, which axis-aligned bounds would misjudge badly.
 *
 * @returns {{cx, cy, ux, uy, vx, vy, halfLength, halfWidth}|null}
 *          `u` is the unit long axis, `v` the unit short axis,
 *          `halfLength >= halfWidth`. Null for degenerate input.
 */
export function orientedBounds(ring) {
  const hull = convexHull(ring);
  if (hull.length < 3) return null;
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const j = (i + 1) % hull.length;
    const ex = hull[j][0] - hull[i][0];
    const ey = hull[j][1] - hull[i][1];
    const len = Math.hypot(ex, ey);
    if (len < 1e-9) continue;
    const ux = ex / len;
    const uy = ey / len;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const [x, y] of hull) {
      const du = x * ux + y * uy;
      const dv = -x * uy + y * ux;
      if (du < minU) minU = du;
      if (du > maxU) maxU = du;
      if (dv < minV) minV = dv;
      if (dv > maxV) maxV = dv;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area) {
      best = { area, ux, uy, minU, maxU, minV, maxV };
    }
  }
  if (!best) return null;
  const cu = (best.minU + best.maxU) / 2;
  const cv = (best.minV + best.maxV) / 2;
  let ux = best.ux;
  let uy = best.uy;
  let halfLength = (best.maxU - best.minU) / 2;
  let halfWidth = (best.maxV - best.minV) / 2;
  if (halfWidth > halfLength) {
    [halfLength, halfWidth] = [halfWidth, halfLength];
    [ux, uy] = [-uy, ux];
  }
  return {
    cx: best.ux * cu - best.uy * cv,
    cy: best.uy * cu + best.ux * cv,
    ux,
    uy,
    vx: -uy,
    vy: ux,
    halfLength,
    halfWidth,
  };
}

export function pointInRing(pt, ring) {
  let inside = false;
  const [px, py] = pt;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export function pointInMultiPolygon(pt, mp) {
  for (const poly of mp) {
    if (!pointInRing(pt, poly[0])) continue;
    let inHole = false;
    for (let i = 1; i < poly.length; i++) {
      if (pointInRing(pt, poly[i])) { inHole = true; break; }
    }
    if (!inHole) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Simplification and densification
 * ------------------------------------------------------------------ */

/** Douglas–Peucker. Cuts OSM vertex counts by 60-80% at printable tolerances. */
export function simplify(points, tolerance) {
  if (points.length <= 2 || tolerance <= 0) return points;
  const tol2 = tolerance * tolerance;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;

  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxD = 0;
    let index = -1;
    const [x1, y1] = points[first];
    const [x2, y2] = points[last];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;

    for (let i = first + 1; i < last; i++) {
      const [px, py] = points[i];
      let d2;
      if (len2 === 0) {
        d2 = (px - x1) ** 2 + (py - y1) ** 2;
      } else {
        let t = ((px - x1) * dx + (py - y1) * dy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        d2 = (px - (x1 + t * dx)) ** 2 + (py - (y1 + t * dy)) ** 2;
      }
      if (d2 > maxD) { maxD = d2; index = i; }
    }

    if (maxD > tol2 && index > 0) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }

  const out = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

/** Drop consecutive duplicates — polygon-clipping chokes on zero-length edges. */
export function dedupe(points, eps = 1e-7) {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last[0] - p[0]) > eps || Math.abs(last[1] - p[1]) > eps) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Insert intermediate vertices so no edge exceeds `maxLen`. Terrain draping
 * samples heights per-vertex, so a long undivided edge would tunnel straight
 * through a hill.
 */
export function densify(points, maxLen) {
  if (maxLen <= 0) return points;
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[i + 1];
    out.push(points[i]);
    const dist = Math.hypot(x2 - x1, y2 - y1);
    const n = Math.max(0, Math.ceil(dist / maxLen) - 1);
    for (let k = 1; k <= n; k++) {
      const t = k / (n + 1);
      out.push([x1 + (x2 - x1) * t, y1 + (y2 - y1) * t]);
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

export function densifyMultiPolygon(mp, maxLen) {
  return mp.map((poly) => poly.map((ring) => closeRing(densify(ring, maxLen))));
}

export function simplifyMultiPolygon(mp, tolerance) {
  const out = [];
  for (const poly of mp) {
    const rings = [];
    for (const ring of poly) {
      const s = closeRing(dedupe(simplify(ring, tolerance)));
      if (s.length >= 4) rings.push(s);
    }
    if (rings.length) out.push(rings);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Polyline buffering (roads, rail, routes)
 * ------------------------------------------------------------------ */

function arcPoints(cx, cy, r, a0, a1, segments) {
  // Sweep the short way round, which is always the outside of the turn.
  let delta = a1 - a0;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  const steps = Math.max(1, Math.ceil((Math.abs(delta) / Math.PI) * segments));
  const pts = [];
  for (let i = 1; i < steps; i++) {
    const a = a0 + (delta * i) / steps;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return pts;
}

/**
 * Offset a polyline into a closed ring of half-width `hw`.
 *
 * Walks the left side start-to-end and the right side end-to-start, inserting
 * a rounded fillet on the outside of each turn and a plain miter/bevel on the
 * inside. Tight switchbacks can still fold the ring onto itself; `normalize()`
 * downstream repairs that, which is why callers should always run the result
 * through a union rather than triangulating it directly.
 */
export function bufferPolyline(points, hw, opts = {}) {
  const { capStyle = 'round', arcSegments = 8 } = opts;
  const pts = dedupe(points);
  if (pts.length < 2 || hw <= 0) return null;

  const n = pts.length;
  const dirs = [];
  const norms = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1][0] - pts[i][0];
    const dy = pts[i + 1][1] - pts[i][1];
    const len = Math.hypot(dx, dy) || 1;
    dirs.push([dx / len, dy / len]);
    norms.push([-dy / len, dx / len]); // left-hand normal
  }

  const side = (sign) => {
    const out = [];
    const order = sign > 0
      ? [...Array(n - 1).keys()]
      : [...Array(n - 1).keys()].reverse();

    for (let k = 0; k < order.length; k++) {
      const i = order[k];
      const [nx, ny] = norms[i];
      const ox = nx * hw * sign;
      const oy = ny * hw * sign;
      const a = sign > 0 ? pts[i] : pts[i + 1];
      const b = sign > 0 ? pts[i + 1] : pts[i];

      out.push([a[0] + ox, a[1] + oy]);

      const nextI = order[k + 1];
      if (nextI !== undefined) {
        const [mx, my] = norms[nextI];
        const cross = dirs[i][0] * dirs[nextI][1] - dirs[i][1] * dirs[nextI][0];
        const outward = sign > 0 ? cross < 0 : cross > 0;
        const pivot = b;
        if (outward) {
          const a0 = Math.atan2(ny * sign, nx * sign);
          const a1 = Math.atan2(my * sign, mx * sign);
          out.push(...arcPoints(pivot[0], pivot[1], hw, a0, a1, arcSegments));
        }
      }
      out.push([b[0] + ox, b[1] + oy]);
    }
    return out;
  };

  /**
   * Half-turn cap.
   *
   * Both caps sweep by -PI: the end cap starts at the left offset and turns
   * through the direction of travel, the start cap starts at the right offset
   * and turns through the reverse. Interpolating naively between the two offset
   * angles instead would take the near side for one of them and fold the cap
   * back inside the buffer.
   */
  const cap = (at, dir, atEnd) => {
    if (capStyle === 'butt') return [];
    const base = Math.atan2(dir[1], dir[0]);
    const from = base + (atEnd ? Math.PI / 2 : -Math.PI / 2);

    if (capStyle === 'square') {
      const s = atEnd ? 1 : -1;
      const ex = dir[0] * hw * s;
      const ey = dir[1] * hw * s;
      return [
        [at[0] + Math.cos(from) * hw + ex, at[1] + Math.sin(from) * hw + ey],
        [
          at[0] + Math.cos(from - Math.PI) * hw + ex,
          at[1] + Math.sin(from - Math.PI) * hw + ey,
        ],
      ];
    }

    const steps = Math.max(2, arcSegments);
    const out = [];
    for (let i = 1; i < steps; i++) {
      const ang = from - Math.PI * (i / steps);
      out.push([at[0] + Math.cos(ang) * hw, at[1] + Math.sin(ang) * hw]);
    }
    return out;
  };

  const ring = [
    ...side(1),
    ...cap(pts[n - 1], dirs[n - 2], true),
    ...side(-1),
    ...cap(pts[0], dirs[0], false),
  ];

  return closeRing(dedupe(ring));
}

/** Buffer many polylines and merge them into one clean multipolygon. */
export function bufferPolylines(lines, halfWidthFor, opts = {}) {
  const rings = [];
  for (let i = 0; i < lines.length; i++) {
    const hw = halfWidthFor(lines[i], i);
    if (!(hw > 0)) continue;
    const ring = bufferPolyline(lines[i].points || lines[i], hw, opts);
    if (ring && ring.length >= 4) rings.push([ring]);
  }
  return unionBatched(rings);
}

/**
 * A band of half-width `hw` straddling every ring of a multipolygon.
 *
 * Built from per-edge quads plus a disc at each vertex rather than from
 * `bufferPolyline`, because a closed ring offset as a polyline produces a
 * zero-width slit at the seam that boolean normalisation cannot reliably heal.
 * Intersecting the band back with the plate yields the inward frame.
 */
export function bandAroundRings(mp, hw, discSegments = 8) {
  const polys = [];
  for (const poly of mp) {
    for (const ring of poly) {
      for (let i = 0; i < ring.length - 1; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[i + 1];
        const dx = x2 - x1;
        const dy = y2 - y1;
        const len = Math.hypot(dx, dy);
        if (len < 1e-9) continue;
        const nx = (-dy / len) * hw;
        const ny = (dx / len) * hw;
        polys.push([
          closeRing([
            [x1 + nx, y1 + ny],
            [x2 + nx, y2 + ny],
            [x2 - nx, y2 - ny],
            [x1 - nx, y1 - ny],
          ]),
        ]);
        polys.push([circleRing(x1, y1, hw, discSegments)]);
      }
    }
  }
  return polys.length ? normalize(polys) : [];
}

/** Regular n-gon, used for tree trunks and round pins. */
export function circleRing(cx, cy, r, segments = 12) {
  const ring = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    ring.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return closeRing(ring);
}

/* ------------------------------------------------------------------ *
 * Triangulation
 * ------------------------------------------------------------------ */

/**
 * Triangulate one polygon (outer ring + holes).
 *
 * @returns {{flat: number[], indices: number[], complete: boolean}|null}
 *   `complete` is false when earcut could not fully triangulate — see below.
 */
export function triangulatePolygon(poly) {
  const flat = [];
  const holes = [];
  const spans = []; // [startVertex, length] per ring that made it into `flat`

  for (let r = 0; r < poly.length; r++) {
    const ring = poly[r];
    // earcut wants open rings; the duplicated closing vertex creates
    // zero-area ears that show up as slivers in the output mesh.
    const end = ring.length > 1 &&
      ring[0][0] === ring[ring.length - 1][0] &&
      ring[0][1] === ring[ring.length - 1][1]
        ? ring.length - 1
        : ring.length;
    if (end < 3) continue;
    const start = flat.length / 2;
    if (spans.length > 0) holes.push(start);
    for (let i = 0; i < end; i++) flat.push(ring[i][0], ring[i][1]);
    spans.push([start, end]);
  }
  if (flat.length < 6) return null;

  let indices = earcut(flat, holes, 2);
  if (!indices.length) return null;

  const vertexCount = flat.length / 2;
  let boundary = capBoundary(indices, vertexCount);
  let complete = boundaryIsRings(boundary, spans, vertexCount);

  if (!complete) {
    // Earcut has emitted triangles outside the polygon. It does this on rings
    // that touch themselves — which boolean output produces legitimately, and
    // which a city's worth of merged road buffers produces constantly.
    //
    // Left in place these "flaps" spill a layer's colour onto whatever is next
    // to it, so they are dropped by testing each triangle's centroid against
    // the polygon. The cap may then have a small gap, but the walls are welded
    // to the boundary rather than to the rings, so the solid stays closed.
    const kept = [];
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i] * 2;
      const b = indices[i + 1] * 2;
      const c = indices[i + 2] * 2;
      const cx = (flat[a] + flat[b] + flat[c]) / 3;
      const cy = (flat[a + 1] + flat[b + 1] + flat[c + 1]) / 3;
      if (pointInPolygon([cx, cy], poly)) {
        kept.push(indices[i], indices[i + 1], indices[i + 2]);
      }
    }
    if (kept.length && kept.length < indices.length) {
      indices = kept;
      boundary = capBoundary(indices, vertexCount);
      complete = boundaryIsRings(boundary, spans, vertexCount);
    }
  }

  return { flat, indices, boundary, complete };
}

/** Inside the outer ring and outside every hole. */
function pointInPolygon(pt, poly) {
  if (!poly.length || !pointInRing(pt, poly[0])) return false;
  for (let i = 1; i < poly.length; i++) {
    if (pointInRing(pt, poly[i])) return false;
  }
  return true;
}

/**
 * Directed half-edges on the outside of a triangulation.
 *
 * These, not the input rings, are what the extruder welds side walls onto.
 * Earcut occasionally produces a boundary that is *not* the input ring — on
 * self-touching rings, which the union of many overlapping road buffers throws
 * off routinely — and walls built from the ring would then leave the solid
 * open. Reading the boundary back off the triangulation makes the result
 * watertight by construction, whatever earcut decided to do.
 *
 * A half-edge is on the boundary when it has no opposite twin; interior edges
 * always come in pairs.
 */
export function capBoundary(indices, vertexCount) {
  const counts = new Map();
  const key = (a, b) => a * vertexCount + b;

  for (let i = 0; i < indices.length; i += 3) {
    const t = [indices[i], indices[i + 1], indices[i + 2]];
    for (let e = 0; e < 3; e++) {
      const a = t[e];
      const b = t[(e + 1) % 3];
      if (a === b) continue;
      const k = key(a, b);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }

  const out = [];
  for (const [k, forward] of counts) {
    const a = Math.floor(k / vertexCount);
    const b = k % vertexCount;
    const backward = counts.get(key(b, a)) || 0;
    for (let i = 0; i < forward - backward; i++) out.push([a, b]);
  }
  return out;
}

/** Is the triangulation's boundary exactly the input rings, no more, no less? */
function boundaryIsRings(boundary, spans, vertexCount) {
  let ringEdges = 0;
  for (const [, len] of spans) ringEdges += len;
  if (boundary.length !== ringEdges) return false;

  const undirected = new Set(
    boundary.map(([a, b]) => (a < b ? a * vertexCount + b : b * vertexCount + a))
  );
  for (const [start, len] of spans) {
    for (let i = 0; i < len; i++) {
      const a = start + i;
      const b = start + ((i + 1) % len);
      if (!undirected.has(a < b ? a * vertexCount + b : b * vertexCount + a)) return false;
    }
  }
  return true;
}

/**
 * Cut a multipolygon into grid cells. Terrain draping needs top faces whose
 * triangles are small relative to the heightfield; earcut only ever emits
 * vertices on the input boundary, so a large flat region has to be pre-diced
 * or it will span hills in a single triangle.
 */
export function gridSplit(mp, cellSize, bounds) {
  if (!mp.length) return [];
  const b = bounds || boundsOf(mp);
  const cols = Math.max(1, Math.ceil((b.maxX - b.minX) / cellSize));
  const rows = Math.max(1, Math.ceil((b.maxY - b.minY) / cellSize));
  if (cols * rows > 4096) return mp; // not worth it; caller falls back to flat

  // Most polygons in a city layer are far smaller than a cell, so bucket by
  // bounding box first. Intersecting every polygon against every cell instead
  // is what turns a hilly city into a minute of boolean ops.
  const boxes = mp.map((poly) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of poly[0]) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return { minX, minY, maxX, maxY };
  });

  const out = [];
  const pending = [];

  for (let i = 0; i < mp.length; i++) {
    const box = boxes[i];
    const c0 = Math.floor((box.minX - b.minX) / cellSize);
    const c1 = Math.floor((box.maxX - b.minX) / cellSize);
    const r0 = Math.floor((box.minY - b.minY) / cellSize);
    const r1 = Math.floor((box.maxY - b.minY) / cellSize);
    // Already smaller than a cell and inside one: no dicing needed.
    if (c0 === c1 && r0 === r1) out.push(mp[i]);
    else pending.push({ poly: mp[i], c0, c1, r0, r1 });
  }

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const overlapping = pending.filter(
        (p) => c >= p.c0 && c <= p.c1 && r >= p.r0 && r <= p.r1
      );
      if (!overlapping.length) continue;

      const x0 = b.minX + c * cellSize;
      const y0 = b.minY + r * cellSize;
      const x1 = Math.min(x0 + cellSize, b.maxX);
      const y1 = Math.min(y0 + cellSize, b.maxY);
      const cell = [[[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]];

      for (const p of intersection(overlapping.map((o) => o.poly), cell)) {
        out.push(p);
      }
    }
  }
  return out.length ? out : mp;
}

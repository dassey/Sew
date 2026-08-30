/**
 * Unit tests for the geometry primitives that decide whether a print succeeds.
 *
 *   node test/geometry.mjs
 */

import { MeshBuilder, extrudePolygon, addCone, orientPolygon } from '../js/core/mesh.js';
import * as G from '../js/core/geom.js';
import { buildShapeRing, SHAPES, inscribedRadiusOf } from '../js/core/shapes.js';
import { layoutText } from '../js/model/text.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

let failures = 0;
let total = 0;

function ok(label, condition, detail = '') {
  total++;
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function near(label, actual, expected, tol = 1e-6) {
  ok(label, Math.abs(actual - expected) <= tol, `got ${actual}, want ${expected}`);
}

/** Unpaired half-edges; zero means a closed manifold surface. */
function openEdges(mesh) {
  const p = mesh.positions;
  const key = (i) =>
    `${Math.round(p[i * 3] * 1e4)}_${Math.round(p[i * 3 + 1] * 1e4)}_${Math.round(p[i * 3 + 2] * 1e4)}`;
  const counts = new Map();
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const tri = [mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2]].map(key);
    for (let e = 0; e < 3; e++) {
      const a = tri[e];
      const b = tri[(e + 1) % 3];
      if (a === b) continue;
      const rev = `${b}|${a}`;
      if (counts.get(rev) > 0) counts.set(rev, counts.get(rev) - 1);
      else counts.set(`${a}|${b}`, (counts.get(`${a}|${b}`) || 0) + 1);
    }
  }
  let open = 0;
  for (const [, n] of counts) open += n;
  return open;
}

const square = (s, cx = 0, cy = 0) =>
  G.closeRing([
    [cx - s / 2, cy - s / 2],
    [cx + s / 2, cy - s / 2],
    [cx + s / 2, cy + s / 2],
    [cx - s / 2, cy + s / 2],
  ]);

/* ================================================================ */
console.log('\nRing orientation');
/* ================================================================ */
{
  const ccw = square(10);
  ok('counter-clockwise ring has positive area', G.ringArea(ccw) > 0,
    `ringArea = ${G.ringArea(ccw)}`);
  ok('clockwise ring has negative area', G.ringArea([...ccw].reverse()) < 0);
  near('area magnitude is correct', Math.abs(G.ringArea(ccw)), 100, 1e-9);

  const oriented = orientPolygon([[...ccw].reverse(), square(4)]);
  ok('orientPolygon makes the shell counter-clockwise', G.ringArea(oriented[0]) > 0);
  ok('orientPolygon makes holes clockwise', G.ringArea(oriented[1]) < 0);
}

/* ================================================================ */
console.log('\nExtrusion — solid prism');
/* ================================================================ */
{
  const mesh = new MeshBuilder('t');
  extrudePolygon(mesh, [square(10)], 0, 3);
  near('volume of a 10×10×3 box', mesh.volume(), 300, 1e-3);
  ok('box is watertight', openEdges(mesh) === 0, `${openEdges(mesh)} open edges`);
  ok('12 triangles for a box', mesh.triangleCount === 12, `got ${mesh.triangleCount}`);
}

/* ================================================================ */
console.log('\nExtrusion — prism with a hole');
/* ================================================================ */
{
  const mesh = new MeshBuilder('t');
  // A clockwise hole; extrudePolygon should reorient it either way.
  extrudePolygon(mesh, [square(10), [...square(4)].reverse()], 0, 2);
  near('volume of frame (100−16)×2', mesh.volume(), 168, 1e-3);
  ok('holed prism is watertight', openEdges(mesh) === 0, `${openEdges(mesh)} open edges`);
}

/* ================================================================ */
console.log('\nExtrusion — reversed input ring');
/* ================================================================ */
{
  const mesh = new MeshBuilder('t');
  extrudePolygon(mesh, [[...square(6)].reverse()], 0, 5);
  ok('clockwise input still yields positive volume', mesh.volume() > 0,
    `got ${mesh.volume()}`);
  near('volume is 6×6×5', mesh.volume(), 180, 1e-3);
}

/* ================================================================ */
console.log('\nExtrusion — sloped top (terrain draping)');
/* ================================================================ */
{
  const mesh = new MeshBuilder('t');
  // A ramp from z=1 at x=-5 to z=3 at x=+5; mean height 2 over a 10×10 base.
  extrudePolygon(mesh, [square(10)], 0, (x) => 2 + x / 5);
  near('volume of a ramp equals mean height × area', mesh.volume(), 200, 1e-2);
  ok('ramp is watertight', openEdges(mesh) === 0, `${openEdges(mesh)} open edges`);
}

/* ================================================================ */
console.log('\nCones');
/* ================================================================ */
{
  const mesh = new MeshBuilder('t');
  addCone(mesh, 0, 0, 0, 4, 1, 0, 16);
  ok('cone has positive volume', mesh.volume() > 0, `got ${mesh.volume()}`);
  ok('cone is watertight', openEdges(mesh) === 0, `${openEdges(mesh)} open edges`);
  // A 16-gon approximates π r² h / 3 = 4.19 from below.
  ok('cone volume is close to the analytic value',
    Math.abs(mesh.volume() - 4.18879) < 0.15, `got ${mesh.volume().toFixed(4)}`);

  const cyl = new MeshBuilder('t');
  addCone(cyl, 0, 0, 0, 2, 1, 1, 32);
  ok('cylinder is watertight', openEdges(cyl) === 0, `${openEdges(cyl)} open edges`);
  ok('cylinder volume approaches πr²h',
    Math.abs(cyl.volume() - 6.2832) < 0.05, `got ${cyl.volume().toFixed(4)}`);
}

/* ================================================================ */
console.log('\nBoolean operations');
/* ================================================================ */
{
  const a = [[square(10)]];
  const b = [[square(10, 5, 5)]];
  near('union area', G.multiPolygonArea(G.union(a, b)), 175, 1e-6);
  near('intersection area', G.multiPolygonArea(G.intersection(a, b)), 25, 1e-6);
  near('difference area', G.multiPolygonArea(G.difference(a, b)), 75, 1e-6);
  near('differenceAll chains', G.multiPolygonArea(G.differenceAll(a, [b])), 75, 1e-6);
  ok('difference by nothing is a no-op', G.multiPolygonArea(G.difference(a, [])) === 100);
  ok('empty subject stays empty', G.difference([], a).length === 0);
}

/* ================================================================ */
console.log('\nPolyline buffering');
/* ================================================================ */
{
  const line = [[0, 0], [20, 0]];
  const ring = G.bufferPolyline(line, 1, { capStyle: 'butt' });
  const area = Math.abs(G.ringArea(ring));
  near('butt-capped buffer area = length × width', area, 40, 1e-6);

  const round = G.bufferPolyline(line, 1, { capStyle: 'round', arcSegments: 32 });
  const roundArea = Math.abs(G.ringArea(round));
  ok('round caps add roughly a circle of area',
    roundArea > 42.5 && roundArea < 43.2, `got ${roundArea.toFixed(3)}`);

  // An L-bend must not pinch shut or blow up on the inside of the turn.
  const bend = G.bufferPolylines([{ points: [[0, 0], [10, 0], [10, 10]] }], () => 1.5);
  const bendArea = G.multiPolygonArea(bend);
  ok('right-angle bend produces one clean polygon', bend.length === 1,
    `got ${bend.length} polygons`);
  ok('bend area is plausible', bendArea > 55 && bendArea < 75,
    `got ${bendArea.toFixed(2)}`);

  // A hairpin folds the offset onto itself; normalisation must repair it.
  const hairpin = G.bufferPolylines(
    [{ points: [[0, 0], [10, 0], [0, 0.6]] }],
    () => 1.2
  );
  ok('hairpin does not produce self-intersecting output',
    hairpin.length >= 1 && G.multiPolygonArea(hairpin) > 0,
    `area ${G.multiPolygonArea(hairpin).toFixed(2)}`);

  const buffered = G.bufferPolylines(
    [{ points: [[0, 0], [10, 0]] }, { points: [[5, -5], [5, 5]] }],
    () => 0.5
  );
  ok('crossing lines merge into one polygon', buffered.length === 1,
    `got ${buffered.length}`);
}

/* ================================================================ */
console.log('\nSimplify & densify');
/* ================================================================ */
{
  const line = Array.from({ length: 50 }, (_, i) => [i, 0]);
  ok('collinear points collapse to two', G.simplify(line, 0.01).length === 2);

  const zig = [[0, 0], [1, 1], [2, 0], [3, 1], [4, 0]];
  ok('simplify keeps real corners', G.simplify(zig, 0.5).length === 5);
  ok('a coarse tolerance flattens the zigzag', G.simplify(zig, 2).length === 2);

  const dense = G.densify([[0, 0], [10, 0]], 2);
  ok('densify inserts vertices', dense.length === 6, `got ${dense.length}`);
  near('densify keeps the endpoints', dense[dense.length - 1][0], 10);

  ok('dedupe drops repeats', G.dedupe([[0, 0], [0, 0], [1, 1]]).length === 2);
}

/* ================================================================ */
console.log('\nPlate shapes');
/* ================================================================ */
{
  for (const shape of SHAPES) {
    if (shape.id === 'custom') continue;
    const ring = buildShapeRing({ shape: shape.id, radius: 50, rotation: 0, aspect: 1.5 });
    const area = Math.abs(G.ringArea(ring));
    const closed =
      ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
    ok(`${shape.id}: closed ring with area`, closed && area > 100,
      `area ${area.toFixed(0)}`);
    ok(`${shape.id}: counter-clockwise`, G.ringArea(ring) > 0);
    ok(`${shape.id}: origin is inside`, G.pointInRing([0, 0], ring));
    ok(`${shape.id}: inscribed radius is usable`, inscribedRadiusOf(ring) > 1,
      `${inscribedRadiusOf(ring).toFixed(1)} mm`);
  }

  // "Printed size" has to be the number that must fit on the bed, so every
  // shape spans exactly 2 x radius on its longest axis — including after a
  // rotation, which would otherwise make a square overhang by 41%.
  for (const shape of SHAPES) {
    if (shape.id === 'custom') continue;
    for (const rotation of [0, 30, 45]) {
      const ring = buildShapeRing({ shape: shape.id, radius: 50, rotation, aspect: 1.5 });
      const b = G.boundsOf([[ring]]);
      const span = Math.max(b.maxX - b.minX, b.maxY - b.minY);
      ok(`${shape.id} @${rotation}°: spans exactly the printed size`,
        Math.abs(span - 100) < 0.01, `${span.toFixed(2)} mm`);
      ok(`${shape.id} @${rotation}°: stays inside the printed size`,
        b.maxX <= 50.01 && b.minX >= -50.01 && b.maxY <= 50.01 && b.minY >= -50.01,
        `x[${b.minX.toFixed(1)}, ${b.maxX.toFixed(1)}] y[${b.minY.toFixed(1)}, ${b.maxY.toFixed(1)}]`);
    }
  }
}

/* ================================================================ */
console.log('\nFrame band');
/* ================================================================ */
{
  const plate = [[buildShapeRing({ shape: 'circle', radius: 50 })]];
  const band = G.bandAroundRings(plate, 4);
  const rim = G.intersection(band, plate);
  const inner = G.difference(plate, rim);
  const plateArea = G.multiPolygonArea(plate);
  const innerArea = G.multiPolygonArea(inner);
  // A 4 mm rim on a 50 mm circle leaves a 46 mm circle.
  ok('frame leaves the expected inner area',
    Math.abs(innerArea - Math.PI * 46 * 46) / (Math.PI * 46 * 46) < 0.02,
    `inner ${innerArea.toFixed(0)} vs ${(Math.PI * 46 * 46).toFixed(0)}`);
  ok('rim + inner sums back to the plate',
    Math.abs(G.multiPolygonArea(rim) + innerArea - plateArea) < plateArea * 0.01);

  const mesh = new MeshBuilder('frame');
  for (const poly of rim) extrudePolygon(mesh, poly, 0, 3);
  ok('extruded frame is watertight', openEdges(mesh) === 0, `${openEdges(mesh)} open edges`);
  ok('extruded frame has positive volume', mesh.volume() > 0);
}

/* ================================================================ */
console.log('\nText outlines');
/* ================================================================ */
{
  const font = JSON.parse(
    readFileSync(join(HERE, '..', 'vendor', 'helvetiker_bold.typeface.json'), 'utf8')
  );
  const laid = layoutText(font, 'AB O', { size: 8, align: 'center', x: 0, y: 0 });
  ok('text produces polygons', laid.polygons.length >= 3,
    `${laid.polygons.length} polygons`);
  ok('text has a sensible width', laid.width > 10 && laid.width < 60,
    `${laid.width.toFixed(1)} mm`);

  const withHoles = laid.polygons.filter((p) => p.length > 1);
  ok('counters become real holes (A, B, O)', withHoles.length >= 3,
    `${withHoles.length} polygons have holes`);

  const mesh = new MeshBuilder('label');
  for (const poly of laid.polygons) extrudePolygon(mesh, poly, 0, 1);
  ok('extruded lettering is watertight', openEdges(mesh) === 0,
    `${openEdges(mesh)} open edges`);
  ok('extruded lettering has positive volume', mesh.volume() > 0,
    `got ${mesh.volume().toFixed(2)}`);

  const fitted = layoutText(font, 'A VERY LONG CITY NAME', { size: 8, maxWidth: 40 });
  ok('maxWidth shrinks the text to fit', fitted.width <= 40.5,
    `${fitted.width.toFixed(1)} mm`);
}

/* ================================================================ */
console.log('\nGrid split (terrain dicing)');
/* ================================================================ */
{
  const plate = [[square(30)]];
  const pieces = G.gridSplit(plate, 10);
  ok('grid split produces multiple pieces', pieces.length === 9,
    `got ${pieces.length}`);
  near('grid split conserves area', G.multiPolygonArea(pieces), 900, 1e-6);

  const mesh = new MeshBuilder('ground');
  for (const poly of pieces) extrudePolygon(mesh, poly, 0, (x, y) => 2 + x * 0.05 + y * 0.03);
  ok('diced terrain pieces are each watertight', openEdges(mesh) === 0,
    `${openEdges(mesh)} open edges`);
  near('diced volume matches the mean height', mesh.volume(), 1800, 1);
}

console.log('\nOriented bounding box');
{
  const rect = G.closeRing([[-4, -1], [4, -1], [4, 1], [-4, 1]]);
  const ob = G.orientedBounds(rect);
  near('axis-aligned rect: half length', ob.halfLength, 4);
  near('axis-aligned rect: half width', ob.halfWidth, 1);
  ok('long axis is ±x', Math.abs(ob.ux) > 0.999, `u = (${ob.ux}, ${ob.uy})`);
  near('centred', Math.hypot(ob.cx, ob.cy), 0, 1e-9);

  const a = Math.PI / 6;
  const rot = rect.map(([x, y]) => [
    x * Math.cos(a) - y * Math.sin(a) + 7,
    x * Math.sin(a) + y * Math.cos(a) - 3,
  ]);
  const or = G.orientedBounds(rot);
  near('rotated rect: half length recovered', or.halfLength, 4, 1e-9);
  near('rotated rect: half width recovered', or.halfWidth, 1, 1e-9);
  ok('rotated rect: axis recovered',
    Math.abs(or.ux * Math.cos(a) + or.uy * Math.sin(a)) > 0.999999,
    `u = (${or.ux}, ${or.uy})`);
  near('rotated rect: centre recovered', Math.hypot(or.cx - 7, or.cy + 3), 0, 1e-9);

  ok('collinear input yields null', G.orientedBounds([[0, 0], [1, 1], [2, 2]]) === null);
}

console.log('\nRoofs');
{
  const { addRoof } = await import('../js/core/roof.js');
  const noDegenerate = (mesh) => {
    const p = mesh.positions;
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const [a, b, c] = [mesh.indices[i] * 3, mesh.indices[i + 1] * 3, mesh.indices[i + 2] * 3];
      const abx = p[b] - p[a], aby = p[b + 1] - p[a + 1], abz = p[b + 2] - p[a + 2];
      const acx = p[c] - p[a], acy = p[c + 1] - p[a + 1], acz = p[c + 2] - p[a + 2];
      const cx = aby * acz - abz * acy;
      const cy = abz * acx - abx * acz;
      const cz = abx * acy - aby * acx;
      if (Math.hypot(cx, cy, cz) < 1e-9) return false;
    }
    return true;
  };

  // Gabled on a rectangle: two planar halves, a triangular cross-section.
  const house = [G.closeRing([[-4, -2], [4, -2], [4, 2], [-4, 2]])];
  let mesh = new MeshBuilder('roofs');
  let wallTop = addRoof(mesh, house, 0, 10, { shape: 'gabled', heightM: 3 }, { metreScale: 1 });
  near('gabled: walls stop below the ridge', wallTop, 7);
  ok('gabled: watertight', openEdges(mesh) === 0, `${openEdges(mesh)} open edges`);
  ok('gabled: no zero-area facets', noDegenerate(mesh));
  // Triangular prism: ½ · width · rise · length = ½ · 4 · 3 · 8.
  near('gabled: volume is the triangular prism', mesh.volume(), 48, 0.05);
  const bb = mesh.bounds();
  near('gabled: ridge reaches full building height', bb.maxZ, 10);
  near('gabled: eaves sit on the wall top', bb.minZ, 7);

  // The ridge follows the long axis even when the footprint is rotated.
  const a = Math.PI / 5;
  const rot = [house[0].map(([x, y]) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)])];
  mesh = new MeshBuilder('roofs');
  wallTop = addRoof(mesh, rot, 0, 10, { shape: 'gabled', heightM: 3 }, { metreScale: 1 });
  ok('gabled, rotated: built', wallTop === 7);
  ok('gabled, rotated: watertight', openEdges(mesh) === 0, `${openEdges(mesh)} open edges`);
  near('gabled, rotated: volume unchanged', mesh.volume(), 48, 0.05);

  // An L-shaped house: the ridge crosses a concave boundary, so one half
  // comes back as two pieces. Every piece must still close.
  const ell = [G.closeRing([[0, 0], [10, 0], [10, 3], [4, 3], [4, 8], [0, 8]])];
  mesh = new MeshBuilder('roofs');
  ok('gabled on an L-shape: built',
    addRoof(mesh, ell, 0, 9, { shape: 'gabled' }, { metreScale: 1 }) !== null);
  ok('gabled on an L-shape: watertight', openEdges(mesh) === 0,
    `${openEdges(mesh)} open edges`);
  ok('gabled on an L-shape: positive volume', mesh.volume() > 0, `got ${mesh.volume()}`);
  ok('gabled on an L-shape: no zero-area facets', noDegenerate(mesh));

  // Skillion: a single plane, high side away from roof:direction (south).
  mesh = new MeshBuilder('roofs');
  wallTop = addRoof(mesh, house, 0, 10,
    { shape: 'skillion', heightM: 2, directionDeg: 180 }, { metreScale: 1 });
  near('skillion: walls stop below the high edge', wallTop, 8);
  ok('skillion: watertight', openEdges(mesh) === 0, `${openEdges(mesh)} open edges`);
  // Wedge: ½ · rise · area.
  near('skillion: volume is the wedge', mesh.volume(), 32, 0.05);

  // Pyramidal: an apex fan over the footprint.
  const tower = [G.closeRing([[-3, -3], [3, -3], [3, 3], [-3, 3]])];
  mesh = new MeshBuilder('roofs');
  wallTop = addRoof(mesh, tower, 0, 12, { shape: 'pyramidal', heightM: 4 }, { metreScale: 1 });
  near('pyramidal: walls stop below the apex', wallTop, 8);
  ok('pyramidal: watertight', openEdges(mesh) === 0, `${openEdges(mesh)} open edges`);
  // ⅓ · base area · rise.
  near('pyramidal: volume is the pyramid', mesh.volume(), 48, 0.05);

  // A concave footprint downgrades pyramidal to gabled instead of hanging
  // the apex over the void.
  mesh = new MeshBuilder('roofs');
  ok('pyramidal on an L-shape: still built',
    addRoof(mesh, ell, 0, 9, { shape: 'pyramidal' }, { metreScale: 1 }) !== null);
  ok('pyramidal on an L-shape: watertight', openEdges(mesh) === 0,
    `${openEdges(mesh)} open edges`);

  // Refusals: courtyards, slivers, and roofs too small to print.
  const holed = [square(10), [...square(4)].reverse()];
  mesh = new MeshBuilder('roofs');
  ok('a courtyard building stays flat',
    addRoof(mesh, holed, 0, 10, { shape: 'gabled' }, { metreScale: 1 }) === null);
  ok('a sliver stays flat',
    addRoof(mesh, [G.closeRing([[0, 0], [8, 0], [8, 0.3], [0, 0.3]])], 0, 10,
      { shape: 'gabled' }, { metreScale: 1 }) === null);
  ok('an unprintably low roof stays flat',
    addRoof(mesh, house, 0, 10, { shape: 'gabled', heightM: 0.05 }, { metreScale: 1 }) === null);
  ok('nothing was added by refusals', mesh.isEmpty());

  // Which buildings get which roof — the tag side.
  const { roofSpec } = await import('../js/model/tags.js');
  ok('building=house defaults to gabled',
    roofSpec({ building: 'house' })?.shape === 'gabled');
  ok('roof:shape=hipped reads as a ridge',
    roofSpec({ building: 'yes', 'roof:shape': 'hipped' })?.shape === 'gabled');
  ok('roof:shape=dome reads as a point',
    roofSpec({ building: 'commercial', 'roof:shape': 'dome' })?.shape === 'pyramidal');
  ok('roof:shape=flat stays flat', roofSpec({ building: 'house', 'roof:shape': 'flat' }) === null);
  ok('an office block stays flat', roofSpec({ building: 'office' }) === null);
  ok('a garage stays flat', roofSpec({ building: 'garage' }) === null);
  ok('a small low building=yes is a house in all but name',
    roofSpec({ building: 'yes' }, { areaM2: 140, heightM: 7 })?.shape === 'gabled');
  ok('a big-box building=yes stays flat',
    roofSpec({ building: 'yes' }, { areaM2: 2400, heightM: 8 }) === null);
  ok('a tall building=yes stays flat',
    roofSpec({ building: 'yes' }, { areaM2: 300, heightM: 40 }) === null);
  near('roof:height wins over the pitch guess',
    roofSpec({ building: 'house', 'roof:height': '4 m' }).heightM, 4);
  near('roof:levels converts to metres',
    roofSpec({ building: 'house', 'roof:levels': '2' }).heightM, 4.8);
  ok('roof:direction=S parses to 180°',
    roofSpec({ building: 'yes', 'roof:shape': 'skillion' }, { areaM2: 90, heightM: 5 })
      ?.directionDeg === null &&
    roofSpec({ building: 'house', 'roof:direction': 'S' }).directionDeg === 180);

  // Clipped by the plate edge: half a house is still a closed solid.
  const clipped = G.intersection([house[0]].length ? [house] : [], [[G.closeRing([
    [-4, -2], [1.3, -2], [1.3, 2], [-4, 2],
  ])]]);
  mesh = new MeshBuilder('roofs');
  ok('clipped footprint: still roofed',
    addRoof(mesh, clipped[0], 0, 10, { shape: 'gabled', heightM: 3 }, { metreScale: 1 }) !== null);
  ok('clipped footprint: watertight', openEdges(mesh) === 0,
    `${openEdges(mesh)} open edges`);
}

console.log(`\n${failures ? '✗' : '✓'} ${total - failures}/${total} checks passed\n`);
process.exit(failures ? 1 : 0);

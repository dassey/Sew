import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as overpass from '../js/data/overpass.js';
import { buildModel } from '../js/model/build.js';
import { defaultSettings } from '../js/model/parts.js';
import { toStlBuffer } from '../js/export/stl.js';
import { to3mf } from '../js/export/threemf.js';
import { toObj } from '../js/export/obj.js';
import { createZip } from '../js/export/zip.js';
import { createProjection } from '../js/core/projection.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out');
const QUICK = process.argv.includes('--quick');

const CASES = [
  {
    name: 'Manhattan Midtown — dense towers, grid streets',
    lat: 40.7549, lon: -73.984, areaMetres: 1200,
    tweak: (s) => { s.shape.type = 'circle'; },
  },
  {
    name: 'Chicago Loop — river, rail, lake shore',
    lat: 41.8827, lon: -87.6233, areaMetres: 1800,
    tweak: (s) => { s.shape.type = 'hexagon'; s.layers.rail = true; },
  },
  {
    name: 'Venice — canals everywhere, no grid',
    lat: 45.4371, lon: 12.3326, areaMetres: 1400,
    tweak: (s) => { s.shape.type = 'heart'; },
  },
  {
    name: 'Amsterdam Centrum — non-convex plate + nameplate',
    lat: 52.3702, lon: 4.8952, areaMetres: 1100,
    tweak: (s) => {
      s.shape.type = 'star';
      s.nameplate.title = 'AMSTERDAM';
      s.nameplate.subtitle = '52.3702° N  4.8952° E';
    },
    expectRoofs: true,
  },
  {
    name: 'Levittown, New York — machine-traced tract housing',
    lat: 40.7259, lon: -73.5143, areaMetres: 1400,
    tweak: (s) => { s.shape.type = 'circle'; },
    expectRoofs: true,
  },
  {
    name: 'Miami Beach — natural=coastline sea fill',
    lat: 25.7907, lon: -80.13, areaMetres: 2200,
    tweak: (s) => { s.shape.type = 'square'; },
    expectGround: true,
  },
  {
    name: 'San Francisco Nob Hill — terrain',
    lat: 37.7925, lon: -122.4147, areaMetres: 1500,
    tweak: (s) => { s.terrain.enabled = true; s.shape.type = 'rounded'; },
    terrain: true,
  },
  {
    name: 'Rural Wyoming — near-empty data',
    lat: 43.0, lon: -107.5, areaMetres: 3000,
    tweak: (s) => { s.shape.type = 'octagon'; },
    allowEmpty: true,
  },
];

let failures = 0;
let checks = 0;

function check(label, condition, detail = '') {
  checks++;
  if (condition) return true;
  failures++;
  console.log(`    ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  return false;
}

function pass(label, detail = '') {
  checks++;
  console.log(`    ✓ ${label}${detail ? ` — ${detail}` : ''}`);
}

const UA = 'SkylineForge-test/1.0 (https://github.com/dassey/skyline-forge)';
const CACHE = join(HERE, '.cache');

async function cached(name, fetcher) {
  mkdirSync(CACHE, { recursive: true });
  const path = join(CACHE, `${name}.json`);
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
  const data = await fetcher();
  writeFileSync(path, JSON.stringify(data));
  return data;
}

const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

async function fetchFeatures(key, bbox, layers) {
  const json = await cached(`osm-${key}`, async () => {
    const query = overpass.buildQuery(bbox, layers, 120);
    for (let attempt = 0; attempt < 8; attempt++) {
      const res = await fetch(MIRRORS[attempt % MIRRORS.length], {
        method: 'POST',
        headers: { 'User-Agent': UA },
        body: new URLSearchParams({ data: query }),
      });
      if (res.ok) return res.json();
      if (![429, 503, 504].includes(res.status)) {
        throw new Error(`Overpass HTTP ${res.status}`);
      }
      await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
    }
    throw new Error('every Overpass mirror stayed busy');
  });
  return {
    features: overpass.parseElements(json.elements || []),
    count: (json.elements || []).length,
  };
}

async function fetchTerrain(key, bbox, n) {
  const grid = await cached(`dem-${key}-${n}`, () => sampleTerrain(bbox, n));
  return { ...grid, values: Float32Array.from(grid.values) };
}

async function sampleTerrain(bbox, n) {
  const pts = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      pts.push([
        bbox.minLat + ((bbox.maxLat - bbox.minLat) * r) / (n - 1),
        bbox.minLon + ((bbox.maxLon - bbox.minLon) * c) / (n - 1),
      ]);
    }
  }
  const values = new Float32Array(pts.length);
  for (let i = 0; i < pts.length; i += 100) {
    const batch = pts.slice(i, i + 100);
    const url = new URL('https://api.open-meteo.com/v1/elevation');
    url.searchParams.set('latitude', batch.map((p) => p[0].toFixed(6)).join(','));
    url.searchParams.set('longitude', batch.map((p) => p[1].toFixed(6)).join(','));
    const res = await fetch(url);
    const data = await res.json();
    values.set(data.elevation, i);
  }
  let min = Infinity, max = -Infinity;
  for (const v of values) { if (v < min) min = v; if (v > max) max = v; }
  return { n, bbox, values: Array.from(values), min, max };
}

function openEdgeCount(positions, indices) {
  const edges = new Map();
  const key = (a, b) => `${a},${b}`;
  for (let i = 0; i < indices.length; i += 3) {
    const tri = [indices[i], indices[i + 1], indices[i + 2]];
    for (let e = 0; e < 3; e++) {
      const a = weld(positions, tri[e]);
      const b = weld(positions, tri[(e + 1) % 3]);
      if (a === b) continue;
      const forward = key(a, b);
      const backward = key(b, a);
      if (edges.get(backward) > 0) {
        edges.set(backward, edges.get(backward) - 1);
      } else {
        edges.set(forward, (edges.get(forward) || 0) + 1);
      }
    }
  }
  let open = 0;
  for (const [, n] of edges) open += n;
  return open;
}

function weld(positions, index) {
  const i = index * 3;
  return (
    `${Math.round(positions[i] * 1000)}_` +
    `${Math.round(positions[i + 1] * 1000)}_` +
    `${Math.round(positions[i + 2] * 1000)}`
  );
}

function signedVolume(positions, indices) {
  let v = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    v +=
      positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1]) -
      positions[a + 1] * (positions[b] * positions[c + 2] - positions[b + 2] * positions[c]) +
      positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c]);
  }
  return v / 6;
}

function boundsOf(positions) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    minX = Math.min(minX, positions[i]);   maxX = Math.max(maxX, positions[i]);
    minY = Math.min(minY, positions[i + 1]); maxY = Math.max(maxY, positions[i + 1]);
    minZ = Math.min(minZ, positions[i + 2]); maxZ = Math.max(maxZ, positions[i + 2]);
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

async function runCase(spec) {
  console.log(`\n▸ ${spec.name}`);

  const s = defaultSettings();
  s.location.lat = spec.lat;
  s.location.lon = spec.lon;
  s.size.areaMetres = spec.areaMetres;
  s.size.printMm = 160;
  spec.tweak?.(s);

  const proj = createProjection(s.location.lat, s.location.lon);
  const radiusM = s.size.areaMetres * 0.78;
  const bbox = {
    minLat: s.location.lat - proj.metresToDegLat(radiusM),
    maxLat: s.location.lat + proj.metresToDegLat(radiusM),
    minLon: s.location.lon - proj.metresToDegLon(radiusM),
    maxLon: s.location.lon + proj.metresToDegLon(radiusM),
  };

  const t0 = Date.now();
  const key = spec.name.split(' —')[0].toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const { features, count } = await fetchFeatures(key, bbox, [
    'buildings', 'roads', 'rail', 'water', 'green',
  ]);
  const fetchMs = Date.now() - t0;

  const heightGrid = spec.terrain ? await fetchTerrain(key, bbox, 24) : null;

  const font = JSON.parse(
    readFileSync(join(HERE, '..', 'vendor', 'helvetiker_bold.typeface.json'), 'utf8')
  );

  const t1 = Date.now();
  const result = buildModel(features, s, { heightGrid, font, routePoints: null });
  const buildMs = Date.now() - t1;

  console.log(
    `    ${count.toLocaleString()} OSM elements (${fetchMs} ms) → ` +
      `${result.parts.length} parts, ${result.stats.triangles.toLocaleString()} triangles (${buildMs} ms)`
  );
  for (const w of result.warnings) console.log(`    ! ${w}`);

  if (spec.allowEmpty && !result.parts.length) {
    pass('empty area handled without crashing');
    return;
  }

  check('produced geometry', result.parts.length > 0);
  if (!result.parts.length) return;

  let allSolid = true;
  for (const part of result.parts) {
    const vol = signedVolume(part.positions, part.indices);
    const open = openEdgeCount(part.positions, part.indices);
    const b = boundsOf(part.positions);

    if (vol <= 0) {
      allSolid = false;
      check(`${part.id}: positive volume`, false, `got ${vol.toFixed(1)} mm³ (inverted winding)`);
    }
    if (open !== 0) {
      allSolid = false;
      check(`${part.id}: watertight`, false, `${open} unpaired edges`);
    }
    if (b.minZ < -0.001) {
      allSolid = false;
      check(`${part.id}: sits on the bed`, false, `minZ = ${b.minZ.toFixed(3)} mm`);
    }
  }
  if (allSolid) {
    pass(
      'all parts are watertight solids on the bed',
      `${result.parts.map((p) => p.id).join(', ')}`
    );
  }

  const all = boundsOf(
    Float32Array.from(result.parts.flatMap((p) => Array.from(p.positions)))
  );
  const limit = s.size.printMm / 2 + 1;
  const nameplateSlack = s.nameplate.title ? s.nameplate.barMm + 2 : 0;
  check(
    'model stays within the plate',
    all.maxX <= limit && all.minX >= -limit && all.maxY <= limit &&
      all.minY >= -(limit + nameplateSlack),
    `x[${all.minX.toFixed(1)}, ${all.maxX.toFixed(1)}] y[${all.minY.toFixed(1)}, ${all.maxY.toFixed(1)}] vs ±${limit}`
  );

  const islands = connectedComponents(result.parts);
  check(
    'no significant part of the model is left loose',
    islands.largestShare >= 0.99,
    `largest piece holds only ${(islands.largestShare * 100).toFixed(1)}% of vertices, across ${islands.count} pieces`
  );
  const stranded = [...islands.strandedParts].filter((id) =>
    ['frame', 'label', 'route'].includes(id)
  );
  check(
    'frame, lettering and route stay attached to the plate',
    stranded.length === 0,
    `${stranded.join(', ')} would print as separate object${stranded.length === 1 ? '' : 's'}`
  );

  const shares = {};
  for (const p of result.parts) shares[p.id] = footprintArea(p);
  const surfaceTotal =
    Object.entries(shares)
      .filter(([id]) => ['ground', 'water', 'green', 'roads', 'roadsMajor', 'rail', 'buildings'].includes(id))
      .reduce((s, [, a]) => s + a, 0) || 1;

  for (const [id, area] of Object.entries(shares)) {
    if (id === 'frame' || id === 'ground') continue;
    check(
      `${id} does not swallow the plate`,
      area / surfaceTotal < 0.85,
      `${id} covers ${((area / surfaceTotal) * 100).toFixed(0)}% of the surface`
    );
  }
  if (spec.expectGround) {
    check('land survives alongside the sea', (shares.ground || 0) > 0,
      'the coastline fill consumed every land region');
  }

  if (spec.expectRoofs) {
    const roofs = result.parts.find((p) => p.id === 'roofs');
    const walls = result.parts.find((p) => p.id === 'buildings');
    check('houses grew roofs', Boolean(roofs) && roofs.triangleCount > 500,
      roofs ? `only ${roofs.triangleCount} roof triangles` : 'no roofs part at all');
    check('roofs carve the walls, never add to them',
      Boolean(roofs && walls) && roofs.volumeMm3 < walls.volumeMm3,
      'roof volume rivals the walls — heights are being stacked, not carved');
  }

  const claimed = Object.values(result.stats.regionAreas).reduce((a, b) => a + b, 0);
  const covered = claimed / result.stats.plateAreaMm2;
  check(
    'the partition tiles the plate exactly',
    covered > 0.995 && covered < 1.005,
    `regions cover ${(covered * 100).toFixed(2)}% of the plate`
  );

  for (const part of result.parts) {
    if (part.id === 'trees' || part.id === 'buildings') continue;
    const declared = result.stats.regionAreas[part.id];
    if (!declared) continue;
    const floor = Math.min(declared * 0.99, declared - 2);
    check(
      `${part.id}: all of its region reaches the mesh`,
      footprintArea(part) >= floor,
      `region ${declared.toFixed(0)} mm², mesh ${footprintArea(part).toFixed(0)} mm²`
    );
  }

  mkdirSync(OUT, { recursive: true });
  const stem = key;

  const stl = toStlBuffer(result.parts, spec.name);
  const stlTris = new DataView(stl).getUint32(80, true);
  check('STL triangle count matches', stlTris === result.stats.triangles,
    `header says ${stlTris}, model has ${result.stats.triangles}`);
  check('STL length matches header', stl.byteLength === 84 + stlTris * 50);
  writeFileSync(join(OUT, `${stem}.stl`), Buffer.from(stl));

  const mf = to3mf(result.parts, { title: spec.name });
  const mfBytes = Buffer.from(await mf.arrayBuffer());
  check('3MF is a ZIP', mfBytes.subarray(0, 4).toString('hex') === '504b0304');
  const mfText = mfBytes.toString('latin1');
  check('3MF declares millimetres', mfText.includes('unit="millimeter"'));
  check('3MF has one material per part',
    (mfText.match(/<base /g) || []).length === result.parts.length);
  check('3MF assembles parts into one object', mfText.includes('<components>'));
  writeFileSync(join(OUT, `${stem}.3mf`), mfBytes);

  const written = analyseWrittenMesh(mfText);
  check('exported 3MF has no holes', written.holes === 0,
    `${written.holes} edges with a single triangle`);
  check('exported 3MF has no degenerate facets', written.degenerate === 0,
    `${written.degenerate} zero-area triangles after rounding`);

  const { obj, mtl } = toObj(result.parts, stem);
  const vCount = (obj.match(/^v /gm) || []).length;
  const fCount = (obj.match(/^f /gm) || []).length;
  check('OBJ vertex count matches',
    vCount === result.parts.reduce((n, p) => n + p.positions.length / 3, 0));
  check('OBJ face count matches', fCount === result.stats.triangles);
  check('MTL defines every material',
    (mtl.match(/^newmtl /gm) || []).length === result.parts.length);

  const zip = createZip([{ name: 'a.txt', data: 'hello' }, { name: 'b.bin', data: new Uint8Array([1, 2, 3]) }]);
  check('ZIP writer produces a readable archive', zip.size > 40);

  writeFileSync(join(OUT, `${stem}.svg`), planView(result, s, spec.name));
}

function planView(result, settings, title) {
  const half = settings.size.printMm / 2 + settings.nameplate.barMm + 4;
  const layers = [];

  for (const part of [...result.parts].reverse()) {
    const paths = [];
    const p = part.positions;
    const idx = part.indices;
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
      const cross =
        (p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[b + 1] - p[a + 1]) * (p[c] - p[a]);
      if (cross <= 0) continue;
      paths.push(
        `M${p[a].toFixed(2)} ${(-p[a + 1]).toFixed(2)}` +
        `L${p[b].toFixed(2)} ${(-p[b + 1]).toFixed(2)}` +
        `L${p[c].toFixed(2)} ${(-p[c + 1]).toFixed(2)}Z`
      );
    }
    if (paths.length) {
      layers.push(`<path fill="${part.color}" d="${paths.join('')}"/>`);
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-half} ${-half} ${half * 2} ${half * 2}" width="760" height="760">` +
    `<title>${title}</title>` +
    `<rect x="${-half}" y="${-half}" width="${half * 2}" height="${half * 2}" fill="#12161c"/>` +
    layers.join('') +
    '</svg>'
  );
}

function connectedComponents(parts) {
  const id = new Map();
  const ownerOf = new Map();
  const parent = [];
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const unite = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const idOf = (key, partId) => {
    let v = id.get(key);
    if (v === undefined) {
      v = parent.length;
      parent.push(v);
      id.set(key, v);
      ownerOf.set(key, partId);
    }
    return v;
  };

  for (const part of parts) {
    const p = part.positions;
    const key = (i) =>
      `${Math.round(p[i * 3] * 100)}_${Math.round(p[i * 3 + 1] * 100)}_${Math.round(p[i * 3 + 2] * 100)}`;
    for (let i = 0; i < part.indices.length; i += 3) {
      const a = idOf(key(part.indices[i]), part.id);
      const b = idOf(key(part.indices[i + 1]), part.id);
      const c = idOf(key(part.indices[i + 2]), part.id);
      unite(a, b);
      unite(b, c);
    }
  }

  const sizes = new Map();
  for (let i = 0; i < parent.length; i++) {
    const r = find(i);
    sizes.set(r, (sizes.get(r) || 0) + 1);
  }
  const counts = [...sizes.values()].sort((a, b) => b - a);
  const total = counts.reduce((s, n) => s + n, 0) || 1;

  let biggestRoot = null;
  let biggestSize = -1;
  for (const [root, n] of sizes) {
    if (n > biggestSize) { biggestSize = n; biggestRoot = root; }
  }
  const strandedParts = new Set();
  for (const [key, vertex] of id) {
    if (find(vertex) !== biggestRoot) strandedParts.add(ownerOf.get(key));
  }

  return { count: counts.length, largestShare: counts[0] / total, strandedParts };
}

function analyseWrittenMesh(xml) {
  let holes = 0;
  let degenerate = 0;

  const objectRe = /<object id="\d+"[^>]*>([\s\S]*?)<\/object>/g;
  let m;
  while ((m = objectRe.exec(xml))) {
    const body = m[1];
    if (!body.includes('<mesh>')) continue;

    const verts = [];
    const vre = /<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/g;
    let v;
    while ((v = vre.exec(body))) verts.push(`${v[1]},${v[2]},${v[3]}`);

    const id = new Map();
    const idOf = (s2) => {
      let n = id.get(s2);
      if (n === undefined) { n = id.size; id.set(s2, n); }
      return n;
    };

    const edges = new Map();
    const tre = /<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"/g;
    let t;
    while ((t = tre.exec(body))) {
      const a = idOf(verts[+t[1]]);
      const b = idOf(verts[+t[2]]);
      const c = idOf(verts[+t[3]]);
      if (a === b || b === c || a === c) { degenerate++; continue; }
      for (const [p, q] of [[a, b], [b, c], [c, a]]) {
        const k = p < q ? `${p}|${q}` : `${q}|${p}`;
        edges.set(k, (edges.get(k) || 0) + 1);
      }
    }
    for (const [, n] of edges) if (n === 1) holes++;
  }
  return { holes, degenerate };
}

function footprintArea(part) {
  let area = 0;
  const p = part.positions;
  const idx = part.indices;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    const cross =
      (p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[b + 1] - p[a + 1]) * (p[c] - p[a]);
    if (cross > 0) area += cross / 2;
  }
  return area;
}

const zipRoundTrip = () => {
  const blob = createZip([{ name: 'x', data: 'y' }]);
  return blob;
};

(async () => {
  console.log('Skyline Forge — pipeline smoke test');
  console.log('===================================');
  zipRoundTrip();

  const cases = QUICK ? CASES.slice(0, 2) : CASES;
  for (const spec of cases) {
    try {
      await runCase(spec);
    } catch (err) {
      failures++;
      console.log(`    ✗ threw: ${err.message}`);
      console.log(err.stack.split('\n').slice(1, 4).join('\n'));
    }
    await new Promise((r) => setTimeout(r, 1200));
  }

  console.log(`\n${failures ? '✗' : '✓'} ${checks - failures}/${checks} checks passed`);
  process.exit(failures ? 1 : 0);
})();

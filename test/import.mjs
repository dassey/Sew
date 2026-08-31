import { createZip } from '../js/export/zip.js';
import { readShp, readDbf, combine, ringsToPolygons } from '../js/data/import/shapefile.js';
import { readGeoJson } from '../js/data/import/geojson.js';
import { unzip, findByExtension } from '../js/data/import/unzip.js';
import { importFile, guessHeightMapping, guessNameField } from '../js/data/import/index.js';
import { applyImports, defaultMapping, heightInMetres, heightSummary } from '../js/data/import/merge.js';
import { buildModel } from '../js/model/build.js';
import { defaultSettings } from '../js/model/parts.js';

let failures = 0;
let total = 0;

function ok(label, condition, detail = '') {
  total++;
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
function near(label, actual, expected, tol) {
  ok(label, Math.abs(actual - expected) <= tol, `got ${actual}, want ${expected} ±${tol}`);
}

function writeShp(polygons) {
  const records = [];
  let bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };

  polygons.forEach((poly, index) => {
    const rings = [reverse(poly.outer), ...(poly.holes || []).map(reverse)];
    const pointCount = rings.reduce((n, r) => n + r.length, 0);
    const content = 44 + 4 * rings.length + 16 * pointCount;
    const buffer = new ArrayBuffer(8 + content);
    const view = new DataView(buffer);

    view.setInt32(0, index + 1, false);
    view.setInt32(4, content / 2, false);
    view.setInt32(8, 5, true);

    const box = ringBounds(rings);
    bounds = {
      minX: Math.min(bounds.minX, box.minX), minY: Math.min(bounds.minY, box.minY),
      maxX: Math.max(bounds.maxX, box.maxX), maxY: Math.max(bounds.maxY, box.maxY),
    };
    view.setFloat64(12, box.minX, true);
    view.setFloat64(20, box.minY, true);
    view.setFloat64(28, box.maxX, true);
    view.setFloat64(36, box.maxY, true);
    view.setInt32(44, rings.length, true);
    view.setInt32(48, pointCount, true);

    let at = 52;
    let start = 0;
    for (const ring of rings) {
      view.setInt32(at, start, true);
      at += 4;
      start += ring.length;
    }
    for (const ring of rings) {
      for (const [x, y] of ring) {
        view.setFloat64(at, x, true);
        view.setFloat64(at + 8, y, true);
        at += 16;
      }
    }
    records.push(new Uint8Array(buffer));
  });

  const bodyLength = records.reduce((n, r) => n + r.length, 0);
  const file = new Uint8Array(100 + bodyLength);
  const header = new DataView(file.buffer, 0, 100);
  header.setInt32(0, 9994, false);
  header.setInt32(24, (100 + bodyLength) / 2, false);
  header.setInt32(28, 1000, true);
  header.setInt32(32, 5, true);
  header.setFloat64(36, bounds.minX, true);
  header.setFloat64(44, bounds.minY, true);
  header.setFloat64(52, bounds.maxX, true);
  header.setFloat64(60, bounds.maxY, true);

  let at = 100;
  for (const record of records) {
    file.set(record, at);
    at += record.length;
  }
  return file;
}

function reverse(ring) {
  return ring.slice().reverse();
}

function ringBounds(rings) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX, maxY };
}

function writeDbf(fields, rows) {
  const headerLength = 32 + 32 * fields.length + 1;
  const recordLength = 1 + fields.reduce((n, f) => n + f.length, 0);
  const file = new Uint8Array(headerLength + rows.length * recordLength + 1);
  const view = new DataView(file.buffer);

  file[0] = 0x03;
  file[1] = 125; file[2] = 1; file[3] = 1;
  view.setUint32(4, rows.length, true);
  view.setUint16(8, headerLength, true);
  view.setUint16(10, recordLength, true);

  const ascii = (text, length) => {
    const out = new Uint8Array(length);
    for (let i = 0; i < Math.min(text.length, length); i++) out[i] = text.charCodeAt(i) & 0xff;
    return out;
  };

  fields.forEach((field, i) => {
    const at = 32 + i * 32;
    file.set(ascii(field.name, 11), at);
    file[at + 11] = field.type.charCodeAt(0);
    file[at + 16] = field.length;
    file[at + 17] = field.type === 'N' ? 2 : 0;
  });
  file[32 + fields.length * 32] = 0x0d;

  let at = headerLength;
  for (const row of rows) {
    file[at++] = 0x20;
    for (const field of fields) {
      const raw = row[field.name];
      const text = raw === null || raw === undefined ? '' : String(raw);
      const padded = field.type === 'N' ? text.padStart(field.length) : text.padEnd(field.length);
      file.set(ascii(padded, field.length), at);
      at += field.length;
    }
  }
  file[at] = 0x1a;
  return file;
}

const MO_WEST_PRJ =
  'PROJCS["NAD83 / UTM zone 18N",GEOGCS["NAD83",DATUM["North_American_Datum_1983",' +
  'SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],' +
  'UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],' +
  'PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",-75],' +
  'PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],' +
  'PARAMETER["false_northing",0],UNIT["metre",1]]';

function buildingGrid(originX, originY, cols, rows, step = 30, size = 14) {
  const polygons = [];
  const attributes = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = originX + c * step;
      const y = originY + r * step;
      polygons.push({
        outer: [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]],
      });
      attributes.push({
        HEIGHT: 4 + ((r * cols + c) % 9) * 2.5,
        STORIES: 1 + ((r * cols + c) % 4),
        ADDRESS: `${100 + r * cols + c} Test Street`,
      });
    }
  }
  return { polygons, attributes };
}

async function shapefileZip({ withPrj = true, deflate = false } = {}) {
  const { polygons, attributes } = buildingGrid(500000, 4511000, 6, 6);
  const shp = writeShp(polygons);
  const dbf = writeDbf(
    [
      { name: 'HEIGHT', type: 'N', length: 10 },
      { name: 'STORIES', type: 'N', length: 4 },
      { name: 'ADDRESS', type: 'C', length: 24 },
    ],
    attributes
  );

  const entries = [
    { name: 'parcels/buildings.shp', data: shp },
    { name: 'parcels/buildings.dbf', data: dbf },
  ];
  if (withPrj) entries.push({ name: 'parcels/buildings.prj', data: MO_WEST_PRJ });

  if (!deflate) {
    const blob = createZip(entries);
    return new Uint8Array(await blob.arrayBuffer());
  }
  return deflateZip(entries);
}

async function deflateZip(entries) {
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (bytes) => {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  const prepared = [];
  for (const entry of entries) {
    const raw = typeof entry.data === 'string' ? new TextEncoder().encode(entry.data) : entry.data;
    const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    const packed = new Uint8Array(await new Response(stream).arrayBuffer());
    prepared.push({ name: new TextEncoder().encode(entry.name), raw, packed, crc: crc32(raw) });
  }

  const localSize = prepared.reduce((n, e) => n + 30 + e.name.length + e.packed.length, 0);
  const centralSize = prepared.reduce((n, e) => n + 46 + e.name.length, 0);
  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);
  let at = 0;
  const offsets = [];

  for (const e of prepared) {
    offsets.push(at);
    view.setUint32(at, 0x04034b50, true);
    view.setUint16(at + 4, 20, true);
    view.setUint16(at + 6, 0, true);
    view.setUint16(at + 8, 8, true);
    view.setUint32(at + 14, e.crc, true);
    view.setUint32(at + 18, e.packed.length, true);
    view.setUint32(at + 22, e.raw.length, true);
    view.setUint16(at + 26, e.name.length, true);
    out.set(e.name, at + 30);
    out.set(e.packed, at + 30 + e.name.length);
    at += 30 + e.name.length + e.packed.length;
  }

  const centralStart = at;
  prepared.forEach((e, i) => {
    view.setUint32(at, 0x02014b50, true);
    view.setUint16(at + 4, 20, true);
    view.setUint16(at + 6, 20, true);
    view.setUint16(at + 10, 8, true);
    view.setUint32(at + 16, e.crc, true);
    view.setUint32(at + 20, e.packed.length, true);
    view.setUint32(at + 24, e.raw.length, true);
    view.setUint16(at + 28, e.name.length, true);
    view.setUint32(at + 42, offsets[i], true);
    out.set(e.name, at + 46);
    at += 46 + e.name.length;
  });

  view.setUint32(at, 0x06054b50, true);
  view.setUint16(at + 8, prepared.length, true);
  view.setUint16(at + 10, prepared.length, true);
  view.setUint32(at + 12, at - centralStart, true);
  view.setUint32(at + 16, centralStart, true);
  return out;
}

console.log('\nZIP reader');
{
  const stored = await shapefileZip();
  const files = await unzip(stored.buffer);
  ok('reads stored entries', files.size === 3, `${files.size} files`);
  ok('finds files by extension regardless of folder', Boolean(findByExtension(files, 'shp')));
  ok('is case-insensitive about extensions', Boolean(findByExtension(files, 'SHP')));

  const compressed = await shapefileZip({ deflate: true });
  const inflated = await unzip(compressed.buffer);
  ok('inflates deflate entries', inflated.size === 3);
  ok('inflated bytes match stored bytes',
    inflated.get('parcels/buildings.shp').length === files.get('parcels/buildings.shp').length);
}

console.log('\nShapefile reader');
{
  const { polygons, attributes } = buildingGrid(500000, 4511000, 3, 2);
  const shp = readShp(writeShp(polygons));
  ok('reads every record', shp.shapes.length === 6, `${shp.shapes.length}`);
  ok('records are areas', shp.shapes.every((s) => s.kind === 'area'));

  const dbf = readDbf(writeDbf(
    [
      { name: 'HEIGHT', type: 'N', length: 10 },
      { name: 'STORIES', type: 'N', length: 4 },
      { name: 'ADDRESS', type: 'C', length: 24 },
    ],
    attributes
  ));
  ok('reads the field list', dbf.fields.map((f) => f.name).join(',') === 'HEIGHT,STORIES,ADDRESS',
    dbf.fields.map((f) => f.name).join(','));
  ok('reads one row per record', dbf.rows.length === 6);
  ok('numeric fields come back as numbers', typeof dbf.rows[0].HEIGHT === 'number');
  near('numeric values survive the round trip', dbf.rows[1].HEIGHT, attributes[1].HEIGHT, 0.01);
  ok('text fields are trimmed', dbf.rows[0].ADDRESS === '100 Test Street', `"${dbf.rows[0].ADDRESS}"`);

  const features = combine(shp, dbf);
  ok('geometry and attributes line up', features.length === 6 &&
    features[3].properties.ADDRESS === '103 Test Street');

  const polys = ringsToPolygons(features[0].parts);
  ok('a clockwise ring is read as an outer ring', polys.length === 1 && polys[0].holes.length === 0);

  const withHole = writeShp([{
    outer: [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]],
    holes: [[[40, 40], [40, 60], [60, 60], [60, 40], [40, 40]]],
  }]);
  const holed = ringsToPolygons(readShp(withHole).shapes[0].parts);
  ok('holes are detected by winding', holed.length === 1 && holed[0].holes.length === 1,
    `${holed.length} polygons, ${holed[0]?.holes.length} holes`);
}

console.log('\nProjected shapefile end to end');
{
  const zip = await shapefileZip();
  const dataset = await importFile(new File([zip], 'clay-county-buildings.zip'));

  ok('detects the format', dataset.format === 'Shapefile', dataset.format);
  ok('reads the projection name', dataset.crsName === 'NAD83 / UTM zone 18N', String(dataset.crsName));
  ok('reprojects to lat/lon', dataset.reprojected === true);
  ok('imports every feature', dataset.count === 36, `${dataset.count}`);
  ok('classifies as areas', dataset.kind === 'area', dataset.kind);

  near('longitude lands on the central meridian', dataset.bbox.minLon, -75, 0.01);
  ok('latitude lands where the northing says',
    dataset.bbox.minLat > 40.6 && dataset.bbox.minLat < 40.9, `${dataset.bbox.minLat}`);
  ok('the footprint is metres across, not degrees',
    (dataset.bbox.maxLon - dataset.bbox.minLon) < 0.01);

  const fields = dataset.fields.map((f) => `${f.name}:${f.type}`).join(' ');
  ok('describes the attribute table', fields.includes('HEIGHT:number') && fields.includes('ADDRESS:text'), fields);

  const guess = guessHeightMapping(dataset.fields);
  ok('guesses the height field', guess.field === 'HEIGHT', String(guess.field));
  ok('guesses metres for values in the tens', guess.unit === 'm', guess.unit);
  ok('guesses the name field', guessNameField(dataset.fields) === 'ADDRESS', String(guessNameField(dataset.fields)));
}

console.log('\nRejecting data that cannot be placed');
{
  const zip = await shapefileZip({ withPrj: false });
  let message = '';
  try {
    await importFile(new File([zip], 'no-prj.zip'));
  } catch (err) {
    message = err.message;
  }
  ok('projected data without a .prj is refused rather than misplaced',
    /projection/i.test(message), `"${message}"`);
  ok('the message says what to do', /\.prj|EPSG:4326/i.test(message));
}

console.log('\nGeoJSON');
{
  const geo = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { name: 'Block', levels: 3 },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [[-73.98, 40.73], [-73.979, 40.73], [-73.979, 40.731], [-73.98, 40.731], [-73.98, 40.73]],
            [[-73.9798, 40.7304], [-73.9796, 40.7304], [-73.9796, 40.7306], [-73.9798, 40.7306], [-73.9798, 40.7304]],
          ],
        },
      },
      {
        type: 'Feature',
        properties: { name: 'Path' },
        geometry: { type: 'LineString', coordinates: [[-73.98, 40.73], [-73.975, 40.735]] },
      },
      { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [-73.977, 40.732] } },
    ],
  };
  const parsed = readGeoJson(JSON.stringify(geo));
  ok('reads a FeatureCollection', parsed.features.length === 3);
  ok('keeps polygon holes', parsed.features[0].polygons[0].holes.length === 1);

  const dataset = await importFile(new File([JSON.stringify(geo)], 'blocks.geojson'));
  ok('mixed geometry is reported as mixed', dataset.kind === 'mixed', dataset.kind);
  ok('lat/lon data is not reprojected', dataset.reprojected === false);
  near('bbox tracks the data', dataset.bbox.maxLat, 40.735, 1e-6);

  const withZ = { ...geo, features: [{ ...geo.features[2], geometry: { type: 'Point', coordinates: [-73.977, 40.732, 271.5] } }] };
  const zDataset = await importFile(new File([JSON.stringify(withZ)], 'z.geojson'));
  ok('altitude ordinates are ignored', zDataset.count === 1 && zDataset.bbox.maxLat === 40.732);

  const projected = {
    type: 'FeatureCollection',
    crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::26997' } },
    features: [{
      type: 'Feature', properties: {},
      geometry: { type: 'Polygon', coordinates: [[[500000, 4511000], [500020, 4511000], [500020, 4511020], [500000, 4511020], [500000, 4511000]]] },
    }],
  };
  ok('a projected crs member is detected', readGeoJson(JSON.stringify(projected)).crs === 'EPSG:26997');
}

console.log('\nHeight mapping');
{
  const mapping = { heightField: 'H', heightUnit: 'm', defaultHeight: 8, heightScale: 1 };
  near('metres pass through', heightInMetres({ H: 12 }, mapping), 12, 1e-9);
  near('feet convert', heightInMetres({ H: 100 }, { ...mapping, heightUnit: 'ft' }), 30.48, 1e-6);
  near('levels become metres', heightInMetres({ H: 3 }, { ...mapping, heightUnit: 'levels' }), 10.6, 1e-6);
  near('missing values fall back', heightInMetres({}, mapping), 8, 1e-9);
  near('text numbers are accepted', heightInMetres({ H: '15.5' }, mapping), 15.5, 1e-9);
  near('nonsense falls back', heightInMetres({ H: 'tall' }, mapping), 8, 1e-9);
  near('scale is applied', heightInMetres({ H: 10 }, { ...mapping, heightScale: 2 }), 20, 1e-9);

  const feetish = [{ name: 'HEIGHT', type: 'number', min: 12, max: 240, filled: 100, sample: 30 }];
  ok('a field topping 240 is guessed as feet', guessHeightMapping(feetish).unit === 'ft');
  const storeys = [{ name: 'NUM_FLOORS', type: 'number', min: 1, max: 4, filled: 100, sample: 2 }];
  ok('a floor count is guessed as levels', guessHeightMapping(storeys).unit === 'levels',
    guessHeightMapping(storeys).unit);
}

console.log('\nMerging into the OSM feature set');
{
  const zip = await shapefileZip();
  const dataset = await importFile(new File([zip], 'buildings.zip'));
  dataset.mapping = { ...defaultMapping(dataset), heightField: 'HEIGHT', heightUnit: 'm', mode: 'add' };

  const inside = dataset.bbox;
  const osm = {
    buildings: [
      { id: 'way/1', tags: { building: 'yes' }, rings: [{ role: 'outer', points: [
        { lat: inside.minLat + 0.0001, lon: inside.minLon + 0.0001 },
        { lat: inside.minLat + 0.0002, lon: inside.minLon + 0.0001 },
        { lat: inside.minLat + 0.0002, lon: inside.minLon + 0.0002 },
        { lat: inside.minLat + 0.0001, lon: inside.minLon + 0.0001 },
      ] }] },
      { id: 'way/2', tags: { building: 'yes' }, rings: [{ role: 'outer', points: [
        { lat: 41.5, lon: -95.5 }, { lat: 41.5001, lon: -95.5 },
        { lat: 41.5001, lon: -95.4999 }, { lat: 41.5, lon: -95.5 },
      ] }] },
    ],
    roads: [], rail: [], water: [], green: [], trees: [], treeRows: [], coastline: [],
  };

  const added = applyImports(osm, [dataset]);
  ok('add mode keeps the OSM buildings', added.features.buildings.length === 2 + 36,
    `${added.features.buildings.length}`);
  ok('imported buildings carry their height', added.features.buildings.some(
    (b) => b.id.startsWith('import/') && Number(b.tags.height) > 4));
  ok('the source extract is not mutated', osm.buildings.length === 2);

  dataset.mapping.mode = 'replace';
  const replaced = applyImports(osm, [dataset]);
  ok('replace mode drops OSM buildings inside the imported area',
    replaced.features.buildings.length === 37, `${replaced.features.buildings.length}`);
  ok('replace mode leaves OSM buildings elsewhere alone',
    replaced.features.buildings.some((b) => b.id === 'way/2'));
  ok('replace reports what it removed', replaced.stats.replaced === 1, `${replaced.stats.replaced}`);

  const summary = heightSummary(dataset, dataset.mapping);
  ok('height summary reports the spread', summary && summary.distinct > 3,
    `${summary?.distinct} distinct values`);
}

console.log('\nImported data reaches the printed model');
{
  const zip = await shapefileZip();
  const dataset = await importFile(new File([zip], 'buildings.zip'));
  dataset.mapping = { ...defaultMapping(dataset), heightField: 'HEIGHT', heightUnit: 'm' };

  const empty = { buildings: [], roads: [], rail: [], water: [], green: [], trees: [], treeRows: [], coastline: [] };
  const { features } = applyImports(empty, [dataset]);

  const s = defaultSettings();
  s.location.lat = (dataset.bbox.minLat + dataset.bbox.maxLat) / 2;
  s.location.lon = (dataset.bbox.minLon + dataset.bbox.maxLon) / 2;
  s.size.areaMetres = 400;
  s.size.printMm = 160;

  const model = buildModel(features, s, {});
  const buildings = model.parts.find((p) => p.id === 'buildings');
  ok('imported buildings are extruded', Boolean(buildings) && model.stats.buildingCount > 20,
    `${model.stats.buildingCount} buildings`);

  const zs = new Set();
  for (let i = 2; i < buildings.positions.length; i += 3) zs.add(Math.round(buildings.positions[i] * 10));
  ok('the printed heights actually vary', zs.size > 5, `${zs.size} distinct z values`);

  ok('the model is watertight', openEdges(buildings) === 0, `${openEdges(buildings)} open edges`);
  ok('the partition still tiles the plate',
    Math.abs(Object.values(model.stats.regionAreas).reduce((a, b) => a + b, 0) / model.stats.plateAreaMm2 - 1) < 0.005);
}

function openEdges(part) {
  const p = part.positions;
  const key = (i) => `${Math.round(p[i * 3] * 1e3)}_${Math.round(p[i * 3 + 1] * 1e3)}_${Math.round(p[i * 3 + 2] * 1e3)}`;
  const counts = new Map();
  for (let i = 0; i < part.indices.length; i += 3) {
    const tri = [part.indices[i], part.indices[i + 1], part.indices[i + 2]].map(key);
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

console.log(`\n${failures ? '✗' : '✓'} ${total - failures}/${total} checks passed\n`);
process.exit(failures ? 1 : 0);

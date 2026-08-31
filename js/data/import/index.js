import { unzip, findByExtension } from './unzip.js';
import { readShp, readDbf, combine, ringsToPolygons } from './shapefile.js';
import { readGeoJson } from './geojson.js';
import { readKml } from './kml.js';

const HEIGHT_HINTS = [
  'height_m', 'heightm', 'bldg_height', 'building_height', 'roof_height',
  'height', 'hgt', 'ht', 'z', 'elevation_diff', 'max_height', 'mean_height',
  'apex', 'peak_height',
];
const LEVEL_HINTS = [
  'building_levels', 'num_floors', 'numfloors', 'num_story', 'numstories',
  'stories', 'storeys', 'floors', 'levels', 'nfloors',
];
const NAME_HINTS = ['name', 'address', 'full_address', 'addr', 'label', 'title', 'street'];

export async function importFile(file) {
  const name = file.name || 'data';
  const lower = name.toLowerCase();

  if (file.size > 120 * 1024 * 1024) {
    throw new Error('That file is over 120 MB. Clip it to your area first — the whole thing has to fit in memory.');
  }

  let parsed;
  let crsDefinition = null;
  let format;

  if (lower.endsWith('.zip') || lower.endsWith('.kmz')) {
    const files = await unzip(await file.arrayBuffer());
    const kml = findByExtension(files, 'kml');
    const shp = findByExtension(files, 'shp');

    if (shp) {
      format = 'Shapefile';
      const dbf = findByExtension(files, 'dbf');
      const prj = findByExtension(files, 'prj');
      const cpg = findByExtension(files, 'cpg');
      const encoding = cpg ? new TextDecoder().decode(cpg.data).trim() : undefined;
      crsDefinition = prj ? new TextDecoder().decode(prj.data).trim() : null;
      parsed = fromShapefile(shp.data, dbf?.data, encoding);
    } else if (kml) {
      format = 'KMZ';
      parsed = readKml(new TextDecoder().decode(kml.data));
    } else {
      const geo = findByExtension(files, 'geojson') || findByExtension(files, 'json');
      if (!geo) {
        throw new Error(
          `That ZIP has no .shp, .kml or .geojson in it (found: ${[...files.keys()].slice(0, 4).join(', ')}).`
        );
      }
      format = 'GeoJSON';
      parsed = readGeoJson(new TextDecoder().decode(geo.data));
    }
  } else if (lower.endsWith('.kml')) {
    format = 'KML';
    parsed = readKml(await file.text());
  } else if (lower.endsWith('.shp')) {
    throw new Error(
      'A .shp on its own has no attributes or projection. Zip it together with its .dbf and .prj and upload the ZIP.'
    );
  } else {
    format = 'GeoJSON';
    parsed = readGeoJson(await file.text());
    crsDefinition = parsed.crs;
  }

  return normalise(parsed.features, {
    name,
    format,
    crsDefinition: crsDefinition || parsed.crs || null,
  });
}

function fromShapefile(shpBytes, dbfBytes, encoding) {
  const shp = readShp(shpBytes);
  const dbf = dbfBytes ? readDbf(dbfBytes, encoding) : null;
  const raw = combine(shp, dbf);

  const features = raw.map((f) => {
    if (f.kind === 'area') return { kind: 'area', polygons: ringsToPolygons(f.parts), properties: f.properties };
    if (f.kind === 'line') return { kind: 'line', parts: f.parts, properties: f.properties };
    return { kind: 'point', points: f.points, properties: f.properties };
  });

  return { features, crs: null };
}

function looksProjected(bounds) {
  return (
    Math.abs(bounds.minX) > 180 || Math.abs(bounds.maxX) > 180 ||
    Math.abs(bounds.minY) > 90 || Math.abs(bounds.maxY) > 90
  );
}

function rawBounds(features) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const visit = ([x, y]) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  for (const f of features) {
    if (f.polygons) for (const p of f.polygons) { p.outer.forEach(visit); p.holes.forEach((h) => h.forEach(visit)); }
    if (f.parts) for (const part of f.parts) part.forEach(visit);
    if (f.points) f.points.forEach(visit);
  }
  return { minX, minY, maxX, maxY };
}

async function makeTransform(definition) {
  const { default: proj4 } = await import('../../../vendor/proj4.js');
  const from = proj4(definition);
  return (point) => proj4(from, proj4.WGS84, point);
}

function crsLabel(definition) {
  if (!definition) return null;
  const match = definition.match(/^\s*PROJCS\["([^"]+)"/i) || definition.match(/^\s*GEOGCS\["([^"]+)"/i);
  if (match) return match[1];
  return definition.length > 60 ? `${definition.slice(0, 57)}…` : definition;
}

async function normalise(rawFeatures, meta) {
  const bounds = rawBounds(rawFeatures);
  if (!isFinite(bounds.minX)) throw new Error('That file contains no coordinates.');

  const projected = looksProjected(bounds);
  let transform = (p) => p;
  let reprojected = false;

  if (projected) {
    if (!meta.crsDefinition) {
      throw new Error(
        'This data is in a projected coordinate system but carries no projection information. ' +
          'Include the .prj file in the ZIP, or re-export as WGS84 / EPSG:4326.'
      );
    }
    try {
      transform = await makeTransform(meta.crsDefinition);
      reprojected = true;
    } catch (err) {
      throw new Error(`Could not read the projection (${err.message}). Re-export as WGS84 / EPSG:4326.`);
    }
  } else if (meta.crsDefinition && /GEOGCS|\+proj=longlat/i.test(meta.crsDefinition)) {
    reprojected = false;
  }

  const toLatLon = (point) => {
    const [lon, lat] = transform(point);
    return { lat, lon };
  };

  const features = [];
  let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
  const track = (p) => {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  };

  for (const f of rawFeatures) {
    if (f.kind === 'area') {
      for (const poly of f.polygons || []) {
        const rings = [{ role: 'outer', points: poly.outer.map(toLatLon) }];
        for (const hole of poly.holes) rings.push({ role: 'inner', points: hole.map(toLatLon) });
        if (rings[0].points.length < 3) continue;
        rings.forEach((r) => r.points.forEach(track));
        features.push({ kind: 'area', rings, properties: f.properties || {} });
      }
    } else if (f.kind === 'line') {
      for (const part of f.parts || []) {
        const points = part.map(toLatLon);
        if (points.length < 2) continue;
        points.forEach(track);
        features.push({ kind: 'line', rings: [{ role: 'outer', points }], properties: f.properties || {} });
      }
    } else if (f.kind === 'point') {
      const points = (f.points || []).map(toLatLon);
      if (!points.length) continue;
      points.forEach(track);
      features.push({ kind: 'point', points, properties: f.properties || {} });
    }
  }

  if (!features.length) throw new Error('That file contains no usable geometry.');
  if (!Number.isFinite(minLat) || Math.abs(minLat) > 90 || Math.abs(minLon) > 180) {
    throw new Error('The reprojected coordinates are outside the world. The projection information looks wrong.');
  }

  const kinds = new Set(features.map((f) => f.kind));

  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: meta.name,
    format: meta.format,
    crsName: reprojected ? crsLabel(meta.crsDefinition) : null,
    reprojected,
    kind: kinds.size === 1 ? [...kinds][0] : 'mixed',
    count: features.length,
    features,
    fields: describeFields(features),
    bbox: { minLat, minLon, maxLat, maxLon },
  };
}

function describeFields(features) {
  const stats = new Map();
  const sampleSize = Math.min(features.length, 2000);

  for (let i = 0; i < sampleSize; i++) {
    const properties = features[i].properties || {};
    for (const [key, value] of Object.entries(properties)) {
      if (value === null || value === undefined || value === '') continue;
      let s = stats.get(key);
      if (!s) stats.set(key, (s = { name: key, numeric: 0, total: 0, min: Infinity, max: -Infinity, sample: null }));
      s.total++;
      if (s.sample === null) s.sample = value;
      const n = typeof value === 'number' ? value : Number(value);
      if (Number.isFinite(n)) {
        s.numeric++;
        if (n < s.min) s.min = n;
        if (n > s.max) s.max = n;
      }
    }
  }

  return [...stats.values()]
    .map((s) => ({
      name: s.name,
      type: s.numeric / Math.max(1, s.total) > 0.8 ? 'number' : 'text',
      min: s.min === Infinity ? null : s.min,
      max: s.max === -Infinity ? null : s.max,
      sample: s.sample,
      filled: s.total,
    }))
    .sort((a, b) => b.filled - a.filled);
}

export function guessHeightMapping(fields) {
  const numeric = fields.filter((f) => f.type === 'number' && f.max !== null && f.max > 0);
  if (!numeric.length) return { field: null, unit: 'm' };

  const byName = (hints) =>
    numeric.find((f) => hints.some((h) => f.name.toLowerCase().replace(/[^a-z]/g, '') === h.replace(/[^a-z]/g, ''))) ||
    numeric.find((f) => hints.some((h) => f.name.toLowerCase().includes(h.replace(/[^a-z]/g, ''))));

  const levels = byName(LEVEL_HINTS);
  const height = byName(HEIGHT_HINTS);

  if (height && (!levels || HEIGHT_HINTS.length)) {
    const unit = height.max > 90 ? 'ft' : 'm';
    return { field: height.name, unit };
  }
  if (levels) return { field: levels.name, unit: 'levels' };

  return { field: null, unit: 'm' };
}

export function guessNameField(fields) {
  const text = fields.filter((f) => f.type === 'text');
  for (const hint of NAME_HINTS) {
    const found = text.find((f) => f.name.toLowerCase().includes(hint));
    if (found) return found.name;
  }
  return null;
}

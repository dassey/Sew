export function readGeoJson(text) {
  let root;
  try {
    root = typeof text === 'string' ? JSON.parse(text) : text;
  } catch (err) {
    throw new Error(`That file is not valid JSON (${err.message}).`);
  }

  const features = [];
  collect(root, {}, features);
  if (!features.length) throw new Error('No usable geometry found in that GeoJSON.');

  return { features, crs: namedCrs(root) };
}

function namedCrs(root) {
  const name = root?.crs?.properties?.name;
  if (typeof name !== 'string') return null;
  const match = name.match(/EPSG:{1,2}(\d+)/i);
  if (!match) return null;
  const code = Number(match[1]);
  if (code === 4326 || code === 4269 || code === 84) return null;
  return `EPSG:${code}`;
}

function collect(node, inherited, out) {
  if (!node || typeof node !== 'object') return;

  switch (node.type) {
    case 'FeatureCollection':
      for (const f of node.features || []) collect(f, inherited, out);
      return;
    case 'Feature':
      collect(node.geometry, node.properties || {}, out);
      return;
    case 'GeometryCollection':
      for (const g of node.geometries || []) collect(g, inherited, out);
      return;
    default:
      break;
  }

  const properties = inherited || {};
  const c = node.coordinates;
  if (!c) return;

  switch (node.type) {
    case 'Point':
      out.push({ kind: 'point', points: [xy(c)], properties });
      return;
    case 'MultiPoint':
      out.push({ kind: 'point', points: c.map(xy), properties });
      return;
    case 'LineString':
      out.push({ kind: 'line', parts: [c.map(xy)], properties });
      return;
    case 'MultiLineString':
      out.push({ kind: 'line', parts: c.map((l) => l.map(xy)), properties });
      return;
    case 'Polygon':
      out.push({ kind: 'area', polygons: [polygon(c)], properties });
      return;
    case 'MultiPolygon':
      out.push({ kind: 'area', polygons: c.map(polygon), properties });
      return;
    default:
      return;
  }
}

function xy(pair) {
  return [Number(pair[0]), Number(pair[1])];
}

function polygon(rings) {
  return { outer: (rings[0] || []).map(xy), holes: rings.slice(1).map((r) => r.map(xy)) };
}

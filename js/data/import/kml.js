const NS = { kml: 'http://www.opengis.net/kml/2.2' };

export function readKml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('That KML file is not valid XML.');

  const features = [];
  for (const placemark of doc.getElementsByTagName('Placemark')) {
    const properties = readProperties(placemark);
    for (const geometry of readGeometries(placemark)) {
      features.push({ ...geometry, properties });
    }
  }

  if (!features.length) throw new Error('No placemarks with geometry found in that KML.');
  return { features, crs: null };
}

function text(el, tag) {
  const node = el.getElementsByTagName(tag)[0];
  return node ? node.textContent.trim() : '';
}

function readProperties(placemark) {
  const properties = {};
  const name = text(placemark, 'name');
  if (name) properties.name = name;
  const description = text(placemark, 'description');
  if (description && description.length < 400) properties.description = description;

  for (const node of placemark.getElementsByTagName('SimpleData')) {
    const key = node.getAttribute('name');
    if (key) properties[key] = coerce(node.textContent.trim());
  }
  for (const node of placemark.getElementsByTagName('Data')) {
    const key = node.getAttribute('name');
    if (!key) continue;
    const value = node.getElementsByTagName('value')[0];
    if (value) properties[key] = coerce(value.textContent.trim());
  }
  return properties;
}

function coerce(value) {
  if (value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && /^-?[\d.]+$/.test(value) ? n : value;
}

function parseCoordinates(node) {
  if (!node) return [];
  return node.textContent
    .trim()
    .split(/\s+/)
    .map((triple) => {
      const [lon, lat] = triple.split(',');
      return [Number(lon), Number(lat)];
    })
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
}

function readGeometries(placemark) {
  const out = [];

  for (const poly of placemark.getElementsByTagName('Polygon')) {
    const outerNode = poly.getElementsByTagName('outerBoundaryIs')[0];
    const outer = parseCoordinates(outerNode?.getElementsByTagName('coordinates')[0]);
    if (outer.length < 3) continue;
    const holes = [];
    for (const inner of poly.getElementsByTagName('innerBoundaryIs')) {
      const ring = parseCoordinates(inner.getElementsByTagName('coordinates')[0]);
      if (ring.length >= 3) holes.push(ring);
    }
    out.push({ kind: 'area', polygons: [{ outer, holes }] });
  }

  const lines = [];
  for (const line of placemark.getElementsByTagName('LineString')) {
    const points = parseCoordinates(line.getElementsByTagName('coordinates')[0]);
    if (points.length >= 2) lines.push(points);
  }
  for (const ring of placemark.getElementsByTagName('LinearRing')) {
    if (ring.closest && ring.closest('Polygon')) continue;
    const points = parseCoordinates(ring.getElementsByTagName('coordinates')[0]);
    if (points.length >= 3) lines.push(points);
  }
  if (lines.length) out.push({ kind: 'line', parts: lines });

  const points = [];
  for (const point of placemark.getElementsByTagName('Point')) {
    points.push(...parseCoordinates(point.getElementsByTagName('coordinates')[0]));
  }
  if (points.length) out.push({ kind: 'point', points });

  return out;
}

export { NS };

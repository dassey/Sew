const VALHALLA = 'https://valhalla1.openstreetmap.de/route';
const OSRM = 'https://router.project-osrm.org/route/v1';

export const PROFILES = [
  { id: 'auto', label: 'Drive', valhalla: 'auto', osrm: 'driving' },
  { id: 'pedestrian', label: 'Walk', valhalla: 'pedestrian', osrm: 'foot' },
  { id: 'bicycle', label: 'Bike', valhalla: 'bicycle', osrm: 'bike' },
];

function decodePolyline(str, precision = 6) {
  const factor = 10 ** precision;
  const coords = [];
  let index = 0;
  let lat = 0;
  let lon = 0;

  while (index < str.length) {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lon += result & 1 ? ~(result >> 1) : result >> 1;

    coords.push([lat / factor, lon / factor]);
  }
  return coords;
}

export async function routeBetween(waypoints, profileId = 'auto', opts = {}) {
  if (!waypoints || waypoints.length < 2) {
    throw new Error('A route needs at least a start and an end.');
  }
  const profile = PROFILES.find((p) => p.id === profileId) || PROFILES[0];

  try {
    return await routeValhalla(waypoints, profile, opts);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    try {
      return await routeOsrm(waypoints, profile, opts);
    } catch {
      throw new Error(`Routing failed: ${err.message}`);
    }
  }
}

async function routeValhalla(waypoints, profile, opts) {
  const body = {
    locations: waypoints.map((w) => ({ lat: w.lat, lon: w.lon, type: 'break' })),
    costing: profile.valhalla,
    directions_options: { units: 'kilometers' },
  };
  const url = `${VALHALLA}?json=${encodeURIComponent(JSON.stringify(body))}`;
  const res = await fetch(url, { signal: opts.signal });
  if (!res.ok) throw new Error(`Valhalla ${res.status}`);
  const data = await res.json();
  if (!data.trip?.legs?.length) throw new Error('No route found');

  const points = [];
  for (const leg of data.trip.legs) {
    const decoded = decodePolyline(leg.shape, 6);
    points.push(...(points.length ? decoded.slice(1) : decoded));
  }
  return {
    points,
    distance: (data.trip.summary?.length || 0) * 1000,
    duration: data.trip.summary?.time || 0,
    source: 'Valhalla / OSM',
  };
}

async function routeOsrm(waypoints, profile, opts) {
  const coords = waypoints.map((w) => `${w.lon},${w.lat}`).join(';');
  const url = `${OSRM}/${profile.osrm}/${coords}?overview=full&geometries=geojson`;
  const res = await fetch(url, { signal: opts.signal });
  if (!res.ok) throw new Error(`OSRM ${res.status}`);
  const data = await res.json();
  if (!data.routes?.length) throw new Error('No route found');
  const r = data.routes[0];
  return {
    points: r.geometry.coordinates.map(([lon, lat]) => [lat, lon]),
    distance: r.distance,
    duration: r.duration,
    source: 'OSRM',
  };
}

export function parseGpx(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('That does not look like valid GPX.');

  const collect = (selector) =>
    Array.from(doc.querySelectorAll(selector))
      .map((el) => [parseFloat(el.getAttribute('lat')), parseFloat(el.getAttribute('lon'))])
      .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));

  const points =
    firstNonEmpty(collect('trkpt'), collect('rtept'), collect('wpt')) || [];
  if (points.length < 2) throw new Error('No usable track found in that GPX file.');

  const name =
    doc.querySelector('trk > name')?.textContent?.trim() ||
    doc.querySelector('metadata > name')?.textContent?.trim() ||
    '';

  return { points, name, distance: pathLength(points), duration: 0, source: 'GPX' };
}

function firstNonEmpty(...lists) {
  for (const l of lists) if (l.length >= 2) return l;
  return null;
}

export function pathLength(points) {
  const R = 6371008.8;
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const [lat1, lon1] = points[i - 1];
    const [lat2, lon2] = points[i];
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) ** 2;
    total += 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  return total;
}

export function formatDistance(metres) {
  if (!metres) return '—';
  return metres < 1000
    ? `${Math.round(metres)} m`
    : `${(metres / 1000).toFixed(metres < 10000 ? 2 : 1)} km`;
}

export function formatDuration(seconds) {
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

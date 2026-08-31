const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

const memoryCache = new Map();

export const LAYER_QUERIES = {
  buildings: [
    'way["building"]',
    'relation["building"]',
    'way["building:part"]',
  ],
  roads: [
    'way["highway"]["highway"!~"^(proposed|construction|abandoned|razed)$"][!"area"]',
  ],
  rail: ['way["railway"~"^(rail|light_rail|subway|tram|narrow_gauge|monorail)$"]'],
  water: [
    'way["natural"="water"]',
    'relation["natural"="water"]',
    'way["waterway"~"^(riverbank|dock|canal|river|stream)$"]',
    'way["landuse"~"^(reservoir|basin)$"]',
    'relation["landuse"~"^(reservoir|basin)$"]',
    'way["natural"="coastline"]',
  ],
  green: [
    'way["leisure"~"^(park|garden|golf_course|pitch|nature_reserve|common)$"]',
    'relation["leisure"~"^(park|garden|golf_course|nature_reserve)$"]',
    'way["landuse"~"^(forest|grass|meadow|recreation_ground|village_green|cemetery|allotments|orchard|vineyard)$"]',
    'relation["landuse"~"^(forest|grass|meadow|recreation_ground|cemetery)$"]',
    'way["natural"~"^(wood|scrub|grassland|heath|beach|sand)$"]',
    'relation["natural"~"^(wood|scrub|grassland)$"]',
  ],
  trees: ['node["natural"="tree"]', 'way["natural"="tree_row"]'],
};

export function buildQuery(bbox, layers, timeout = 90) {
  const b = `${bbox.minLat.toFixed(6)},${bbox.minLon.toFixed(6)},${bbox.maxLat.toFixed(6)},${bbox.maxLon.toFixed(6)}`;
  const parts = [];
  for (const layer of layers) {
    for (const sel of LAYER_QUERIES[layer] || []) {
      parts.push(`  ${sel}(${b});`);
    }
  }
  return [
    `[out:json][timeout:${timeout}]${'[maxsize:536870912]'};`,
    '(',
    ...parts,
    ');',
    'out body geom qt;',
  ].join('\n');
}

function cacheKey(query) {
  let h = 5381;
  for (let i = 0; i < query.length; i++) h = ((h << 5) + h + query.charCodeAt(i)) | 0;
  return `overpass:${h >>> 0}:${query.length}`;
}

function readSessionCache(key) {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const { at, data } = JSON.parse(raw);
    if (Date.now() - at > 60 * 60 * 1000) return null;
    return data;
  } catch {
    return null;
  }
}

function writeSessionCache(key, data) {
  try {
    sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), data }));
  } catch {
  }
}

export async function runQuery(query, opts = {}) {
  const key = cacheKey(query);
  if (memoryCache.has(key)) return memoryCache.get(key);
  const cached = readSessionCache(key);
  if (cached) {
    memoryCache.set(key, cached);
    return cached;
  }

  const errors = [];
  for (let i = 0; i < MIRRORS.length; i++) {
    const mirror = MIRRORS[i];
    const host = new URL(mirror).host;
    opts.onProgress?.(
      i === 0
        ? `Downloading map data from ${host}…`
        : `Retrying via ${host}…`
    );
    try {
      const res = await fetch(mirror, {
        method: 'POST',
        body: new URLSearchParams({ data: query }),
        signal: opts.signal,
      });
      if (!res.ok) {
        const detail = res.status === 429
          ? 'rate limited'
          : res.status === 504
            ? 'server busy'
            : `HTTP ${res.status}`;
        throw new Error(`${host}: ${detail}`);
      }
      const json = await res.json();
      if (json.remark && /timed out|out of memory/i.test(json.remark)) {
        throw new Error(`${host}: ${json.remark.trim()}`);
      }
      memoryCache.set(key, json);
      writeSessionCache(key, json);
      return json;
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      errors.push(err.message);
    }
  }
  throw new Error(
    `Could not reach any Overpass mirror.\n${errors.join('\n')}\n\n` +
      'The public servers throttle heavy use. Wait a minute, or shrink the area.'
  );
}

export function parseElements(elements) {
  const out = {
    buildings: [],
    roads: [],
    rail: [],
    water: [],
    green: [],
    trees: [],
    treeRows: [],
    coastline: [],
  };

  for (const el of elements) {
    const tags = el.tags || {};

    if (el.type === 'node') {
      if (tags.natural === 'tree') {
        out.trees.push({ lat: el.lat, lon: el.lon, tags });
      }
      continue;
    }

    const rings = el.type === 'relation'
      ? assembleRelation(el)
      : el.geometry
        ? [{ role: 'outer', points: el.geometry }]
        : [];
    if (!rings.length) continue;

    const feature = { id: `${el.type}/${el.id}`, tags, rings };
    const isClosed = ringIsClosed(rings[0].points);

    if (tags.building || tags['building:part']) {
      if (isClosed || el.type === 'relation') out.buildings.push(feature);
    } else if (tags.highway) {
      if (tags.area === 'yes' && isClosed) {
        out.green.push({ ...feature, pedestrianArea: true });
      } else {
        out.roads.push(feature);
      }
    } else if (tags.railway) {
      out.rail.push(feature);
    } else if (tags.natural === 'coastline') {
      out.coastline.push(feature);
    } else if (tags.natural === 'tree_row') {
      out.treeRows.push(feature);
    } else if (
      tags.natural === 'water' ||
      tags.waterway ||
      tags.landuse === 'reservoir' ||
      tags.landuse === 'basin'
    ) {
      const linear = tags.waterway && !isClosed;
      out.water.push({ ...feature, linear });
    } else if (tags.leisure || tags.landuse || tags.natural) {
      if (isClosed || el.type === 'relation') out.green.push(feature);
    }
  }

  return out;
}

function ringIsClosed(points) {
  if (!points || points.length < 4) return false;
  const a = points[0];
  const b = points[points.length - 1];
  return a.lat === b.lat && a.lon === b.lon;
}

function assembleRelation(rel) {
  const byRole = { outer: [], inner: [] };
  for (const m of rel.members || []) {
    if (m.type !== 'way' || !m.geometry || m.geometry.length < 2) continue;
    const role = m.role === 'inner' ? 'inner' : 'outer';
    byRole[role].push(m.geometry.slice());
  }

  const rings = [];
  for (const role of ['outer', 'inner']) {
    const pending = byRole[role];
    const EPS = 1e-9;
    const same = (a, b) =>
      Math.abs(a.lat - b.lat) < EPS && Math.abs(a.lon - b.lon) < EPS;

    while (pending.length) {
      let chain = pending.shift();
      let extended = true;
      let guard = 0;

      while (extended && !same(chain[0], chain[chain.length - 1]) && guard++ < 5000) {
        extended = false;
        const tail = chain[chain.length - 1];
        for (let i = 0; i < pending.length; i++) {
          const seg = pending[i];
          if (same(tail, seg[0])) {
            chain = chain.concat(seg.slice(1));
          } else if (same(tail, seg[seg.length - 1])) {
            chain = chain.concat(seg.slice(0, -1).reverse());
          } else {
            continue;
          }
          pending.splice(i, 1);
          extended = true;
          break;
        }
      }

      if (chain.length >= 4) rings.push({ role, points: chain });
    }
  }

  rings.sort((a, b) => (a.role === 'outer' ? -1 : 1) - (b.role === 'outer' ? -1 : 1));
  return rings;
}

export function estimateSize(json) {
  return JSON.stringify(json).length;
}

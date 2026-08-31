const ENDPOINT = 'https://api.open-meteo.com/v1/elevation';
const MAX_PER_REQUEST = 100;
const CONCURRENCY = 4;

const cache = new Map();

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchBatch(points, signal) {
  const url = new URL(ENDPOINT);
  url.searchParams.set('latitude', points.map((p) => p[0].toFixed(6)).join(','));
  url.searchParams.set('longitude', points.map((p) => p[1].toFixed(6)).join(','));

  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Elevation API ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data.elevation)) throw new Error('Unexpected elevation response');
  return data.elevation;
}

export async function fetchHeightGrid(bbox, n, opts = {}) {
  const key = `${bbox.minLat.toFixed(4)},${bbox.minLon.toFixed(4)},${bbox.maxLat.toFixed(4)},${bbox.maxLon.toFixed(4)}:${n}`;
  if (cache.has(key)) return cache.get(key);

  const points = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const lat = bbox.minLat + ((bbox.maxLat - bbox.minLat) * r) / (n - 1);
      const lon = bbox.minLon + ((bbox.maxLon - bbox.minLon) * c) / (n - 1);
      points.push([lat, lon]);
    }
  }

  const batches = chunk(points, MAX_PER_REQUEST);
  const values = new Float32Array(points.length);
  let done = 0;

  let cursor = 0;
  async function worker() {
    while (cursor < batches.length) {
      const idx = cursor++;
      const result = await fetchBatch(batches[idx], opts.signal);
      values.set(result, idx * MAX_PER_REQUEST);
      done++;
      opts.onProgress?.(
        `Sampling terrain… ${Math.round((done / batches.length) * 100)}%`
      );
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker)
  );

  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }

  const grid = { n, bbox, values, min, max };
  cache.set(key, grid);
  return grid;
}

export function makeSampler(grid, projection, mmPerMetre, exaggeration, datum) {
  if (!grid) return () => 0;
  const { n, bbox, values } = grid;
  const base = datum ?? grid.min;

  const [x0, y0] = projection.forward(bbox.minLat, bbox.minLon);
  const [x1, y1] = projection.forward(bbox.maxLat, bbox.maxLon);
  const spanX = (x1 - x0) * mmPerMetre;
  const spanY = (y1 - y0) * mmPerMetre;
  const originX = x0 * mmPerMetre;
  const originY = y0 * mmPerMetre;

  return function sample(x, y) {
    let u = ((x - originX) / spanX) * (n - 1);
    let v = ((y - originY) / spanY) * (n - 1);
    u = u < 0 ? 0 : u > n - 1 ? n - 1 : u;
    v = v < 0 ? 0 : v > n - 1 ? n - 1 : v;

    const c0 = Math.floor(u);
    const r0 = Math.floor(v);
    const c1 = Math.min(c0 + 1, n - 1);
    const r1 = Math.min(r0 + 1, n - 1);
    const fu = u - c0;
    const fv = v - r0;

    const h00 = values[r0 * n + c0];
    const h10 = values[r0 * n + c1];
    const h01 = values[r1 * n + c0];
    const h11 = values[r1 * n + c1];

    const top = h00 + (h10 - h00) * fu;
    const bot = h01 + (h11 - h01) * fu;
    const metres = top + (bot - top) * fv - base;

    return metres * mmPerMetre * exaggeration;
  };
}

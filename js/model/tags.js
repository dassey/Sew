const METRES_PER_LEVEL = 3.2;

function parseLength(value) {
  if (value == null) return null;
  const s = String(value).trim().toLowerCase();

  const feetInches = s.match(/^(\d+(?:\.\d+)?)\s*'\s*(?:(\d+(?:\.\d+)?)\s*")?$/);
  if (feetInches) {
    const ft = parseFloat(feetInches[1]);
    const inch = feetInches[2] ? parseFloat(feetInches[2]) : 0;
    return ft * 0.3048 + inch * 0.0254;
  }

  const m = s.match(/^(-?\d+(?:[.,]\d+)?)\s*(m|metre|metres|meter|meters|ft|feet)?$/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  return m[2] === 'ft' || m[2] === 'feet' ? n * 0.3048 : n;
}

const DEFAULT_HEIGHTS = {
  skyscraper: 120,
  cathedral: 40,
  church: 20,
  chapel: 10,
  mosque: 18,
  temple: 18,
  synagogue: 18,
  hospital: 25,
  university: 20,
  college: 16,
  hotel: 30,
  apartments: 16,
  residential: 12,
  commercial: 15,
  office: 25,
  retail: 8,
  supermarket: 8,
  industrial: 10,
  warehouse: 10,
  school: 10,
  civic: 14,
  public: 14,
  train_station: 15,
  house: 6.5,
  detached: 6.5,
  semidetached_house: 6.5,
  terrace: 8,
  bungalow: 4,
  hut: 3,
  shed: 3,
  garage: 3,
  garages: 3,
  roof: 4,
  carport: 3,
  greenhouse: 4,
  service: 3,
  kiosk: 3,
};

export function buildingHeight(tags, fallback = 9) {
  const explicit =
    parseLength(tags.height) ??
    parseLength(tags['building:height']) ??
    parseLength(tags['est_height']);
  if (explicit && explicit > 0) return explicit;

  const levels =
    parseFloat(tags['building:levels']) ||
    parseFloat(tags['levels']) ||
    null;
  if (levels && levels > 0) {
    const roof = parseFloat(tags['roof:levels']) || 0;
    return (levels + roof * 0.6) * METRES_PER_LEVEL + 1;
  }

  const kind = tags.building || tags['building:part'];
  if (kind && DEFAULT_HEIGHTS[kind]) return DEFAULT_HEIGHTS[kind];
  if (tags.amenity && DEFAULT_HEIGHTS[tags.amenity]) return DEFAULT_HEIGHTS[tags.amenity];

  return fallback;
}

const ROOF_SHAPES = {
  gabled: 'gabled',
  hipped: 'gabled',
  half_hipped: 'gabled',
  'half-hipped': 'gabled',
  gambrel: 'gabled',
  mansard: 'gabled',
  saltbox: 'gabled',
  round: 'gabled',
  pyramidal: 'pyramidal',
  dome: 'pyramidal',
  onion: 'pyramidal',
  tent: 'pyramidal',
  cone: 'pyramidal',
  skillion: 'skillion',
  lean_to: 'skillion',
  'lean-to': 'skillion',
  flat: 'flat',
};

const GABLED_BY_DEFAULT = new Set([
  'house',
  'detached',
  'semidetached_house',
  'terrace',
  'terraced_house',
  'bungalow',
  'farm',
  'farmhouse',
  'cottage',
  'cabin',
  'villa',
  'hut',
  'shed',
  'static_caravan',
  'church',
  'chapel',
]);

const COMPASS = {
  N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
  S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5,
};

function parseDirection(value) {
  if (value == null) return null;
  const s = String(value).trim();
  const n = parseFloat(s);
  if (Number.isFinite(n)) return ((n % 360) + 360) % 360;
  return COMPASS[s.toUpperCase()] ?? null;
}

export function roofSpec(tags, ctx = {}) {
  let shape = ROOF_SHAPES[tags['roof:shape']] ?? null;
  if (!shape) {
    const kind = tags.building || tags['building:part'];
    if (kind && GABLED_BY_DEFAULT.has(kind)) {
      shape = 'gabled';
    } else if (kind === 'yes' || kind === 'residential') {
      const area = ctx.areaM2 ?? 0;
      const tall = (ctx.heightM ?? 99) > 12;
      if (area > 25 && area <= 400 && !tall) shape = 'gabled';
    }
  }
  if (!shape || shape === 'flat') return null;

  const levels = parseFloat(tags['roof:levels']);
  const heightM =
    parseLength(tags['roof:height']) ??
    (Number.isFinite(levels) && levels > 0 ? levels * 2.4 : null);

  return {
    shape,
    heightM: heightM && heightM > 0 ? heightM : null,
    orientation: tags['roof:orientation'] === 'across' ? 'across' : 'along',
    directionDeg: parseDirection(tags['roof:direction']),
  };
}

const ROAD_WIDTHS = {
  motorway: 22,
  motorway_link: 12,
  trunk: 18,
  trunk_link: 10,
  primary: 15,
  primary_link: 9,
  secondary: 13,
  secondary_link: 8,
  tertiary: 11,
  tertiary_link: 7,
  unclassified: 8,
  residential: 8,
  living_street: 7,
  pedestrian: 8,
  service: 5,
  track: 4,
  bus_guideway: 7,
  busway: 7,
  road: 8,
  footway: 2,
  path: 1.8,
  steps: 2,
  cycleway: 2.5,
  bridleway: 2,
  corridor: 2,
};

export const ROAD_CLASSES = {
  motorway: 'major',
  motorway_link: 'major',
  trunk: 'major',
  trunk_link: 'major',
  primary: 'major',
  primary_link: 'major',
  secondary: 'major',
  secondary_link: 'major',
  tertiary: 'minor',
  tertiary_link: 'minor',
  unclassified: 'minor',
  residential: 'minor',
  living_street: 'minor',
  road: 'minor',
  service: 'service',
  track: 'service',
  busway: 'minor',
  bus_guideway: 'minor',
  pedestrian: 'path',
  footway: 'path',
  path: 'path',
  steps: 'path',
  cycleway: 'path',
  bridleway: 'path',
  corridor: 'path',
};

export function roadClass(tags) {
  return ROAD_CLASSES[tags.highway] || 'minor';
}

export function roadWidth(tags) {
  const explicit = parseLength(tags.width);
  if (explicit && explicit > 0.5) return Math.min(explicit, 40);

  let base = ROAD_WIDTHS[tags.highway];
  if (base == null) return null;

  const lanes = parseFloat(tags.lanes);
  if (Number.isFinite(lanes) && lanes >= 1) {
    base = Math.max(base, lanes * 3.4 + 1);
  }
  if (tags.oneway === 'yes' && !Number.isFinite(lanes)) base *= 0.7;
  return base;
}

const RAIL_WIDTHS = {
  rail: 5,
  light_rail: 4.5,
  subway: 4.5,
  tram: 4,
  narrow_gauge: 3.5,
  monorail: 3.5,
};

export function railWidth(tags) {
  return RAIL_WIDTHS[tags.railway] || null;
}

export function isUnderground(tags) {
  if (tags.tunnel && tags.tunnel !== 'no') return true;
  if (tags.location === 'underground') return true;
  if (tags.covered === 'yes' && tags.railway === 'subway') return true;
  const layer = parseFloat(tags.layer);
  return Number.isFinite(layer) && layer < 0;
}

export function isBridge(tags) {
  return Boolean(tags.bridge && tags.bridge !== 'no');
}

export function isVisibleWater(tags) {
  if (tags.tunnel && tags.tunnel !== 'no') return false;
  if (tags.covered === 'yes') return false;
  if (tags.intermittent === 'yes') return false;
  return true;
}

const WATERWAY_WIDTHS = { river: 30, canal: 15, stream: 4, ditch: 2, drain: 2 };

export function waterwayWidth(tags) {
  const explicit = parseLength(tags.width);
  if (explicit && explicit > 0.5) return Math.min(explicit, 400);
  return WATERWAY_WIDTHS[tags.waterway] || null;
}

export function featureName(tags) {
  return tags['name:en'] || tags.name || '';
}

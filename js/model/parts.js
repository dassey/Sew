export const PARTS = [
  { id: 'route',      label: 'Route',        color: '#e0483e', hint: 'Highlighted path' },
  { id: 'buildings',  label: 'Buildings',    color: '#f2ede3', hint: 'Extruded footprints' },
  { id: 'roofs',      label: 'Roofs',        color: '#b0563c', hint: 'Pitched roofs on houses' },
  { id: 'trees',      label: 'Trees',        color: '#41763d', hint: 'Individual tree markers' },
  { id: 'rail',       label: 'Rail',         color: '#8a6d5a', hint: 'Train, tram and metro' },
  { id: 'roadsMajor', label: 'Main roads',   color: '#c8842e', hint: 'Motorway to secondary' },
  { id: 'roads',      label: 'Streets',      color: '#6e7681', hint: 'Everything else drivable' },
  { id: 'water',      label: 'Water',        color: '#3e8fc1', hint: 'Rivers, lakes and sea' },
  { id: 'green',      label: 'Parks',        color: '#6ba368', hint: 'Parks, forest and grass' },
  { id: 'ground',     label: 'Ground',       color: '#d8d2c2', hint: 'Everything not covered' },
  { id: 'frame',      label: 'Frame',        color: '#2f3640', hint: 'Border around the plate' },
  { id: 'label',      label: 'Nameplate',    color: '#f4f1ea', hint: 'Name bar below the map' },
];

export const PART_IDS = PARTS.map((p) => p.id);

export function partById(id) {
  return PARTS.find((p) => p.id === id);
}

export const DEFAULT_SETTINGS = {
  location: {
    lat: 40.7484,
    lon: -73.9857,
    label: 'New York',
  },

  shape: {
    type: 'circle',
    rotation: 0,
    aspect: 1.5,
    custom: null,
  },

  size: {
    areaMetres: 1500,
    printMm: 160,
  },

  layers: {
    buildings: true,
    roofs: true,
    roads: true,
    rail: true,
    water: true,
    green: true,
    trees: false,
    route: false,
    frame: true,
    nameplate: true,
  },

  heights: {
    base: 2.0,
    waterDepth: 0.7,
    green: 0.4,
    roads: 0.8,
    roadsMajor: 1.0,
    rail: 0.9,
    route: 2.0,
    frame: 3.0,
    label: 0.8,
    buildingMin: 1.2,
    buildingScale: 1.0,
    buildingMax: 60,
  },

  print: {
    minRoadWidthMm: 0.85,
    roadWidthScale: 1.0,
    minFeatureMm2: 0.5,
    simplifyMm: 0.1,
    frameWidthMm: 4,
    splitMajorRoads: true,
    buildingDetail: 'simple',
    maxTrees: 400,
    treeRadiusMm: 0.8,
    treeHeightMm: 2.4,
  },

  terrain: {
    enabled: false,
    exaggeration: 1.5,
    resolution: 32,
  },

  nameplate: {
    title: '',
    subtitle: '',
    barMm: 15,
    titleMm: 6.5,
    subtitleMm: 3.2,
  },

  route: {
    profile: 'auto',
    widthMetres: 8,
    minWidthMm: 1.4,
    waypoints: [],
    points: null,
    source: '',
    distance: 0,
    duration: 0,
  },

  colors: Object.fromEntries(PARTS.map((p) => [p.id, p.color])),
};

export function mergeSettings(base, patch) {
  if (!patch || typeof patch !== 'object') return structuredClone(base);
  const out = Array.isArray(base) ? [] : {};
  for (const key of Object.keys(base)) {
    const b = base[key];
    const p = patch[key];
    if (b && typeof b === 'object' && !Array.isArray(b) && b !== null) {
      out[key] = mergeSettings(b, p);
    } else {
      out[key] = p === undefined || p === null ? structuredClone(b) : p;
    }
  }
  for (const key of Object.keys(patch)) {
    if (!(key in out)) out[key] = patch[key];
  }
  return out;
}

export function defaultSettings() {
  return structuredClone(DEFAULT_SETTINGS);
}

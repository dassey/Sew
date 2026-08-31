const FEET_PER_METRE = 0.3048;
const METRES_PER_LEVEL = 3.2;

const TARGETS = {
  buildings: {
    label: 'Buildings',
    bucket: 'buildings',
    accepts: ['area'],
    tags: () => ({ building: 'yes' }),
  },
  water: {
    label: 'Water',
    bucket: 'water',
    accepts: ['area', 'line'],
    tags: (kind, mapping) =>
      kind === 'line'
        ? { waterway: 'stream', width: String(mapping.widthMetres || 6) }
        : { natural: 'water' },
  },
  green: {
    label: 'Parks & green',
    bucket: 'green',
    accepts: ['area'],
    tags: () => ({ leisure: 'park' }),
  },
  roads: {
    label: 'Streets',
    bucket: 'roads',
    accepts: ['line', 'area'],
    tags: (kind, mapping) =>
      kind === 'line'
        ? { highway: 'residential', width: String(mapping.widthMetres || 7) }
        : { highway: 'pedestrian', area: 'yes' },
  },
  rail: {
    label: 'Rail',
    bucket: 'rail',
    accepts: ['line'],
    tags: () => ({ railway: 'rail' }),
  },
  trees: {
    label: 'Trees',
    bucket: 'trees',
    accepts: ['point'],
    tags: () => ({ natural: 'tree' }),
  },
};

export const IMPORT_TARGETS = Object.entries(TARGETS).map(([id, t]) => ({
  id,
  label: t.label,
  accepts: t.accepts,
}));

export function defaultMapping(dataset) {
  const kind = dataset.kind;
  const part =
    kind === 'point' ? 'trees' : kind === 'line' ? 'roads' : 'buildings';
  return {
    part,
    mode: 'replace',
    heightField: null,
    heightUnit: 'm',
    heightScale: 1,
    defaultHeight: 8,
    nameField: null,
    widthMetres: 7,
    enabled: true,
  };
}

export function heightInMetres(properties, mapping) {
  const raw = mapping.heightField ? properties?.[mapping.heightField] : null;
  const value = typeof raw === 'number' ? raw : Number(raw);

  if (!Number.isFinite(value) || value <= 0) return mapping.defaultHeight || 8;

  const metres =
    mapping.heightUnit === 'ft'
      ? value * FEET_PER_METRE
      : mapping.heightUnit === 'levels'
        ? value * METRES_PER_LEVEL + 1
        : value;

  return Math.max(0.5, metres * (mapping.heightScale || 1));
}

function firstPoint(feature) {
  if (feature.kind === 'point') return feature.points[0];
  return feature.rings?.[0]?.points?.[0] || null;
}

function inside(point, bbox, margin = 0) {
  if (!point) return false;
  return (
    point.lat >= bbox.minLat - margin &&
    point.lat <= bbox.maxLat + margin &&
    point.lon >= bbox.minLon - margin &&
    point.lon <= bbox.maxLon + margin
  );
}

export function applyImports(osm, datasets) {
  const active = (datasets || []).filter((d) => d?.mapping?.enabled !== false && d.features?.length);
  if (!active.length) return { features: osm, stats: { added: 0, replaced: 0 } };

  const out = {};
  for (const [key, value] of Object.entries(osm)) out[key] = Array.isArray(value) ? value.slice() : value;

  let added = 0;
  let replaced = 0;

  for (const dataset of active) {
    const mapping = dataset.mapping;
    const target = TARGETS[mapping.part];
    if (!target) continue;
    const bucket = target.bucket;
    if (!Array.isArray(out[bucket])) out[bucket] = [];

    if (mapping.mode === 'replace') {
      const before = out[bucket].length;
      out[bucket] = out[bucket].filter((f) => {
        const point = bucket === 'trees' ? { lat: f.lat, lon: f.lon } : firstPoint({ rings: f.rings });
        return !inside(point, dataset.bbox);
      });
      replaced += before - out[bucket].length;
    }

    for (const feature of dataset.features) {
      if (!target.accepts.includes(feature.kind)) continue;

      if (bucket === 'trees') {
        for (const point of feature.points) {
          out.trees.push({ lat: point.lat, lon: point.lon, tags: { natural: 'tree' } });
          added++;
        }
        continue;
      }

      const tags = { ...target.tags(feature.kind, mapping) };
      if (mapping.part === 'buildings') {
        tags.height = String(heightInMetres(feature.properties, mapping));
      }
      if (mapping.nameField && feature.properties?.[mapping.nameField]) {
        tags.name = String(feature.properties[mapping.nameField]);
      }

      out[bucket].push({
        id: `import/${dataset.id}/${added}`,
        tags,
        rings: feature.rings,
        ...(bucket === 'water' && feature.kind === 'line' ? { linear: true } : {}),
      });
      added++;
    }
  }

  return { features: out, stats: { added, replaced } };
}

export function heightSummary(dataset, mapping) {
  if (!mapping.heightField) return null;
  const values = [];
  for (const f of dataset.features) {
    const h = heightInMetres(f.properties, mapping);
    if (Number.isFinite(h)) values.push(h);
    if (values.length >= 5000) break;
  }
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  return {
    min: values[0],
    median: values[Math.floor(values.length / 2)],
    max: values[values.length - 1],
    distinct: new Set(values.map((v) => Math.round(v))).size,
  };
}

const NULL_SHAPE = 0;
const POINT = 1;
const POLYLINE = 3;
const POLYGON = 5;
const MULTIPOINT = 8;

function baseType(type) {
  if (type >= 20) return type - 20;
  if (type >= 10) return type - 10;
  return type;
}

function signedArea(points) {
  let a = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    a += points[j][0] * points[i][1] - points[i][0] * points[j][1];
  }
  return a / 2;
}

export function readShp(shp) {
  const bytes = shp instanceof Uint8Array ? shp : new Uint8Array(shp);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (view.getInt32(0, false) !== 9994) {
    throw new Error('That .shp file has a bad header — is it really a shapefile?');
  }

  const fileType = view.getInt32(32, true);
  const bbox = {
    minX: view.getFloat64(36, true),
    minY: view.getFloat64(44, true),
    maxX: view.getFloat64(52, true),
    maxY: view.getFloat64(60, true),
  };

  const shapes = [];
  let offset = 100;
  const end = Math.min(view.getInt32(24, false) * 2, bytes.byteLength);

  while (offset + 8 <= end) {
    const contentLength = view.getInt32(offset + 4, false) * 2;
    let at = offset + 8;
    const type = view.getInt32(at, true);
    at += 4;

    if (baseType(type) === NULL_SHAPE) {
      shapes.push(null);
    } else if (baseType(type) === POINT) {
      shapes.push({ kind: 'point', points: [[view.getFloat64(at, true), view.getFloat64(at + 8, true)]] });
    } else if (baseType(type) === MULTIPOINT) {
      at += 32;
      const n = view.getInt32(at, true);
      at += 4;
      const points = [];
      for (let i = 0; i < n; i++) {
        points.push([view.getFloat64(at, true), view.getFloat64(at + 8, true)]);
        at += 16;
      }
      shapes.push({ kind: 'point', points });
    } else if (baseType(type) === POLYLINE || baseType(type) === POLYGON) {
      at += 32;
      const partCount = view.getInt32(at, true);
      const pointCount = view.getInt32(at + 4, true);
      at += 8;

      const starts = [];
      for (let i = 0; i < partCount; i++) {
        starts.push(view.getInt32(at, true));
        at += 4;
      }

      const flat = [];
      for (let i = 0; i < pointCount; i++) {
        flat.push([view.getFloat64(at, true), view.getFloat64(at + 8, true)]);
        at += 16;
      }

      const parts = [];
      for (let i = 0; i < partCount; i++) {
        const from = starts[i];
        const to = i + 1 < partCount ? starts[i + 1] : pointCount;
        if (to - from >= 2) parts.push(flat.slice(from, to));
      }

      shapes.push({
        kind: baseType(type) === POLYGON ? 'area' : 'line',
        parts,
      });
    } else {
      shapes.push(null);
    }

    offset += 8 + contentLength;
  }

  return { shapes, bbox, type: fileType };
}

export function readDbf(dbf, encoding = 'windows-1252') {
  const bytes = dbf instanceof Uint8Array ? dbf : new Uint8Array(dbf);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let decoder;
  try {
    decoder = new TextDecoder(encoding);
  } catch {
    decoder = new TextDecoder('windows-1252');
  }

  const recordCount = view.getUint32(4, true);
  const headerLength = view.getUint16(8, true);
  const recordLength = view.getUint16(10, true);

  const fields = [];
  for (let at = 32; at < headerLength - 1 && bytes[at] !== 0x0d; at += 32) {
    const name = decoder.decode(bytes.subarray(at, at + 11)).replace(/\0.*$/, '').trim();
    if (!name) continue;
    fields.push({
      name,
      type: String.fromCharCode(bytes[at + 11]),
      length: bytes[at + 16],
    });
  }

  const rows = [];
  for (let r = 0; r < recordCount; r++) {
    let at = headerLength + r * recordLength;
    if (at + recordLength > bytes.byteLength) break;
    const deleted = bytes[at] === 0x2a;
    at += 1;

    const row = {};
    for (const field of fields) {
      const text = decoder.decode(bytes.subarray(at, at + field.length)).trim();
      at += field.length;
      row[field.name] = decodeField(text, field.type);
    }
    rows.push(deleted ? null : row);
  }

  return { rows, fields };
}

function decodeField(text, type) {
  if (text === '') return null;
  switch (type) {
    case 'N':
    case 'F':
    case 'O':
    case 'B': {
      const n = Number(text);
      return Number.isFinite(n) ? n : null;
    }
    case 'L':
      return /^[yYtT]$/.test(text) ? true : /^[nNfF]$/.test(text) ? false : null;
    case 'D':
      return /^\d{8}$/.test(text)
        ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6)}`
        : text;
    default:
      return text;
  }
}

export function combine(shp, dbf) {
  const rows = dbf?.rows || [];
  const out = [];

  shp.shapes.forEach((shape, i) => {
    if (!shape) return;
    const properties = rows[i];
    if (properties === null) return;
    out.push({ ...shape, properties: properties || {} });
  });

  return out;
}

export function ringsToPolygons(parts) {
  const polygons = [];
  for (const part of parts) {
    const isOuter = signedArea(part) < 0;
    if (isOuter || !polygons.length) {
      polygons.push({ outer: part, holes: [] });
    } else {
      polygons[polygons.length - 1].holes.push(part);
    }
  }
  return polygons;
}

const HEADER_BYTES = 80;

function countTriangles(parts) {
  let n = 0;
  for (const p of parts) n += p.indices.length / 3;
  return n;
}

export function toBinaryStl(parts, header = '') {
  return new Blob([toStlBuffer(parts, header)], { type: 'model/stl' });
}

export function toStlBuffer(parts, header = '') {
  const triangles = countTriangles(parts);
  const buffer = new ArrayBuffer(HEADER_BYTES + 4 + triangles * 50);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  const banner = new TextEncoder().encode(header.slice(0, 79));
  bytes.set(banner.subarray(0, HEADER_BYTES), 0);
  view.setUint32(HEADER_BYTES, triangles, true);

  let offset = HEADER_BYTES + 4;
  for (const part of parts) {
    const pos = part.positions;
    const idx = part.indices;
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i] * 3;
      const b = idx[i + 1] * 3;
      const c = idx[i + 2] * 3;

      const ax = pos[a], ay = pos[a + 1], az = pos[a + 2];
      const bx = pos[b], by = pos[b + 1], bz = pos[b + 2];
      const cx = pos[c], cy = pos[c + 1], cz = pos[c + 2];

      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz);
      if (len > 0) {
        nx /= len;
        ny /= len;
        nz /= len;
      }

      view.setFloat32(offset, nx, true);
      view.setFloat32(offset + 4, ny, true);
      view.setFloat32(offset + 8, nz, true);
      view.setFloat32(offset + 12, ax, true);
      view.setFloat32(offset + 16, ay, true);
      view.setFloat32(offset + 20, az, true);
      view.setFloat32(offset + 24, bx, true);
      view.setFloat32(offset + 28, by, true);
      view.setFloat32(offset + 32, bz, true);
      view.setFloat32(offset + 36, cx, true);
      view.setFloat32(offset + 40, cy, true);
      view.setFloat32(offset + 44, cz, true);
      view.setUint16(offset + 48, 0, true);
      offset += 50;
    }
  }

  return buffer;
}

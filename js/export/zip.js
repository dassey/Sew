const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const time =
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    (Math.floor(date.getSeconds() / 2) & 0x1f);
  const day =
    ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function toBytes(content) {
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  return new TextEncoder().encode(String(content));
}

export function createZip(entries, mimeType = 'application/zip') {
  const encoder = new TextEncoder();
  const { time, day } = dosDateTime(new Date());

  const prepared = entries.map((e) => {
    const data = toBytes(e.data);
    return { name: encoder.encode(e.name), data, crc: crc32(data) };
  });

  let localSize = 0;
  let centralSize = 0;
  for (const e of prepared) {
    localSize += 30 + e.name.length + e.data.length;
    centralSize += 46 + e.name.length;
  }

  const buffer = new ArrayBuffer(localSize + centralSize + 22);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let offset = 0;

  const offsets = [];
  for (const e of prepared) {
    offsets.push(offset);
    view.setUint32(offset, 0x04034b50, true);
    view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, 0x0800, true);
    view.setUint16(offset + 8, 0, true);
    view.setUint16(offset + 10, time, true);
    view.setUint16(offset + 12, day, true);
    view.setUint32(offset + 14, e.crc, true);
    view.setUint32(offset + 18, e.data.length, true);
    view.setUint32(offset + 22, e.data.length, true);
    view.setUint16(offset + 26, e.name.length, true);
    view.setUint16(offset + 28, 0, true);
    bytes.set(e.name, offset + 30);
    bytes.set(e.data, offset + 30 + e.name.length);
    offset += 30 + e.name.length + e.data.length;
  }

  const centralStart = offset;
  for (let i = 0; i < prepared.length; i++) {
    const e = prepared[i];
    view.setUint32(offset, 0x02014b50, true);
    view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, 20, true);
    view.setUint16(offset + 8, 0x0800, true);
    view.setUint16(offset + 10, 0, true);
    view.setUint16(offset + 12, time, true);
    view.setUint16(offset + 14, day, true);
    view.setUint32(offset + 16, e.crc, true);
    view.setUint32(offset + 20, e.data.length, true);
    view.setUint32(offset + 24, e.data.length, true);
    view.setUint16(offset + 28, e.name.length, true);
    view.setUint16(offset + 30, 0, true);
    view.setUint16(offset + 32, 0, true);
    view.setUint16(offset + 34, 0, true);
    view.setUint16(offset + 36, 0, true);
    view.setUint32(offset + 38, 0, true);
    view.setUint32(offset + 42, offsets[i], true);
    bytes.set(e.name, offset + 46);
    offset += 46 + e.name.length;
  }

  view.setUint32(offset, 0x06054b50, true);
  view.setUint16(offset + 4, 0, true);
  view.setUint16(offset + 6, 0, true);
  view.setUint16(offset + 8, prepared.length, true);
  view.setUint16(offset + 10, prepared.length, true);
  view.setUint32(offset + 12, offset - centralStart, true);
  view.setUint32(offset + 16, centralStart, true);
  view.setUint16(offset + 20, 0, true);

  return new Blob([buffer], { type: mimeType });
}

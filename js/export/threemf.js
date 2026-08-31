import { createZip } from './zip.js';

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

function escapeXml(str) {
  return String(str).replace(/[<>&"']/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]
  );
}

function toDisplayColor(hex) {
  const clean = String(hex || '#cccccc').replace('#', '');
  const rgb = clean.length === 3
    ? clean.split('').map((c) => c + c).join('')
    : clean.padEnd(6, 'c').slice(0, 6);
  return `#${rgb.toUpperCase()}FF`;
}

export function to3mf(parts, meta = {}) {
  const usable = parts.filter((p) => p.indices.length >= 3);
  if (!usable.length) throw new Error('Nothing to export.');

  const materials = usable
    .map(
      (p) =>
        `      <base name="${escapeXml(p.label || p.id)}" displaycolor="${toDisplayColor(p.color)}"/>`
    )
    .join('\n');

  const objects = [];
  usable.forEach((part, index) => {
    const objectId = index + 2;
    const pos = part.positions;
    const idx = part.indices;

    const vertices = [];
    for (let i = 0; i < pos.length; i += 3) {
      vertices.push(
        `<vertex x="${fmt(pos[i])}" y="${fmt(pos[i + 1])}" z="${fmt(pos[i + 2])}"/>`
      );
    }
    const triangles = [];
    for (let i = 0; i < idx.length; i += 3) {
      triangles.push(
        `<triangle v1="${idx[i]}" v2="${idx[i + 1]}" v3="${idx[i + 2]}"/>`
      );
    }

    objects.push(
      `    <object id="${objectId}" name="${escapeXml(part.label || part.id)}" type="model" pid="1" pindex="${index}">
      <mesh>
        <vertices>${vertices.join('')}</vertices>
        <triangles>${triangles.join('')}</triangles>
      </mesh>
    </object>`
    );
  });

  const assemblyId = usable.length + 2;
  const components = usable
    .map((_, i) => `      <component objectid="${i + 2}"/>`)
    .join('\n');

  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <metadata name="Title">${escapeXml(meta.title || 'Skyline model')}</metadata>
  <metadata name="Designer">${escapeXml(meta.designer || '')}</metadata>
  <metadata name="Description">${escapeXml(meta.description || '')}</metadata>
  <metadata name="Application">${escapeXml(meta.application || 'Skyline Forge')}</metadata>
  <resources>
    <basematerials id="1">
${materials}
    </basematerials>
${objects.join('\n')}
    <object id="${assemblyId}" name="${escapeXml(meta.title || 'Model')}" type="model">
      <components>
${components}
      </components>
    </object>
  </resources>
  <build>
    <item objectid="${assemblyId}"/>
  </build>
</model>`;

  return createZip(
    [
      { name: '[Content_Types].xml', data: CONTENT_TYPES },
      { name: '_rels/.rels', data: RELS },
      { name: '3D/3dmodel.model', data: model },
    ],
    'model/3mf'
  );
}

function fmt(v) {
  return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/\.?0+$/, '');
}

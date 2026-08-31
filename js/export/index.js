import { toBinaryStl, toStlBuffer } from './stl.js';
import { to3mf } from './threemf.js';
import { toObj } from './obj.js';
import { createZip } from './zip.js';

export const FORMATS = [
  {
    id: '3mf',
    label: '3MF — colour',
    ext: '3mf',
    detail: 'One object, one coloured part per layer. Best for multi-material.',
  },
  {
    id: 'stl',
    label: 'STL — single file',
    ext: 'stl',
    detail: 'Every layer merged into one file. Universal, but no colour.',
  },
  {
    id: 'stl-parts',
    label: 'STL — one per layer',
    ext: 'zip',
    detail: 'A ZIP of separate STLs. Load them together for filament swaps.',
  },
  {
    id: 'obj',
    label: 'OBJ + MTL',
    ext: 'zip',
    detail: 'For Blender and renderers. Keeps colours as materials.',
  },
];

export function slugify(text, fallback = 'skyline') {
  const slug = String(text || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || fallback;
}

function banner(meta) {
  return `Skyline Forge | ${meta.title || 'model'} | ${meta.coords || ''}`.slice(0, 79);
}

export function buildExport(format, parts, meta = {}) {
  const usable = parts.filter((p) => p.indices.length >= 3);
  if (!usable.length) throw new Error('There is no geometry to export yet.');

  const stem = slugify(meta.title, 'skyline');

  switch (format) {
    case 'stl':
      return {
        blob: toBinaryStl(usable, banner(meta)),
        filename: `${stem}.stl`,
      };

    case 'stl-parts': {
      const entries = usable.map((part, i) => ({
        name: `${String(i + 1).padStart(2, '0')}-${slugify(part.id, part.id)}.stl`,
        data: new Uint8Array(toStlBuffer([part], `${banner(meta)} | ${part.label}`)),
      }));
      entries.push({ name: 'README.txt', data: partsReadme(usable, meta) });
      return {
        blob: createZip(entries),
        filename: `${stem}-parts.zip`,
      };
    }

    case 'obj': {
      const { obj, mtl } = toObj(usable, stem);
      return {
        blob: createZip([
          { name: `${stem}.obj`, data: obj },
          { name: `${stem}.mtl`, data: mtl },
        ]),
        filename: `${stem}-obj.zip`,
      };
    }

    case '3mf':
    default:
      return {
        blob: to3mf(usable, {
          title: meta.title || 'Skyline model',
          description: meta.description || '',
          application: 'Skyline Forge',
        }),
        filename: `${stem}.3mf`,
      };
  }
}

function partsReadme(parts, meta) {
  const lines = ['Skyline Forge — per-layer STL bundle', '====================================', ''];
  if (meta.title) lines.push(`Model:  ${meta.title}`);
  if (meta.coords) lines.push(`Centre: ${meta.coords}`);
  if (meta.scale) lines.push(`Scale:  ${meta.scale}`);
  lines.push(
    '',
    'Every file below is a separate watertight solid, already positioned so',
    'that importing all of them together reassembles the model exactly. No',
    'moving, scaling or rotating is needed.',
    '',
    'PrusaSlicer / OrcaSlicer / Bambu Studio:',
    '  1. Import the first STL.',
    '  2. Right-click it, "Add part" -> "Load", and add the rest.',
    '  3. Assign a filament to each part.',
    '',
    'Cura:',
    '  1. Open all files at once; Cura keeps their shared origin.',
    '  2. Select all, then "Merge models" (Ctrl+Alt+G).',
    '',
    'Single-colour printing: use the merged .stl export instead.',
    '',
    'Layers in this bundle:'
  );
  parts.forEach((p, i) => {
    lines.push(
      `  ${String(i + 1).padStart(2, '0')}. ${p.label.padEnd(12)} ${p.color}   ` +
        `${p.triangleCount.toLocaleString()} triangles`
    );
  });
  lines.push('', 'Map data © OpenStreetMap contributors (ODbL).');
  return lines.join('\n');
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

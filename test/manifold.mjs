import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || join(HERE, 'out', 'manhattan-midtown.3mf');

function readModelXml(path) {
  return execFileSync('unzip', ['-p', path, '3D/3dmodel.model'], {
    maxBuffer: 1 << 30,
    encoding: 'utf8',
  });
}

function parseObjects(xml) {
  const objects = [];
  const objectRe = /<object id="(\d+)"[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/object>/g;
  let m;
  while ((m = objectRe.exec(xml))) {
    const [, id, name, body] = m;
    if (!body.includes('<mesh>')) continue;

    const verts = [];
    const vre = /<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/g;
    let v;
    while ((v = vre.exec(body))) {
      verts.push([v[1], v[2], v[3]]);
    }

    const tris = [];
    const tre = /<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"/g;
    let t;
    while ((t = tre.exec(body))) {
      tris.push([+t[1], +t[2], +t[3]]);
    }

    objects.push({ id, name, verts, tris });
  }
  return objects;
}

function analyse(objects, { merge }) {
  const key = new Map();
  const idOf = (v) => {
    const k = `${v[0]},${v[1]},${v[2]}`;
    let id = key.get(k);
    if (id === undefined) {
      id = key.size;
      key.set(k, id);
    }
    return id;
  };

  const edges = new Map();
  let degenerate = 0;
  let triangles = 0;

  const bump = (a, b) => {
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    edges.set(k, (edges.get(k) || 0) + 1);
  };

  const groups = merge ? [objects.flatMap((o) => o.tris.map((t) => [o, t]))] : objects.map((o) => o.tris.map((t) => [o, t]));

  for (const group of groups) {
    for (const [obj, tri] of group) {
      const [a, b, c] = tri.map((i) => idOf(obj.verts[i]));
      triangles++;
      if (a === b || b === c || a === c) {
        degenerate++;
        continue;
      }
      bump(a, b);
      bump(b, c);
      bump(c, a);
    }
    if (!merge) {
      key.clear();
    }
  }

  let boundary = 0;
  let shared = 0;
  let odd = 0;
  for (const [, n] of edges) {
    if (n === 2) continue;
    if (n === 1) boundary++;
    else if (n % 2 === 0) shared++;
    else odd++;
  }
  return { triangles, degenerate, boundary, shared, odd, edges: edges.size };
}

const xml = readModelXml(file);
const objects = parseObjects(xml);

console.log(`\n${file}`);
console.log(`${objects.length} objects, ${objects.reduce((n, o) => n + o.tris.length, 0).toLocaleString()} triangles\n`);

console.log('Per object, welded by the coordinates in the file:');
let totalBoundary = 0;
let totalDegenerate = 0;
for (const obj of objects) {
  const r = analyse([obj], { merge: true });
  totalBoundary += r.boundary;
  totalDegenerate += r.degenerate;
  const flag = r.boundary || r.odd || r.degenerate ? ' <-- problem' : '';
  console.log(
    `  ${obj.name.padEnd(12)} ${String(obj.tris.length).padStart(7)} tris  ` +
      `${String(obj.verts.length).padStart(7)} verts  ` +
      `holes ${String(r.boundary).padStart(5)}  ` +
      `shared ${String(r.shared).padStart(5)}  ` +
      `odd ${String(r.odd).padStart(4)}  ` +
      `degenerate ${String(r.degenerate).padStart(4)}${flag}`
  );
}

const merged = analyse(objects, { merge: true });
console.log('\nAll objects welded together, as a slicer sees the assembly:');
console.log(`  unique edges       ${merged.edges.toLocaleString()}`);
console.log(`  holes (1 triangle) ${merged.boundary.toLocaleString()}`);
console.log(`  shared (4+)        ${merged.shared.toLocaleString()}`);
console.log(`  odd (3, 5, …)      ${merged.odd.toLocaleString()}`);
console.log(`  degenerate faces   ${merged.degenerate.toLocaleString()}`);
console.log(
  `\n  non-manifold total ${(merged.boundary + merged.shared + merged.odd).toLocaleString()}`
);
console.log(`  per-object holes   ${totalBoundary.toLocaleString()}`);
console.log(`  per-object degen   ${totalDegenerate.toLocaleString()}\n`);

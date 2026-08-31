import { createProjection } from '../core/projection.js';
import * as G from '../core/geom.js';
import {
  MeshBuilder,
  extrudePolygon,
  extrudeMultiPolygon,
  addCone,
} from '../core/mesh.js';
import { addRoof } from '../core/roof.js';
import { buildShapeRing, inscribedRadiusOf } from '../core/shapes.js';
import { makeSampler } from '../data/elevation.js';
import { seaFromCoastline } from './coastline.js';
import { layoutText } from './text.js';
import { PARTS } from './parts.js';
import * as T from './tags.js';

function featureToMultiPolygon(feature, toMm) {
  const outers = [];
  const inners = [];

  for (const ring of feature.rings) {
    const pts = G.dedupe(ring.points.map((p) => toMm(p.lat, p.lon)));
    if (pts.length < 3) continue;
    const closed = G.closeRing(pts);
    if (closed.length < 4) continue;
    (ring.role === 'inner' ? inners : outers).push(closed);
  }
  if (!outers.length) return [];

  const polys = outers.map((o) => [o]);
  for (const hole of inners) {
    const owner = polys.find((p) => G.pointInRing(hole[0], p[0])) || polys[0];
    owner.push(hole);
  }
  return polys;
}

function featureToPolylines(feature, toMm) {
  const out = [];
  for (const ring of feature.rings) {
    const pts = G.dedupe(ring.points.map((p) => toMm(p.lat, p.lon)));
    if (pts.length >= 2) out.push(pts);
  }
  return out;
}

function bboxOfRing(ring) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

function bboxOverlaps(a, b) {
  return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
}

function bboxWithinRadius(box, radius) {
  if (radius <= 0) return false;
  const x = Math.max(Math.abs(box.minX), Math.abs(box.maxX));
  const y = Math.max(Math.abs(box.minY), Math.abs(box.maxY));
  return x * x + y * y <= radius * radius;
}

function horizontalSpanAt(ring, y) {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    if (y1 === y2) continue;
    if (y < Math.min(y1, y2) || y > Math.max(y1, y2)) continue;
    const x = x1 + ((x2 - x1) * (y - y1)) / (y2 - y1);
    if (x < min) min = x;
    if (x > max) max = x;
  }
  return isFinite(min) ? max - min : 0;
}

function dropNestedBuildings(shapes) {
  if (shapes.length < 2) return 0;

  const areaOf = (b) => (b.box.maxX - b.box.minX) * (b.box.maxY - b.box.minY);
  const order = shapes.map((_, i) => i).sort((a, b) => areaOf(shapes[b]) - areaOf(shapes[a]));

  const CELL = 8;
  const buckets = new Map();
  const cellsOf = (box) => {
    const out = [];
    for (let c = Math.floor(box.minX / CELL); c <= Math.floor(box.maxX / CELL); c++) {
      for (let r = Math.floor(box.minY / CELL); r <= Math.floor(box.maxY / CELL); r++) {
        out.push(`${c},${r}`);
      }
    }
    return out;
  };

  const removed = new Set();
  for (const index of order) {
    const b = shapes[index];
    const cells = cellsOf(b.box);

    let swallowed = false;
    for (const cell of cells) {
      for (const other of buckets.get(cell) || []) {
        const o = shapes[other];
        if (o.heightM < b.heightM * 0.98) continue;
        if (
          b.box.minX < o.box.minX || b.box.maxX > o.box.maxX ||
          b.box.minY < o.box.minY || b.box.maxY > o.box.maxY
        ) continue;
        if (!G.difference([b.poly], [o.poly]).length) {
          swallowed = true;
          break;
        }
      }
      if (swallowed) break;
    }

    if (swallowed) {
      removed.add(index);
      continue;
    }
    for (const cell of cells) {
      if (!buckets.has(cell)) buckets.set(cell, []);
      buckets.get(cell).push(index);
    }
  }

  if (!removed.size) return 0;
  const kept = shapes.filter((_, i) => !removed.has(i));
  shapes.length = 0;
  shapes.push(...kept);
  return removed.size;
}

function centroidOf(ring) {
  let x = 0;
  let y = 0;
  const n = ring.length - 1;
  for (let i = 0; i < n; i++) {
    x += ring[i][0];
    y += ring[i][1];
  }
  return [x / n, y / n];
}

export function buildModel(features, s, ctx = {}) {
  const report = (fraction, message) => ctx.onProgress?.(fraction, message);
  const warnings = [];
  const t0 = Date.now();

  const proj = createProjection(s.location.lat, s.location.lon);
  const mmPerMetre = s.size.printMm / s.size.areaMetres;
  const radiusMm = s.size.printMm / 2;
  const toMm = (lat, lon) => {
    const [x, y] = proj.forward(lat, lon);
    return [x * mmPerMetre, y * mmPerMetre];
  };

  const simplifyTol = Math.max(0.01, s.print.simplifyMm);
  const minArea = Math.max(0.01, s.print.minFeatureMm2);

  report(0.02, 'Laying out the plate…');

  const shapeRing = buildShapeRing({
    shape: s.shape.type,
    radius: radiusMm,
    rotation: s.shape.rotation,
    aspect: s.shape.aspect,
    custom:
      s.shape.type === 'custom' && s.shape.custom
        ? s.shape.custom.map(([lat, lon]) => toMm(lat, lon))
        : null,
  });
  const shapeMp = [[shapeRing]];
  const shapeBox = bboxOfRing(shapeRing);

  const nameplateOn =
    s.layers.nameplate && (s.nameplate.title || s.nameplate.subtitle);
  let barMp = [];
  let barBox = null;
  if (nameplateOn) {
    const halfW = ((shapeBox.maxX - shapeBox.minX) / 2) * 0.86;

    const plateHeight = shapeBox.maxY - shapeBox.minY;
    const wantContact = halfW * 0.6;
    const maxRaise = plateHeight * 0.35;
    let raise = Math.min(3, s.nameplate.barMm * 0.2);
    for (let y = 0; y <= maxRaise; y += Math.max(0.5, plateHeight / 120)) {
      if (horizontalSpanAt(shapeRing, shapeBox.minY + y) >= wantContact) {
        raise = Math.max(raise, y + 1);
        break;
      }
      raise = Math.min(maxRaise, y);
    }

    const top = shapeBox.minY + raise;
    const bottom = shapeBox.minY - s.nameplate.barMm;
    barBox = { minX: -halfW, maxX: halfW, minY: bottom, maxY: top };
    barMp = [[
      G.closeRing([
        [-halfW, bottom],
        [halfW, bottom],
        [halfW, top],
        [-halfW, top],
      ]),
    ]];
  }

  const plateMp = barMp.length ? G.union(shapeMp, barMp) : shapeMp;

  let rimMp = [];
  let innerMp = plateMp;
  const frameOn = s.layers.frame && s.print.frameWidthMm > 0.2;
  if (frameOn) {
    const band = G.bandAroundRings(plateMp, s.print.frameWidthMm);
    rimMp = G.snapMultiPolygon(G.intersection(band, plateMp));
    innerMp = G.difference(plateMp, rimMp);
    if (!innerMp.length) {
      warnings.push('The frame is wider than the plate — reduce the frame width.');
      innerMp = plateMp;
      rimMp = [];
    }
  }

  const cityArea = G.snapMultiPolygon(barMp.length ? G.intersection(innerMp, shapeMp) : innerMp);
  const plaqueArea = barMp.length ? G.snapMultiPolygon(G.difference(innerMp, shapeMp)) : [];

  const terrain =
    s.terrain.enabled && ctx.heightGrid
      ? makeSampler(
          ctx.heightGrid,
          proj,
          mmPerMetre,
          s.terrain.exaggeration,
          ctx.heightGrid.min
        )
      : null;
  const groundZ = terrain || (() => 0);
  const baseTop = (x, y) => groundZ(x, y) + s.heights.base;
  const gridCell = Math.max(3, s.size.printMm / Math.max(8, s.terrain.resolution));

  const plateBox = bboxOfRing(plateMp[0][0]);
  const inPlate = (box) => bboxOverlaps(box, plateBox);

  report(0.08, 'Reading buildings…');

  const buildingShapes = [];
  if (s.layers.buildings) {
    for (const f of features.buildings) {
      if (s.print.buildingDetail === 'simple' && !f.tags.building) continue;
      if (T.isUnderground(f.tags)) continue;
      const mp = featureToMultiPolygon(f, toMm);
      if (!mp.length) continue;
      const heightM = T.buildingHeight(f.tags);
      for (const poly of mp) {
        const box = bboxOfRing(poly[0]);
        if (!inPlate(box)) continue;
        const areaM2 =
          Math.abs(G.ringArea(poly[0])) / (mmPerMetre * mmPerMetre);
        const roof = T.roofSpec(f.tags, { areaM2, heightM });
        buildingShapes.push({ poly, box, heightM, roof, tags: f.tags });
      }
    }
  }

  const duplicates = dropNestedBuildings(buildingShapes);
  if (duplicates >= 25) {
    warnings.push(
      `Skipped ${duplicates} building outlines that were nested inside others.`
    );
  }

  report(0.14, 'Reading streets…');

  const roadLines = { major: [], minor: [], service: [], path: [] };
  if (s.layers.roads) {
    for (const f of features.roads) {
      if (T.isUnderground(f.tags)) continue;
      const width = T.roadWidth(f.tags);
      if (!width) continue;
      const cls = T.roadClass(f.tags);
      for (const line of featureToPolylines(f, toMm)) {
        if (!inPlate(bboxOfRing(line))) continue;
        roadLines[cls].push({ points: G.simplify(line, simplifyTol), width });
      }
    }
  }

  const railLines = [];
  if (s.layers.rail) {
    for (const f of features.rail) {
      if (T.isUnderground(f.tags)) continue;
      const width = T.railWidth(f.tags);
      if (!width) continue;
      for (const line of featureToPolylines(f, toMm)) {
        if (!inPlate(bboxOfRing(line))) continue;
        railLines.push({ points: G.simplify(line, simplifyTol), width });
      }
    }
  }

  report(0.2, 'Reading water and parks…');

  let waterMp = [];
  const waterLines = [];
  if (s.layers.water) {
    const areas = [];
    for (const f of features.water) {
      if (!T.isVisibleWater(f.tags)) continue;
      if (f.linear) {
        const w = T.waterwayWidth(f.tags);
        if (!w) continue;
        for (const line of featureToPolylines(f, toMm)) {
          if (!inPlate(bboxOfRing(line))) continue;
          waterLines.push({ points: G.simplify(line, simplifyTol), width: w });
        }
      } else {
        for (const poly of featureToMultiPolygon(f, toMm)) {
          if (inPlate(bboxOfRing(poly[0]))) areas.push(poly);
        }
      }
    }
    waterMp = G.normalize(areas);

    if (waterLines.length) {
      const buffered = G.bufferPolylines(waterLines, (l) =>
        Math.max(l.width * mmPerMetre, 0.6) / 2
      );
      waterMp = G.union(waterMp, buffered);
    }

    if (features.coastline.length) {
      const chains = [];
      for (const f of features.coastline) {
        for (const line of featureToPolylines(f, toMm)) chains.push(line);
      }
      try {
        const sea = seaFromCoastline(chains, shapeRing);
        if (sea.length) waterMp = G.union(waterMp, sea);
      } catch (err) {
        warnings.push(`Could not resolve the coastline (${err.message}).`);
      }
    }
  }

  let greenMp = [];
  const plazaPolys = [];
  if (s.layers.green) {
    const areas = [];
    for (const f of features.green) {
      const mp = featureToMultiPolygon(f, toMm);
      for (const poly of mp) {
        if (!inPlate(bboxOfRing(poly[0]))) continue;
        (f.pedestrianArea ? plazaPolys : areas).push(poly);
      }
    }
    greenMp = G.normalize(areas);
  }

  report(0.26, 'Placing the route…');

  let routeMp = [];
  if (s.layers.route && ctx.routePoints?.length >= 2) {
    const line = G.dedupe(ctx.routePoints.map(([lat, lon]) => toMm(lat, lon)));
    if (line.length >= 2) {
      const hw =
        Math.max(s.route.widthMetres * mmPerMetre, s.route.minWidthMm) / 2;
      const ring = G.bufferPolyline(G.simplify(line, simplifyTol * 0.5), hw, {
        capStyle: 'round',
        arcSegments: 10,
      });
      if (ring) routeMp = G.intersection(G.normalize([[ring]]), cityArea);
    }
  }

  report(0.34, 'Widening streets to printable size…');

  const minHalf = s.print.minRoadWidthMm / 2;
  const halfWidthFor = (line) =>
    Math.max((line.width * mmPerMetre * s.print.roadWidthScale) / 2, minHalf);

  const majorSplit = s.print.splitMajorRoads;
  const majorSource = majorSplit ? roadLines.major : [];
  const minorSource = majorSplit
    ? [...roadLines.minor, ...roadLines.service, ...roadLines.path]
    : [
        ...roadLines.major,
        ...roadLines.minor,
        ...roadLines.service,
        ...roadLines.path,
      ];

  let roadsMajorMp = majorSource.length
    ? G.bufferPolylines(majorSource, halfWidthFor)
    : [];
  let roadsMp = minorSource.length
    ? G.bufferPolylines(minorSource, halfWidthFor)
    : [];
  if (plazaPolys.length) {
    roadsMp = G.union(roadsMp, G.normalize(plazaPolys));
  }

  let railMp = railLines.length
    ? G.bufferPolylines(railLines, (l) =>
        Math.max((l.width * mmPerMetre) / 2, minHalf)
      )
    : [];

  let textMp = [];
  if (nameplateOn && ctx.font) {
    const cx = 0;
    const maxTextW = (barBox.maxX - barBox.minX) * 0.9;
    const hasSub = Boolean(s.nameplate.subtitle);
    const barMid = (barBox.minY + Math.min(barBox.maxY, shapeBox.minY)) / 2;

    const lines = [];
    if (s.nameplate.title) {
      lines.push({
        text: s.nameplate.title.toUpperCase(),
        size: s.nameplate.titleMm,
        y: hasSub ? barMid + s.nameplate.subtitleMm * 0.55 : barMid - s.nameplate.titleMm * 0.35,
        tracking: s.nameplate.titleMm * 0.12,
      });
    }
    if (hasSub) {
      lines.push({
        text: s.nameplate.subtitle,
        size: s.nameplate.subtitleMm,
        y: barMid - s.nameplate.subtitleMm * 1.6,
        tracking: s.nameplate.subtitleMm * 0.16,
      });
    }

    const polys = [];
    for (const line of lines) {
      const laid = layoutText(ctx.font, line.text, {
        size: line.size,
        tracking: line.tracking,
        align: 'center',
        x: cx,
        y: line.y,
        maxWidth: maxTextW,
      });
      polys.push(...laid.polygons);
    }
    if (polys.length) {
      textMp = G.snapMultiPolygon(G.intersection(G.normalize(polys), innerMp));
    }
  }

  report(0.46, 'Resolving overlaps between layers…');

  const tidy = (mp) =>
    mp.length
      ? G.dropTinyPolygons(
          G.snapMultiPolygon(G.normalize(G.simplifyMultiPolygon(mp, simplifyTol))),
          minArea
        )
      : [];

  routeMp = tidy(routeMp);
  roadsMajorMp = tidy(roadsMajorMp);
  roadsMp = tidy(roadsMp);
  railMp = tidy(railMp);
  waterMp = tidy(waterMp);
  greenMp = tidy(greenMp);

  let claimed = textMp.length ? textMp.slice() : [];

  const claim = (mp, clipTo = cityArea) => {
    if (!mp.length) return [];
    const bounded = G.intersection(mp, clipTo);
    if (!bounded.length) return [];
    const region = claimed.length ? G.difference(bounded, claimed) : bounded;
    const kept = G.dropTinyPolygons(region, minArea);
    if (kept.length) claimed = claimed.length ? G.union(claimed, kept) : G.normalize(kept);
    return kept;
  };

  const routeRegion = claim(routeMp);

  report(0.54, 'Fitting buildings…');
  const buildingsPlaced = [];
  let builtUpArea = 0;
  if (buildingShapes.length) {
    const routeBox = routeRegion.length ? G.boundsOf(routeRegion) : null;
    const safeRadius = G.pointInRing([0, 0], shapeRing)
      ? inscribedRadiusOf(shapeRing) - (frameOn ? s.print.frameWidthMm : 0)
      : 0;

    for (const b of buildingShapes) {
      let poly = [b.poly];
      if (!bboxWithinRadius(b.box, safeRadius)) {
        poly = G.intersection([b.poly], cityArea);
        if (!poly.length) continue;
      }
      if (routeBox && bboxOverlaps(b.box, routeBox)) {
        poly = G.difference(poly, routeRegion);
        if (!poly.length) continue;
      }
      poly = G.dropTinyPolygons(
        G.snapMultiPolygon(G.simplifyMultiPolygon(poly, simplifyTol)),
        minArea
      );
      if (!poly.length) continue;
      buildingsPlaced.push({ mp: poly, heightM: b.heightM, roof: b.roof });
    }

    const allFootprints = [];
    for (const b of buildingsPlaced) allFootprints.push(...b.mp);
    if (allFootprints.length) {
      const merged = G.normalize(allFootprints);
      builtUpArea = G.multiPolygonArea(merged);
      claimed = claimed.length ? G.union(claimed, merged) : merged;
    }
  }

  report(0.62, 'Resolving rail, water and parks…');
  const railRegion = claim(railMp);
  const roadsMajorRegion = claim(roadsMajorMp);
  const roadsRegion = claim(roadsMp);
  const waterRegion = claim(waterMp);
  const greenRegion = claim(greenMp);
  const groundRegion = claimed.length ? G.difference(cityArea, claimed) : cityArea;

  const plaqueRegion = plaqueArea.length
    ? textMp.length
      ? G.difference(plaqueArea, textMp)
      : plaqueArea
    : [];

  report(0.72, 'Extruding geometry…');

  const meshes = new Map();
  const meshFor = (id) => {
    if (!meshes.has(id)) meshes.set(id, new MeshBuilder(id));
    return meshes.get(id);
  };

  const dice = (mp) =>
    terrain ? G.gridSplit(G.densifyMultiPolygon(mp, gridCell), gridCell) : mp;

  if (groundRegion.length) {
    extrudeMultiPolygon(meshFor('ground'), dice(groundRegion), 0, baseTop);
  }

  if (greenRegion.length) {
    const top = (x, y) => baseTop(x, y) + s.heights.green;
    extrudeMultiPolygon(meshFor('green'), dice(greenRegion), 0, top);
  }

  if (waterRegion.length) {
    const depth = Math.min(s.heights.waterDepth, s.heights.base - 0.6);
    const mesh = meshFor('water');
    for (const poly of waterRegion) {
      const [cx, cy] = centroidOf(poly[0]);
      const top = baseTop(cx, cy) - Math.max(0.2, depth);
      extrudePolygon(mesh, poly, 0, top);
    }
  }

  const linearTop = (offset) => (x, y) => baseTop(x, y) + offset;
  const drape = (mp) => (terrain ? G.densifyMultiPolygon(mp, gridCell) : mp);

  if (roadsRegion.length) {
    extrudeMultiPolygon(meshFor('roads'), drape(roadsRegion), 0, linearTop(s.heights.roads));
  }
  if (roadsMajorRegion.length) {
    extrudeMultiPolygon(
      meshFor('roadsMajor'),
      drape(roadsMajorRegion),
      0,
      linearTop(s.heights.roadsMajor)
    );
  }
  if (railRegion.length) {
    extrudeMultiPolygon(meshFor('rail'), drape(railRegion), 0, linearTop(s.heights.rail));
  }
  if (routeRegion.length) {
    extrudeMultiPolygon(meshFor('route'), drape(routeRegion), 0, linearTop(s.heights.route));
  }

  report(0.82, 'Extruding buildings…');
  if (buildingsPlaced.length) {
    const mesh = meshFor('buildings');
    const scale = mmPerMetre * s.heights.buildingScale;
    const roofsOn = s.layers.roofs !== false;
    const roofOpts = { metreScale: scale, minRoofMm: 0.2, minHalfWidthMm: 0.35 };
    for (const b of buildingsPlaced) {
      const raw = b.heightM * scale;
      const h = Math.min(Math.max(raw, s.heights.buildingMin), s.heights.buildingMax);
      for (const poly of b.mp) {
        const [cx, cy] = centroidOf(poly[0]);
        const z0 = baseTop(cx, cy);
        const wallTop =
          roofsOn && b.roof
            ? addRoof(meshFor('roofs'), poly, z0, h, b.roof, roofOpts)
            : null;
        extrudePolygon(mesh, poly, 0, wallTop ?? z0 + h);
      }
    }
  }

  if (rimMp.length) {
    extrudeMultiPolygon(meshFor('frame'), rimMp, 0, s.heights.base + s.heights.frame);
  }
  if (plaqueRegion.length) {
    const mesh = meshFor(rimMp.length ? 'frame' : 'ground');
    extrudeMultiPolygon(mesh, plaqueRegion, 0, s.heights.base);
  }
  if (textMp.length) {
    const mesh = meshFor('label');
    extrudeMultiPolygon(mesh, textMp, 0, s.heights.base + s.heights.label);
  }

  if (s.layers.trees) {
    report(0.9, 'Planting trees…');
    const mesh = meshFor('trees');
    const buildingBoxes = buildingShapes.map((b) => b.box);
    const candidates = [];

    for (const t of features.trees) {
      const [x, y] = toMm(t.lat, t.lon);
      candidates.push([x, y]);
    }
    for (const f of features.treeRows) {
      for (const line of featureToPolylines(f, toMm)) {
        const spacing = Math.max(2.5, s.print.treeRadiusMm * 4);
        for (const p of G.densify(line, spacing)) candidates.push(p);
      }
    }

    const stride = Math.max(1, Math.ceil(candidates.length / s.print.maxTrees));
    let planted = 0;
    for (let i = 0; i < candidates.length; i += stride) {
      const [x, y] = candidates[i];
      if (!G.pointInMultiPolygon([x, y], cityArea)) continue;
      if (buildingBoxes.some((b) => x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY)) {
        continue;
      }
      const z0 = baseTop(x, y) - 0.3;
      addCone(
        mesh,
        x,
        y,
        z0,
        z0 + s.print.treeHeightMm,
        s.print.treeRadiusMm,
        s.print.treeRadiusMm * 0.25,
        7
      );
      planted++;
    }
    if (!planted && candidates.length) {
      warnings.push('No trees fell inside the plate area.');
    }
    if (!candidates.length) {
      warnings.push('OpenStreetMap has no individual trees mapped here.');
    }
  }

  report(0.96, 'Packaging…');

  const parts = [];
  let triangles = 0;
  let volume = 0;

  for (const def of PARTS) {
    const mesh = meshes.get(def.id);
    if (!mesh || mesh.isEmpty()) continue;
    const vol = mesh.volume();
    const finished = mesh.finish();
    triangles += finished.triangleCount;
    volume += Math.abs(vol);
    parts.push({
      id: def.id,
      label: def.label,
      color: s.colors?.[def.id] || def.color,
      positions: finished.positions,
      indices: finished.indices,
      triangleCount: finished.triangleCount,
      volumeMm3: Math.abs(vol),
    });
  }

  if (!parts.length) {
    warnings.push('Nothing to print — try a larger area or enable more layers.');
  }
  if (s.layers.buildings && !buildingsPlaced.length) {
    warnings.push('No buildings here in OpenStreetMap. Try a denser area.');
  }
  if (terrain && ctx.heightGrid.max - ctx.heightGrid.min < 2) {
    warnings.push('This area is essentially flat, so terrain adds nothing.');
  }

  let bounds = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
  for (const [, mesh] of meshes) {
    const b = mesh.bounds();
    bounds = {
      minX: Math.min(bounds.minX, b.minX),
      minY: Math.min(bounds.minY, b.minY),
      minZ: Math.min(bounds.minZ, b.minZ),
      maxX: Math.max(bounds.maxX, b.maxX),
      maxY: Math.max(bounds.maxY, b.maxY),
      maxZ: Math.max(bounds.maxZ, b.maxZ),
    };
  }

  report(1, 'Done');

  return {
    parts,
    warnings,
    stats: {
      triangles,
      volumeMm3: volume,
      bounds,
      widthMm: bounds.maxX - bounds.minX,
      depthMm: bounds.maxY - bounds.minY,
      heightMm: bounds.maxZ - bounds.minZ,
      buildingCount: buildingsPlaced.length,
      plateAreaMm2: G.multiPolygonArea(plateMp),
      builtUpMm2: builtUpArea,
      regionAreas: {
        route: G.multiPolygonArea(routeRegion),
        buildings: builtUpArea,
        rail: G.multiPolygonArea(railRegion),
        roadsMajor: G.multiPolygonArea(roadsMajorRegion),
        roads: G.multiPolygonArea(roadsRegion),
        water: G.multiPolygonArea(waterRegion),
        green: G.multiPolygonArea(greenRegion),
        ground: G.multiPolygonArea(groundRegion),
        frame: G.multiPolygonArea(rimMp) + G.multiPolygonArea(plaqueRegion),
        label: G.multiPolygonArea(textMp),
      },
      scaleDenominator: Math.round(1 / mmPerMetre * 1000),
      mmPerMetre,
      elapsedMs: Date.now() - t0,
      terrainRelief: ctx.heightGrid
        ? ctx.heightGrid.max - ctx.heightGrid.min
        : 0,
    },
  };
}

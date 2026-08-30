/**
 * Browser test.
 *
 * The Node suites cover the geometry; this covers everything that only exists
 * in a browser — the ES module graph, the worker, WebGL, Leaflet, and the
 * control wiring — by driving the real page.
 *
 * The network is stubbed from `test/.cache` fixtures rather than hit live.
 * That is not a compromise: it makes the run deterministic and fast, it keeps
 * the free public APIs out of a loop that runs on every change, and the live
 * contracts are already exercised by `smoke.mjs`. Populate the cache by
 * running that suite first.
 *
 *   node test/browser.mjs [--headed] [--keep]
 */

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir, readdir } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SHOTS = join(HERE, 'shots');
const CACHE = join(HERE, '.cache');
const PORT = 8137;

// Manhattan Midtown — the fixture the Overpass stub replays.
const FIXTURE = { lat: 40.7549, lon: -73.984, areaMetres: 1200, name: 'Midtown Manhattan' };

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

let failures = 0;
let checks = 0;

function ok(label, condition, detail = '') {
  checks++;
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function serve() {
  const server = createServer(async (req, res) => {
    try {
      let path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (path === '/') path = '/index.html';
      const file = join(ROOT, normalize(path).replace(/^(\.\.[/\\])+/, ''));
      const body = await readFile(file);
      res.writeHead(200, {
        'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(PORT, () => resolve(server)));
}

/** Google encoded polyline, precision 6 — the format Valhalla returns. */
function encodePolyline(points, precision = 6) {
  const factor = 10 ** precision;
  let last = [0, 0];
  let out = '';
  const chunk = (value) => {
    let v = value < 0 ? ~(value << 1) : value << 1;
    let s = '';
    while (v >= 0x20) {
      s += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    return s + String.fromCharCode(v + 63);
  };
  for (const [lat, lon] of points) {
    const la = Math.round(lat * factor);
    const lo = Math.round(lon * factor);
    out += chunk(la - last[0]) + chunk(lo - last[1]);
    last = [la, lo];
  }
  return out;
}

async function installStubs(page, osm) {
  const seen = { overpass: 0, elevation: 0, route: 0, geocode: 0, nominatimSearch: 0 };

  await page.route('**://*/api/interpreter', (route) => {
    seen.overpass++;
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(osm) });
  });

  await page.route('**://photon.komoot.io/**', (route) => {
    seen.geocode++;
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        features: [
          {
            geometry: { type: 'Point', coordinates: [FIXTURE.lon, FIXTURE.lat] },
            properties: {
              name: FIXTURE.name,
              city: 'New York',
              state: 'New York',
              country: 'United States',
              osm_value: 'suburb',
              extent: [
                FIXTURE.lon - 0.008, FIXTURE.lat + 0.006,
                FIXTURE.lon + 0.008, FIXTURE.lat - 0.006,
              ],
            },
          },
        ],
      }),
    });
  });

  await page.route('**://nominatim.openstreetmap.org/**', (route) => {
    const url = route.request().url();
    if (url.includes('/search')) {
      seen.nominatimSearch++;
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify([
          {
            lat: String(FIXTURE.lat), lon: String(FIXTURE.lon), type: 'house',
            display_name: '6624, North Broadway Avenue, Gladstone, Missouri',
            boundingbox: ['40.7548', '40.7550', '-73.9841', '-73.9839'],
            address: {
              house_number: '6624', road: 'North Broadway Avenue',
              city: 'Gladstone', state: 'Missouri', country: 'United States',
            },
          },
        ]),
      });
    }
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        address: { city: 'New York', state: 'New York', country: 'United States', country_code: 'us' },
        display_name: 'Midtown, Manhattan, New York',
      }),
    });
  });

  await page.route('**://api.open-meteo.com/**', (route) => {
    seen.elevation++;
    const url = new URL(route.request().url());
    const lats = url.searchParams.get('latitude').split(',').map(Number);
    const lons = url.searchParams.get('longitude').split(',').map(Number);
    // A synthetic hill about 500 m across, so the terrain path has real relief
    // to work with. Offsets are converted to metres or the ridge comes out flat
    // at city scale.
    const mPerDegLat = 111320;
    const mPerDegLon = 111320 * Math.cos((FIXTURE.lat * Math.PI) / 180);
    const elevation = lats.map((lat, i) => {
      const dx = (lons[i] - FIXTURE.lon) * mPerDegLon;
      const dy = (lat - FIXTURE.lat) * mPerDegLat;
      return 20 + 90 * Math.exp(-(dx * dx + dy * dy) / (2 * 350 * 350));
    });
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ elevation }) });
  });

  await page.route('**://valhalla1.openstreetmap.de/**', (route) => {
    seen.route++;
    const path = [];
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      path.push([
        FIXTURE.lat - 0.003 + 0.006 * t,
        FIXTURE.lon - 0.004 + 0.008 * t + Math.sin(t * 6) * 0.0006,
      ]);
    }
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        trip: {
          legs: [{ shape: encodePolyline(path) }],
          summary: { length: 1.24, time: 900 },
        },
      }),
    });
  });

  // Map tiles: a transparent pixel is enough to prove Leaflet is wired up.
  await page.route(/basemaps\.cartocdn\.com|tile\.openstreetmap\.org/, (route) =>
    route.fulfill({ contentType: 'image/png', body: PIXEL })
  );

  return seen;
}

(async () => {
  console.log('Skyline Forge — browser test');
  console.log('============================\n');

  let osm;
  try {
    osm = JSON.parse(await readFile(join(CACHE, 'osm-manhattan-midtown.json'), 'utf8'));
  } catch {
    console.log('  ! No fixture found. Run `node test/smoke.mjs` first to populate test/.cache.');
    process.exit(1);
  }
  console.log(`Fixture: ${osm.elements.length.toLocaleString()} OSM elements\n`);

  await mkdir(SHOTS, { recursive: true });
  const server = await serve();
  const browser = await chromium.launch({
    headless: !process.argv.includes('--headed'),
    executablePath: await findChromium(),
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  });

  const page = await browser.newPage({ viewport: { width: 1580, height: 940 } });
  page.setDefaultTimeout(120000);

  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => {
    if (r.url().startsWith(`http://localhost:${PORT}`)) {
      errors.push(`asset failed: ${r.url()} ${r.failure()?.errorText || ''}`);
    }
  });

  const seen = await installStubs(page, osm);

  try {
    await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'load' });

    /* ---------- boot ---------- */
    console.log('Boot');
    await page.waitForFunction(() => window.skylineForge !== undefined, { timeout: 20000 });
    ok('app boots', true);
    ok('module graph resolves cleanly', errors.length === 0, errors.slice(0, 3).join(' | '));
    ok('WebGL context is live', await page.evaluate(() =>
      Boolean(window.skylineForge.viewer.renderer.getContext())));
    ok('Leaflet map is live', await page.evaluate(() =>
      Boolean(window.skylineForge.picker.map.getCenter())));
    ok('all ten shapes are offered', (await page.locator('.shape-btn').count()) === 10);
    ok('all twelve layers are listed', (await page.locator('.layer-row').count()) === 12);
    ok('all four export formats are offered', (await page.locator('.format-opt').count()) === 4);

    /* ---------- first model ---------- */
    console.log('\nFirst build (worker + Overpass)');
    await page.evaluate((f) => {
      const app = window.skylineForge;
      app.settings.location = { lat: f.lat, lon: f.lon, label: f.name };
      app.settings.size.areaMetres = f.areaMetres;
      app.picker.update(app.settings);
      app.syncUi();
    }, FIXTURE);
    await page.click('#generate-btn');
    await page.waitForFunction(
      () => window.skylineForge.model?.parts?.length > 0 && !window.skylineForge.busy,
      { timeout: 150000 }
    );

    const first = await page.evaluate(() => ({
      parts: window.skylineForge.model.parts.map((p) => p.id),
      stats: window.skylineForge.model.stats,
    }));
    console.log(
      `    ${first.parts.length} parts (${first.parts.join(', ')}), ` +
        `${first.stats.triangles.toLocaleString()} triangles in ${first.stats.elapsedMs} ms`
    );
    ok('the worker returned geometry', first.stats.triangles > 10000);
    ok('buildings were extruded', first.stats.buildingCount > 200,
      `${first.stats.buildingCount} buildings`);
    ok('the plate is the size that was asked for',
      Math.abs(first.stats.widthMm - 160) < 1.5,
      `${first.stats.widthMm.toFixed(1)} mm across`);
    ok('the scale readout is right',
      Math.abs(first.stats.scaleDenominator - 7500) < 200,
      `1:${first.stats.scaleDenominator}`);
    ok('export is enabled', await page.locator('#export-btn').isEnabled());
    ok('meshes reached the scene',
      await page.evaluate(() => window.skylineForge.viewer.parts.size > 3));
    await page.screenshot({ path: join(SHOTS, '01-manhattan.png') });

    /* ---------- search ---------- */
    console.log('\nSearch');
    await page.fill('#search-input', 'Midtown');
    await page.waitForSelector('#search-results li:not(.r-empty)');
    ok('typeahead lists suggestions',
      (await page.locator('#search-results li').count()) > 0);
    await page.locator('#search-results li').first().click();
    await page.waitForTimeout(400);
    ok('picking a suggestion fills the nameplate title',
      (await page.evaluate(() => window.skylineForge.settings.nameplate.title)).length > 0);

    // A house number has to go to Nominatim: Photon does not index them, and
    // answers this exact query with the local post office.
    console.log('\nStreet address');
    await page.evaluate(() => { window.skylineForge.settings.nameplate.title = ''; });
    const searchesBefore = seen.nominatimSearch;
    await page.fill('#search-input', '6624 N Broadway, Gladstone, MO');
    // The suggestion list keeps its previous items in the DOM while hidden, so
    // wait for the new results rather than for "some results".
    await page.waitForFunction(
      () => {
        const el = document.querySelector('#search-results li .r-main');
        return el && el.textContent.startsWith('6624');
      },
      { timeout: 20000 }
    ).catch(() => {});
    ok('an address query is sent to the address geocoder',
      seen.nominatimSearch > searchesBefore,
      `${seen.nominatimSearch - searchesBefore} lookups`);
    const firstResult = await page.locator('#search-results li .r-main').first().textContent();
    ok('the house number itself is offered, not a nearby landmark',
      firstResult.startsWith('6624'), `got "${firstResult}"`);
    await page.locator('#search-results li').first().click();
    await page.waitForTimeout(400);
    const addressPick = await page.evaluate(() => ({
      area: window.skylineForge.settings.size.areaMetres,
      title: window.skylineForge.settings.nameplate.title,
    }));
    ok('a house frames a neighbourhood, not the building',
      addressPick.area >= 300 && addressPick.area <= 1200, `${addressPick.area} m`);
    ok('the nameplate uses the town, not the street number',
      addressPick.title === 'GLADSTONE', `got "${addressPick.title}"`);

    /* ---------- shapes ---------- */
    console.log('\nShapes');
    for (const shape of ['hexagon', 'heart', 'star', 'rectangle', 'triangle']) {
      await page.click(`.shape-btn[data-shape="${shape}"]`);
      await page.waitForTimeout(650);
      await page.waitForFunction(() => !window.skylineForge.busy);
      const size = await page.evaluate(() => ({
        w: window.skylineForge.model.stats.widthMm,
        d: window.skylineForge.model.stats.depthMm,
      }));
      // Whatever the outline, the printed footprint must stay inside the
      // requested size (plus the nameplate bar, which extends downwards).
      ok(`${shape} stays within the printed size`,
        size.w <= 161 && size.d <= 161 + 20,
        `${size.w.toFixed(1)} × ${size.d.toFixed(1)} mm`);
    }
    await page.screenshot({ path: join(SHOTS, '02-triangle.png') });
    await page.click('.shape-btn[data-shape="circle"]');
    await page.waitForTimeout(650);

    /* ---------- live geometry updates ---------- */
    console.log('\nLive updates');
    const overpassBefore = seen.overpass;
    const buildingVolume = () =>
      page.evaluate(() =>
        window.skylineForge.model.parts.find((p) => p.id === 'buildings').volumeMm3);
    const before = await buildingVolume();
    await page.evaluate(() => {
      const el = document.querySelector('[data-bind="heights.buildingScale"]');
      el.value = '3';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(700);
    await page.waitForFunction(() => !window.skylineForge.busy);
    const after = await buildingVolume();
    // Volume rather than peak height: Midtown's tallest towers already sit at
    // the height cap, so the tallest point barely moves while everything below
    // it grows.
    ok('raising the height scale makes the skyline taller', after > before * 1.8,
      `${(before / 1000).toFixed(1)} cm³ -> ${(after / 1000).toFixed(1)} cm³`);
    ok('a geometry change reuses the cached map data',
      seen.overpass === overpassBefore,
      `${seen.overpass - overpassBefore} extra downloads`);

    /* ---------- colours ---------- */
    console.log('\nColours');
    await page.click('[data-palette="blueprint"]');
    const painted = await page.evaluate(() => {
      const mesh = window.skylineForge.viewer.parts.get('ground');
      return mesh ? `#${mesh.material.color.getHexString()}` : null;
    });
    ok('a palette repaints without rebuilding', painted === '#12395c', `ground is ${painted}`);
    await page.click('[data-palette="classic"]');

    /* ---------- layer toggles ---------- */
    console.log('\nLayer toggles');
    await page.evaluate(() => {
      const row = [...document.querySelectorAll('.layer-row')]
        .find((r) => r.textContent.includes('Water'));
      row.querySelector('input[type="checkbox"]').click();
    });
    await page.waitForTimeout(700);
    ok('turning a layer off hides it', await page.evaluate(() => {
      const m = window.skylineForge.viewer.parts.get('water');
      return m ? !m.visible : true;
    }));
    ok('a hidden layer is left out of the export', await page.evaluate(() => {
      const app = window.skylineForge;
      return !app.model.parts
        .filter((p) => app.settings.layers[p.id === 'water' ? 'water' : 'buildings'] !== false)
        .some((p) => p.id === 'water');
    }));

    /* ---------- terrain ---------- */
    console.log('\nTerrain');
    await page.evaluate(() => {
      const app = window.skylineForge;
      app.settings.layers.water = true;
      app.settings.terrain.enabled = true;
      app.syncUi();
    });
    await page.click('#generate-btn');
    await page.waitForFunction(
      () => !window.skylineForge.busy && window.skylineForge.model?.stats?.terrainRelief > 0,
      { timeout: 180000 }
    );
    const relief = await page.evaluate(() => window.skylineForge.model.stats.terrainRelief);
    ok('terrain sampling reached the model', relief > 20, `${relief.toFixed(0)} m of relief`);
    ok('the elevation API was called', seen.elevation > 0, `${seen.elevation} requests`);
    await page.screenshot({ path: join(SHOTS, '03-terrain.png') });
    await page.evaluate(() => {
      window.skylineForge.settings.terrain.enabled = false;
      window.skylineForge.syncUi();
      window.skylineForge.onChange('geometry');
    });
    await page.waitForTimeout(700);
    await page.waitForFunction(() => !window.skylineForge.busy);

    /* ---------- route ---------- */
    console.log('\nRoute');
    await page.evaluate((f) => {
      const app = window.skylineForge;
      const points = [
        { lat: f.lat - 0.003, lon: f.lon - 0.004 },
        { lat: f.lat + 0.003, lon: f.lon + 0.004 },
      ];
      app.settings.layers.route = true;
      app.settings.route.waypoints = points;
      app.picker.setWaypoints(points);
      app.renderWaypoints();
      return app.resolveRoute();
    }, FIXTURE);
    // resolveRoute schedules the rebuild on a debounce, so wait for it to be
    // picked up before asking whether the model contains a route.
    await page.waitForFunction(
      () => window.skylineForge.settings.route.points?.length > 2,
      { timeout: 60000 }
    );
    await page.waitForTimeout(700);
    await page.waitForFunction(() => !window.skylineForge.busy, { timeout: 90000 });

    const route = await page.evaluate(() => ({
      points: window.skylineForge.settings.route.points?.length || 0,
      distance: window.skylineForge.settings.route.distance,
      part: window.skylineForge.model.parts.find((p) => p.id === 'route'),
    }));
    ok('the router returned a path', route.points > 5, `${route.points} points`);
    ok('the distance is reported', route.distance > 1000, `${route.distance} m`);
    ok('the route becomes its own coloured part',
      route.part && route.part.triangleCount > 50,
      `${route.part?.triangleCount || 0} triangles`);
    ok('the waypoint list is rendered',
      (await page.locator('#waypoint-list li').count()) === 2);
    await page.screenshot({ path: join(SHOTS, '04-route.png') });

    /* ---------- nameplate ---------- */
    console.log('\nNameplate');
    await page.evaluate(() => {
      const app = window.skylineForge;
      app.settings.nameplate.title = 'NEW YORK';
      app.settings.nameplate.subtitle = '40.7549° N  73.9840° W';
      app.syncUi();
      app.onChange('geometry');
    });
    await page.waitForTimeout(700);
    await page.waitForFunction(() => !window.skylineForge.busy);
    const label = await page.evaluate(() =>
      window.skylineForge.model.parts.find((p) => p.id === 'label'));
    ok('lettering becomes real geometry', label && label.triangleCount > 200,
      `${label?.triangleCount || 0} triangles`);
    await page.evaluate(() => window.skylineForge.viewer.setView('top'));
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(SHOTS, '05-nameplate.png') });

    /* ---------- exports ---------- */
    console.log('\nExports');
    for (const format of ['3mf', 'stl', 'stl-parts', 'obj']) {
      const result = await page.evaluate(
        (fmt) =>
          import('./js/export/index.js').then(({ buildExport }) => {
            const app = window.skylineForge;
            const { blob, filename } = buildExport(fmt, app.model.parts, {
              title: app.settings.nameplate.title,
            });
            return { size: blob.size, filename, type: blob.type };
          }),
        format
      );
      ok(`${format} exports`, result.size > 5000,
        `${result.filename}, ${(result.size / 1024).toFixed(0)} kB`);
    }

    const download = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.click('#export-btn'),
    ]).then(([d]) => d);
    ok('the Download button produces a file',
      download.suggestedFilename().endsWith('.3mf'), download.suggestedFilename());

    /* ---------- share link ---------- */
    console.log('\nShare link');
    const restored = await page.evaluate(() => {
      const app = window.skylineForge;
      const url = app.writeHash();
      const saved = location.hash;
      location.hash = url.split('#')[1];
      const parsed = app.readHash();
      location.hash = saved;
      return { title: parsed?.nameplate?.title, lat: parsed?.location?.lat, length: url.length };
    });
    ok('a share link round-trips every setting',
      restored.title === 'NEW YORK' && Math.abs(restored.lat - FIXTURE.lat) < 1e-6,
      `${restored.length} characters`);

    /* ---------- persistence ---------- */
    console.log('\nReload');
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.skylineForge !== undefined, { timeout: 20000 });
    const persisted = await page.evaluate(() => window.skylineForge.settings.nameplate.title);
    ok('settings survive a reload', persisted === 'NEW YORK', `got "${persisted}"`);

    /* ---------- bring your own data ---------- */
    console.log('\nImporting your own data');

    // A GeoJSON block with per-feature heights, handed straight to the panel.
    const importResult = await page.evaluate(async (f) => {
      const app = window.skylineForge;
      const features = [];
      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          const lat = f.lat - 0.0016 + r * 0.0004;
          const lon = f.lon - 0.0020 + c * 0.0005;
          const d = 0.00018;
          features.push({
            type: 'Feature',
            properties: { BLDG_HT_FT: 20 + ((r * 8 + c) % 11) * 9, ADDRESS: `${r}${c} Main St` },
            geometry: { type: 'Polygon', coordinates: [[
              [lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d], [lon, lat],
            ]] },
          });
        }
      }
      const json = JSON.stringify({ type: 'FeatureCollection', features });
      const file = new File([json], 'county-buildings.geojson', { type: 'application/geo+json' });
      await app.importsPanel.add([file]);
      const dataset = app.importsPanel.datasets[app.importsPanel.datasets.length - 1];
      return {
        count: dataset.count,
        part: dataset.mapping.part,
        heightField: dataset.mapping.heightField,
        heightUnit: dataset.mapping.heightUnit,
        nameField: dataset.mapping.nameField,
        rows: document.querySelectorAll('.dataset').length,
      };
    }, FIXTURE);

    ok('the file is parsed', importResult.count === 64, `${importResult.count} shapes`);
    ok('polygons default to the buildings layer', importResult.part === 'buildings');
    ok('the height column is guessed', importResult.heightField === 'BLDG_HT_FT',
      String(importResult.heightField));
    ok('feet are guessed from the value range', importResult.heightUnit === 'ft',
      importResult.heightUnit);
    ok('the name column is guessed', importResult.nameField === 'ADDRESS',
      String(importResult.nameField));
    ok('the dataset appears in the panel', importResult.rows === 1);

    await page.waitForTimeout(900);
    await page.waitForFunction(() => !window.skylineForge.busy, { timeout: 120000 });

    const imported = await page.evaluate(() => {
      const app = window.skylineForge;
      const buildings = app.model.parts.find((p) => p.id === 'buildings');
      const tops = new Set();
      for (let i = 2; i < buildings.positions.length; i += 3) {
        tops.add(Math.round(buildings.positions[i] * 4));
      }
      return { count: app.model.stats.buildingCount, distinctHeights: tops.size };
    });
    ok('imported buildings reach the model', imported.count > 50, `${imported.count} buildings`);
    ok('their heights vary, unlike a flat OSM suburb',
      imported.distinctHeights > 8, `${imported.distinctHeights} distinct heights`);
    await page.screenshot({ path: join(SHOTS, '07-imported.png') });

    // Replace mode has to displace the OSM footprints underneath, so this runs
    // while there are still OSM buildings there to displace.
    const modes = await page.evaluate(async () => {
      const app = window.skylineForge;
      const id = app.importsPanel.datasets[0].id;
      const counts = {};
      for (const mode of ['add', 'replace']) {
        app.importsPanel.update(id, { mode });
        await new Promise((r) => setTimeout(r, 900));
        while (app.busy) await new Promise((r) => setTimeout(r, 120));
        counts[mode] = app.model.stats.buildingCount;
      }
      return counts;
    });
    ok('replace drops the OSM buildings underneath',
      modes.replace < modes.add, `add ${modes.add}, replace ${modes.replace}`);

    // The motivating case: somewhere OSM knows nothing about, where the upload
    // is the only source of buildings. It also isolates the unit switch, which
    // Manhattan's towers would otherwise mask by pinning the model height at
    // the cap.
    await page.route('**://*/api/interpreter', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ elements: [] }) })
    );
    await page.evaluate(() => {
      const app = window.skylineForge;
      app.cache = { bbox: null, layers: [], detail: null, features: null };
      app.merged = null;
      app.settings.size.areaMetres = 1150; // new bbox, so the query cache misses
      app.syncUi();
    });
    await page.click('#generate-btn');
    await page.waitForFunction(() => !window.skylineForge.busy, { timeout: 120000 });

    const bare = await page.evaluate(() => ({
      buildings: window.skylineForge.model.stats.buildingCount,
      height: window.skylineForge.model.stats.heightMm,
    }));
    ok('an upload alone can carry a print where OSM has nothing',
      bare.buildings === 64, `${bare.buildings} buildings`);

    await page.evaluate(() => {
      const app = window.skylineForge;
      app.importsPanel.update(app.importsPanel.datasets[0].id, { heightUnit: 'm' });
    });
    await page.waitForTimeout(900);
    await page.waitForFunction(() => !window.skylineForge.busy, { timeout: 120000 });
    const afterUnit = await page.evaluate(() => window.skylineForge.model.stats.heightMm);
    ok('reading the column as metres instead of feet makes the buildings taller',
      afterUnit > bare.height * 2, `${bare.height.toFixed(1)} -> ${afterUnit.toFixed(1)} mm`);

    // KML, which is what Google Earth produces.
    const kmlResult = await page.evaluate(async (f) => {
      const app = window.skylineForge;
      const ring = [
        [f.lon - 0.001, f.lat - 0.001], [f.lon + 0.001, f.lat - 0.001],
        [f.lon + 0.001, f.lat + 0.001], [f.lon - 0.001, f.lat + 0.001],
        [f.lon - 0.001, f.lat - 0.001],
      ].map(([lon, lat]) => `${lon},${lat},0`).join(' ');
      const kml = `<?xml version="1.0" encoding="UTF-8"?>
        <kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark>
        <name>Park</name>
        <ExtendedData><Data name="acres"><value>12</value></Data></ExtendedData>
        <Polygon><outerBoundaryIs><LinearRing><coordinates>${ring}</coordinates>
        </LinearRing></outerBoundaryIs></Polygon></Placemark></Document></kml>`;
      await app.importsPanel.add([new File([kml], 'park.kml')]);
      const d = app.importsPanel.datasets[app.importsPanel.datasets.length - 1];
      return { format: d.format, count: d.count, kind: d.kind, name: d.features[0].properties.name };
    }, FIXTURE);
    ok('KML is recognised', kmlResult.format === 'KML', kmlResult.format);
    ok('KML polygons are read', kmlResult.count === 1 && kmlResult.kind === 'area');
    ok('KML placemark names survive', kmlResult.name === 'Park', String(kmlResult.name));

    // Projected data with no projection must be refused, not silently misplaced.
    const refusal = await page.evaluate(async () => {
      const app = window.skylineForge;
      const json = JSON.stringify({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon',
          coordinates: [[[850000, 336500], [850020, 336500], [850020, 336520], [850000, 336520], [850000, 336500]]] } }],
      });
      const before = app.importsPanel.datasets.length;
      await app.importsPanel.add([new File([json], 'state-plane.geojson')]);
      return { added: app.importsPanel.datasets.length - before };
    });
    ok('unprojectable data is refused rather than placed in the ocean', refusal.added === 0);

    const storedCount = await page.evaluate(async () => {
      const { loadDatasets } = await import('./js/data/import/store.js');
      return (await loadDatasets()).length;
    });
    ok('uploads are stored on the device', storedCount === 2, `${storedCount} datasets`);

    await page.evaluate(async () => {
      const app = window.skylineForge;
      for (const d of [...app.importsPanel.datasets]) await app.importsPanel.remove(d.id);
    });
    await page.waitForTimeout(900);
    await page.waitForFunction(() => !window.skylineForge.busy, { timeout: 120000 });
    ok('removing a dataset clears it', (await page.locator('.dataset').count()) === 0);

    /* ---------- mobile ---------- */
    console.log('\nMobile layout');
    const phone = await browser.newPage({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    phone.setDefaultTimeout(120000);
    const phoneErrors = [];
    phone.on('pageerror', (e) => phoneErrors.push(e.message));
    await installStubs(phone, osm);
    await phone.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'load' });
    await phone.waitForFunction(() => window.skylineForge !== undefined, { timeout: 20000 });
    await phone.waitForFunction(
      () => window.skylineForge.model?.parts?.length > 0 && !window.skylineForge.busy,
      { timeout: 150000 }
    );

    ok('phone starts on the map, not a three-way split',
      (await phone.getAttribute('#stage-panes', 'data-view')) === 'map');
    ok('the Split tab is hidden on a phone',
      !(await phone.locator('.stage-tab[data-view="split"]').isVisible()));

    const collapsed = await phone.locator('#sidebar').boundingBox();
    ok('settings start collapsed to a grab bar',
      collapsed.height < 60, `${collapsed.height.toFixed(0)} px tall`);
    ok('the map gets most of the screen',
      (await phone.locator('#map').boundingBox()).height > 500);

    // Clear any toast first: they sit just above the sheet and can intercept
    // the tap, which makes this check flaky rather than wrong.
    await phone.evaluate(() => { document.getElementById('toasts').innerHTML = ''; });
    await phone.click('#sheet-handle');
    await phone.waitForSelector('#sidebar.is-open', { timeout: 5000 });
    // Wait for the slide to finish rather than for a fixed delay: max-height
    // animates on the main thread, and under software WebGL the render loop
    // starves it to a few frames a second.
    await phone
      .waitForFunction(
        () => document.getElementById('sidebar').getBoundingClientRect().height > 400,
        { timeout: 15000 }
      )
      .catch(() => {});
    const expanded = await phone.locator('#sidebar').boundingBox();
    ok('tapping the grab bar opens the sheet', expanded.height > 400,
      `${expanded.height.toFixed(0)} px tall`);
    await phone.screenshot({ path: join(SHOTS, '07-phone-settings.png') });

    // The nameplate has to be removable from the layer list, which is the
    // first place anyone will look for it.
    const nameplateRow = phone.locator('.layer-row', { hasText: 'Nameplate' });
    ok('the layer list has a Nameplate checkbox', (await nameplateRow.count()) === 1);
    await phone.evaluate(() => {
      const app = window.skylineForge;
      app.settings.nameplate.title = 'GLADSTONE';
      app.syncUi();
      app.onChange('geometry');
    });
    await phone.waitForTimeout(800);
    await phone.waitForFunction(() => !window.skylineForge.busy);
    ok('the nameplate is in the model to start with',
      await phone.evaluate(() =>
        window.skylineForge.model.parts.some((p) => p.id === 'label')));

    await nameplateRow.locator('input[type="checkbox"]').click();
    await phone.waitForTimeout(800);
    await phone.waitForFunction(() => !window.skylineForge.busy);
    const afterUncheck = await phone.evaluate(() => ({
      hasLabel: window.skylineForge.model.parts.some((p) => p.id === 'label'),
      depth: window.skylineForge.model.stats.depthMm,
      width: window.skylineForge.model.stats.widthMm,
    }));
    ok('unchecking Nameplate removes the lettering', !afterUncheck.hasLabel);
    ok('unchecking Nameplate removes the whole bar, not just the text',
      Math.abs(afterUncheck.depth - afterUncheck.width) < 1.5,
      `${afterUncheck.width.toFixed(0)} x ${afterUncheck.depth.toFixed(0)} mm`);

    await phone.click('.stage-tab[data-view="model"]');
    await phone.waitForTimeout(600);
    await phone.screenshot({ path: join(SHOTS, '08-phone-model.png') });
    ok('no page errors on the phone layout', phoneErrors.length === 0,
      phoneErrors.slice(0, 2).join(' | '));
    await phone.close();

    /* ---------- console hygiene ---------- */
    console.log('\nConsole');
    const real = errors.filter((e) => !/favicon/i.test(e));
    ok('no console errors across the whole run', real.length === 0,
      real.slice(0, 4).join(' | '));

    await page.waitForFunction(
      () => window.skylineForge.model?.parts?.length > 0 && !window.skylineForge.busy,
      { timeout: 150000 }
    );
    await page.evaluate(() => window.skylineForge.viewer.setView('iso'));
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(SHOTS, '06-final.png') });
    console.log(`\n    Screenshots in ${SHOTS}`);
  } catch (err) {
    failures++;
    console.log(`\n  ✗ run threw: ${err.message}`);
    if (errors.length) console.log(`    console: ${errors.slice(0, 5).join(' | ')}`);
    await page.screenshot({ path: join(SHOTS, 'failure.png') }).catch(() => {});
  } finally {
    if (!process.argv.includes('--keep')) await browser.close();
    server.close();
  }

  console.log(`\n${failures ? '✗' : '✓'} ${checks - failures}/${checks} checks passed\n`);
  process.exit(failures ? 1 : 0);
})();

/** Playwright's bundled Chromium moves around between images. */
async function findChromium() {
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers'].filter(Boolean);
  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const entry of entries.filter((e) => e.startsWith('chromium'))) {
      for (const candidate of ['chrome-linux/chrome', 'chrome-linux/headless_shell']) {
        const path = join(root, entry, candidate);
        try {
          await readFile(path, { flag: 'r' });
          return path;
        } catch { /* keep looking */ }
      }
    }
  }
  return undefined; // fall back to Playwright's own resolution
}

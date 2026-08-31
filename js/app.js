import { defaultSettings, mergeSettings, PARTS } from './model/parts.js';
import { SHAPES, buildShapeRing, shapeOuterRadius } from './core/shapes.js';
import { createProjection } from './core/projection.js';
import { MapPicker, BASEMAPS } from './mappicker.js';
import { Viewer } from './viewer.js';
import * as geocode from './data/geocode.js';
import * as overpass from './data/overpass.js';
import * as elevation from './data/elevation.js';
import * as routing from './data/route.js';
import { FORMATS, buildExport, downloadBlob, slugify } from './export/index.js';
import { ImportsPanel } from './imports-ui.js';
import { applyImports } from './data/import/merge.js';

const STORAGE_KEY = 'skyline-forge/settings/v1';
const DATA_LAYERS = ['buildings', 'roads', 'rail', 'water', 'green'];

const PALETTES = {
  classic: {},
  blueprint: {
    ground: '#12395c', water: '#0d2942', green: '#1b4a6f',
    roads: '#cddff0', roadsMajor: '#ffffff', rail: '#8fb4d4',
    buildings: '#e8f2fb', roofs: '#b9d4ec', trees: '#2f6d8f', route: '#ffcc4d',
    frame: '#0a2036', label: '#ffffff',
  },
  night: {
    ground: '#1b1f27', water: '#16324a', green: '#243a2a',
    roads: '#e8c86a', roadsMajor: '#ffd980', rail: '#6b5f4a',
    buildings: '#39414d', roofs: '#59453c', trees: '#2e4a34', route: '#ff6b5b',
    frame: '#0d1015', label: '#ffd980',
  },
  mono: {
    ground: '#e6e6e6', water: '#9a9a9a', green: '#c4c4c4',
    roads: '#585858', roadsMajor: '#3a3a3a', rail: '#767676',
    buildings: '#fafafa', roofs: '#c2c2c2', trees: '#8d8d8d', route: '#1a1a1a',
    frame: '#2a2a2a', label: '#fafafa',
  },
};

class App {
  constructor() {
    this.settings = this.loadSettings();
    this.font = null;
    this.worker = null;
    this.jobId = 0;
    this.model = null;
    this.busy = false;

    this.cache = { bbox: null, layers: [], detail: null, features: null };
    this.imports = [];
    this.merged = null;
    this.exportFormat = '3mf';
    this.dataStale = true;

    this.el = new Proxy(
      {},
      { get: (_, id) => document.getElementById(String(id).replace(/_/g, '-')) }
    );

    this.buildStaticUi();
    this.initMap();
    this.initViewer();
    this.initWorker();
    this.bindControls();
    this.bindActions();
    this.initImports();
    this.syncUi();

    this.loadFont();
    this.generate({ silent: true });
  }

  loadSettings() {
    const fromHash = this.readHash();
    if (fromHash) return mergeSettings(defaultSettings(), fromHash);
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return mergeSettings(defaultSettings(), JSON.parse(raw));
    } catch { }
    return defaultSettings();
  }

  saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
    } catch { }
  }

  readHash() {
    const hash = location.hash.replace(/^#/, '');
    if (!hash.startsWith('s=')) return null;
    try {
      const json = decodeURIComponent(escape(atob(hash.slice(2).replace(/-/g, '+').replace(/_/g, '/'))));
      return JSON.parse(json);
    } catch {
      return null;
    }
  }

  writeHash() {
    try {
      const json = JSON.stringify(this.settings);
      const b64 = btoa(unescape(encodeURIComponent(json)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
      return `${location.origin}${location.pathname}#s=${b64}`;
    } catch {
      return location.href;
    }
  }

  get(path) {
    return path.split('.').reduce((o, k) => (o == null ? o : o[k]), this.settings);
  }

  set(path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    const target = keys.reduce((o, k) => o[k], this.settings);
    target[last] = value;
  }

  buildStaticUi() {
    const grid = this.el['shape-grid'];
    grid.innerHTML = '';
    for (const shape of SHAPES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'shape-btn';
      btn.role = 'radio';
      btn.dataset.shape = shape.id;
      btn.title = shape.label;
      btn.setAttribute('aria-label', shape.label);
      btn.innerHTML = shapeIcon(shape.id);
      btn.addEventListener('click', () => {
        this.settings.shape.type = shape.id;
        if (shape.id === 'custom' && !this.settings.shape.custom) {
          this.startDrawing();
        }
        this.syncUi();
        this.onChange('geometry');
      });
      grid.appendChild(btn);
    }

    const list = this.el['layer-list'];
    list.innerHTML = '';
    this.layerRows = new Map();
    for (const part of PARTS) {
      const toggleKey = layerToggleKey(part.id);
      const row = document.createElement('div');
      row.className = 'layer-row';
      row.innerHTML = `
        <input type="checkbox" ${toggleKey ? '' : 'disabled title="Always present"'} aria-label="${part.label}">
        <label class="swatch" title="${part.hint}"><input type="color"></label>
        <span class="layer-name">${part.label}</span>
        <span class="layer-count"></span>`;

      const [check, swatchLabel] = row.children;
      const colorInput = swatchLabel.querySelector('input');

      if (toggleKey) {
        check.addEventListener('change', () => {
          this.settings.layers[toggleKey] = check.checked;
          this.syncUi();
          this.onChange(toggleKey === 'trees' ? 'data' : 'geometry');
        });
      } else {
        check.checked = true;
      }

      colorInput.addEventListener('input', () => {
        this.settings.colors[part.id] = colorInput.value;
        swatchLabel.style.background = colorInput.value;
        this.viewer.setPartColor(part.id, colorInput.value);
        this.saveSettings();
      });

      list.appendChild(row);
      this.layerRows.set(part.id, { row, check, colorInput, swatchLabel, toggleKey });
    }

    for (const btn of document.querySelectorAll('[data-palette]')) {
      btn.addEventListener('click', () => this.applyPalette(btn.dataset.palette));
    }

    const seg = this.el['route-profile'];
    seg.innerHTML = '';
    for (const p of routing.PROFILES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.role = 'radio';
      b.dataset.profile = p.id;
      b.textContent = p.label;
      b.addEventListener('click', () => {
        this.settings.route.profile = p.id;
        this.syncUi();
        this.resolveRoute();
      });
      seg.appendChild(b);
    }

    const formats = this.el['format-list'];
    formats.innerHTML = '';
    for (const f of FORMATS) {
      const opt = document.createElement('button');
      opt.type = 'button';
      opt.className = 'format-opt';
      opt.role = 'radio';
      opt.dataset.format = f.id;
      opt.innerHTML = `<span class="f-name">${f.label}</span><span class="f-detail">${f.detail}</span>`;
      opt.addEventListener('click', () => {
        this.exportFormat = f.id;
        this.syncUi();
      });
      formats.appendChild(opt);
    }

    const basemap = this.el['basemap-select'];
    basemap.innerHTML = '';
    for (const b of BASEMAPS) {
      const o = document.createElement('option');
      o.value = b.id;
      o.textContent = b.label;
      basemap.appendChild(o);
    }
    basemap.addEventListener('change', () => this.picker.setBasemap(basemap.value));

    for (const panel of document.querySelectorAll('.panel')) {
      const head = panel.querySelector('.panel-head');
      head.addEventListener('click', () => {
        const open = panel.hasAttribute('open');
        panel.toggleAttribute('open', !open);
        head.setAttribute('aria-expanded', String(!open));
      });
    }
  }

  initMap() {
    this.picker = new MapPicker(this.el.map, {
      onChange: (settings, meta) => {
        this.settings = settings;
        this.updateScaleReadout();
        if (!meta.live) this.onChange('geometry');
      },
      onWaypoints: (waypoints) => {
        this.settings.route.waypoints = waypoints.map((w) => ({ ...w }));
        this.renderWaypoints();
        this.resolveRoute();
      },
      onCustomShape: (points) => {
        this.settings.shape.type = 'custom';
        this.settings.shape.custom = points;
        this.settings.location.lat = points.reduce((a, p) => a + p[0], 0) / points.length;
        this.settings.location.lon = points.reduce((a, p) => a + p[1], 0) / points.length;
        this.syncUi();
        this.onChange('data');
        this.toast('Custom shape captured.', 'good');
      },
      onModeChange: (mode) => {
        this.el['pick-route-btn']?.classList.toggle('is-active', mode === 'route');
        this.el['draw-btn']?.classList.toggle('is-active', mode === 'draw');
      },
    });
    this.picker.update(this.settings);
    this.picker.focus(false);
    this.el['basemap-select'].value = this.picker.basemapId;
  }

  initViewer() {
    this.viewer = new Viewer(this.el.viewport);
  }

  initWorker() {
    this.worker = new Worker(new URL('./model/worker.js', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = (event) => this.onWorkerMessage(event.data);
    this.worker.onerror = (event) => {
      this.setBusy(false);
      this.status(`Model builder crashed: ${event.message}`, 'bad');
    };
  }

  async loadFont() {
    try {
      const res = await fetch('vendor/helvetiker_bold.typeface.json');
      this.font = await res.json();
    } catch {
      this.toast('Nameplate lettering is unavailable — font failed to load.', 'warn');
    }
  }

  bindControls() {
    this.bindings = [];

    for (const el of document.querySelectorAll('[data-bind]')) {
      const path = el.dataset.bind;
      const kind = el.dataset.kind || (isDataPath(path) ? 'data' : 'geometry');
      const isLog = el.dataset.scale === 'log';

      if (isLog) {
        el.dataset.lo = el.min;
        el.dataset.hi = el.max;
        el.min = '0';
        el.max = '1000';
        el.step = '1';
      }

      const read = () => {
        if (el.type === 'checkbox') return el.checked;
        if (el.type === 'range') {
          const raw = parseFloat(el.value);
          if (!isLog) return raw;
          const lo = parseFloat(el.dataset.lo);
          const hi = parseFloat(el.dataset.hi);
          return lo * (hi / lo) ** (raw / 1000);
        }
        return el.value;
      };

      const write = (value) => {
        if (el.type === 'checkbox') {
          el.checked = Boolean(value);
        } else if (el.type === 'range' && isLog) {
          const lo = parseFloat(el.dataset.lo);
          const hi = parseFloat(el.dataset.hi);
          el.value = String(Math.round(1000 * (Math.log(value / lo) / Math.log(hi / lo))));
        } else if (document.activeElement !== el) {
          el.value = value;
        }
      };

      const event = el.type === 'text' || el.tagName === 'TEXTAREA' ? 'input' : 'input';
      el.addEventListener(event, () => {
        this.set(path, read());
        this.syncOutputs();
        this.syncConditionals();
        this.picker.update(this.settings);
        this.updateScaleReadout();
        this.onChange(kind);
      });

      this.bindings.push({ el, path, write });
    }
  }

  bindActions() {
    const el = this.el;

    el['generate-btn'].addEventListener('click', () => this.generate());
    el['export-btn'].addEventListener('click', () => this.doExport());
    el['match-view-btn'].addEventListener('click', () => this.picker.matchViewport());
    el['focus-btn'].addEventListener('click', () => this.picker.focus());
    el['draw-btn'].addEventListener('click', () => this.startDrawing());
    el['reset-btn'].addEventListener('click', () => this.reset());
    el['snapshot-btn'].addEventListener('click', () => this.saveSnapshot());
    el['share-btn'].addEventListener('click', () => this.copyLink());
    el['locate-btn'].addEventListener('click', () => this.useMyLocation());
    el['fill-coords-btn'].addEventListener('click', () => this.fillCoords());

    el['pick-route-btn'].addEventListener('click', () => {
      const next = this.picker.mode === 'route' ? 'pan' : 'route';
      this.picker.setMode(next);
      if (next === 'route') {
        this.toast('Click a start and an end on the map. Click a pin to remove it.');
      }
    });
    el['clear-route-btn'].addEventListener('click', () => {
      this.picker.clearWaypoints();
      this.settings.route.points = null;
      this.settings.route.waypoints = [];
      this.renderWaypoints();
      this.onChange('geometry');
    });
    el['gpx-btn'].addEventListener('click', () => el['gpx-input'].click());
    el['gpx-input'].addEventListener('change', (e) => this.loadGpx(e.target.files[0]));

    el['building-parts'].addEventListener('change', (e) => {
      this.settings.print.buildingDetail = e.target.checked ? 'parts' : 'simple';
      this.onChange('data');
    });

    for (const tab of document.querySelectorAll('.stage-tab')) {
      tab.addEventListener('click', () => this.showPane(tab.dataset.view));
    }
    if (this.isNarrow()) {
      this.showPane('map');
      this.clearStale();
    }

    for (const btn of document.querySelectorAll('[data-cam]')) {
      btn.addEventListener('click', () => this.viewer.setView(btn.dataset.cam));
    }

    const spin = el['spin-btn'];
    spin.addEventListener('click', () => {
      const on = spin.getAttribute('aria-pressed') !== 'true';
      spin.setAttribute('aria-pressed', String(on));
      spin.classList.toggle('is-active', on);
      this.viewer.setAutoRotate(on);
    });

    el['help-btn'].addEventListener('click', () => el.guide.showModal());
    el['guide-close'].addEventListener('click', () => el.guide.close());

    const handle = el['sheet-handle'];
    handle.addEventListener('click', () => {
      const open = el.sidebar.classList.toggle('is-open');
      handle.setAttribute('aria-expanded', String(open));
      if (open) el.sidebar.scrollTop = 0;
    });
    el['generate-btn'].addEventListener('click', () => {
      if (window.matchMedia('(max-width: 860px)').matches) {
        el.sidebar.classList.remove('is-open');
        handle.setAttribute('aria-expanded', 'false');
      }
    });

    this.wireSearch();

    window.addEventListener('beforeunload', () => this.saveSettings());
  }

  isNarrow() {
    return window.matchMedia('(max-width: 860px)').matches;
  }

  showPane(view) {
    for (const t of document.querySelectorAll('.stage-tab')) {
      t.classList.toggle('is-active', t.dataset.view === view);
    }
    this.el['stage-panes'].dataset.view = view;
    requestAnimationFrame(() => {
      this.picker.invalidateSize();
      this.viewer.resize();
      this.viewer.frameModel();
    });
  }

  wireSearch() {
    const input = this.el['search-input'];
    const results = this.el['search-results'];
    let timer = null;
    let controller = null;
    let items = [];
    let active = -1;

    const close = () => {
      results.hidden = true;
      active = -1;
    };

    const render = (list) => {
      items = list;
      results.innerHTML = '';
      if (!list.length) {
        results.innerHTML = '<li class="r-empty">Nothing found. Try adding a city or country.</li>';
        results.hidden = false;
        return;
      }
      list.forEach((item, i) => {
        const li = document.createElement('li');
        li.role = 'option';
        li.innerHTML = `<span class="r-main"></span><span class="r-detail"></span>`;
        li.querySelector('.r-main').textContent = item.label;
        li.querySelector('.r-detail').textContent = item.detail || '';
        li.addEventListener('mousedown', (e) => {
          e.preventDefault();
          this.gotoPlace(item);
          close();
        });
        li.addEventListener('mouseenter', () => {
          active = i;
          highlight();
        });
        results.appendChild(li);
      });
      results.hidden = false;
    };

    const highlight = () => {
      [...results.children].forEach((li, i) =>
        li.setAttribute('aria-selected', String(i === active))
      );
    };

    input.addEventListener('input', () => {
      clearTimeout(timer);
      controller?.abort();
      const q = input.value.trim();
      if (q.length < 2) return close();
      const wait = geocode.looksLikeStreetAddress(q) ? 550 : 220;
      timer = setTimeout(async () => {
        controller = new AbortController();
        try {
          render(
            await geocode.suggest(q, {
              near: this.settings.location,
              signal: controller.signal,
            })
          );
        } catch { }
      }, wait);
    });

    input.addEventListener('keydown', (e) => {
      if (results.hidden) {
        if (e.key === 'Enter' && input.value.trim()) {
          e.preventDefault();
          this.searchAndGo(input.value.trim());
        }
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        highlight();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (items[active]) {
          this.gotoPlace(items[active]);
          close();
        } else {
          this.searchAndGo(input.value.trim());
          close();
        }
      } else if (e.key === 'Escape') {
        close();
      }
    });

    input.addEventListener('blur', () => setTimeout(close, 140));
  }

  async searchAndGo(query) {
    this.status(`Looking up “${query}”…`, 'busy');
    try {
      const [best] = await geocode.searchNominatim(query, 1);
      if (!best) return this.status(`No match for “${query}”.`, 'bad');
      this.gotoPlace(best);
    } catch (err) {
      this.status(`Lookup failed: ${err.message}`, 'bad');
    }
  }

  gotoPlace(place) {
    this.settings.location.lat = place.lat;
    this.settings.location.lon = place.lon;
    this.settings.location.label = place.label;

    if (place.kind === 'house' || place.kind === 'coordinates') {
      this.settings.size.areaMetres = clamp(this.settings.size.areaMetres, 300, 1200);
    } else if (place.bbox) {
      const span = spanOfBbox(place.bbox);
      if (span > 200) {
        this.settings.size.areaMetres = clamp(span * 1.05, 300, 20000);
      }
    }

    if (!this.settings.nameplate.title) {
      const source =
        place.kind === 'house' ? place.detail.split(',')[0].trim() || place.label : place.label;
      this.settings.nameplate.title = source.toUpperCase().slice(0, 40);
    }

    this.el['search-input'].value = '';
    this.picker.update(this.settings);
    this.picker.focus();
    this.syncUi();
    this.onChange('data');
    this.status(`${place.label} — press Generate to build it.`);
  }

  async useMyLocation() {
    if (!navigator.geolocation) return this.toast('This browser has no location support.', 'warn');
    this.status('Asking for your location…', 'busy');
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude: lat, longitude: lon } = pos.coords;
        const place = await geocode.reverse(lat, lon);
        this.gotoPlace({
          lat,
          lon,
          label: place.city || 'My location',
          detail: place.display,
          kind: 'house',
        });
      },
      (err) => this.status(`Location unavailable: ${err.message}`, 'bad'),
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 }
    );
  }

  async fillCoords() {
    const { lat, lon } = this.settings.location;
    this.settings.nameplate.subtitle = geocode.formatCoords(lat, lon);
    if (!this.settings.nameplate.title) {
      const place = await geocode.reverse(lat, lon);
      this.settings.nameplate.title = (place.city || 'Somewhere').toUpperCase();
    }
    this.syncUi();
    this.onChange('geometry');
  }

  renderWaypoints() {
    const list = this.el['waypoint-list'];
    const points = this.settings.route.waypoints;
    list.innerHTML = '';
    points.forEach((w, i) => {
      const li = document.createElement('li');
      const letter = i === 0 ? 'A' : i === points.length - 1 ? 'B' : String(i);
      li.innerHTML = `
        <span class="wp-badge">${letter}</span>
        <span class="wp-coords">${w.lat.toFixed(4)}, ${w.lon.toFixed(4)}</span>
        <button class="wp-drop" type="button" title="Remove">×</button>`;
      li.querySelector('.wp-drop').addEventListener('click', () => {
        points.splice(i, 1);
        this.picker.setWaypoints(points);
        this.renderWaypoints();
        this.resolveRoute();
      });
      list.appendChild(li);
    });
  }

  async resolveRoute() {
    const s = this.settings.route;
    const summary = this.el['route-summary'];

    if (s.waypoints.length < 2) {
      this.picker.setRoute([]);
      s.points = null;
      summary.innerHTML = s.waypoints.length
        ? 'Add one more point to route between them.'
        : 'Click <strong>Pick points on map</strong>, then click a start and an end.';
      this.onChange('geometry');
      return;
    }

    summary.textContent = 'Finding a route…';
    try {
      const result = await routing.routeBetween(s.waypoints, s.profile);
      s.points = result.points;
      s.distance = result.distance;
      s.duration = result.duration;
      s.source = result.source;
      this.picker.setRoute(result.points);
      summary.innerHTML =
        `<strong>${routing.formatDistance(result.distance)}</strong>` +
        (result.duration ? ` · ${routing.formatDuration(result.duration)}` : '') +
        ` · ${result.source}`;
      this.settings.layers.route = true;
      this.syncUi();
      this.onChange('geometry');
    } catch (err) {
      summary.textContent = err.message;
      this.toast(err.message, 'bad');
    }
  }

  async loadGpx(file) {
    if (!file) return;
    try {
      const track = routing.parseGpx(await file.text());
      this.settings.route.points = track.points;
      this.settings.route.distance = track.distance;
      this.settings.route.waypoints = [];
      this.settings.route.source = 'GPX';
      this.settings.layers.route = true;

      this.picker.setWaypoints([]);
      this.picker.setRoute(track.points);
      this.renderWaypoints();

      const bbox = bboxOfPoints(track.points);
      this.settings.location.lat = (bbox.minLat + bbox.maxLat) / 2;
      this.settings.location.lon = (bbox.minLon + bbox.maxLon) / 2;
      this.settings.size.areaMetres = clamp(spanOfBbox(bbox) * 1.15, 200, 40000);

      this.el['route-summary'].innerHTML =
        `<strong>${routing.formatDistance(track.distance)}</strong> · ${track.name || file.name}`;
      this.picker.update(this.settings);
      this.picker.focus();
      this.syncUi();
      this.onChange('data');
      this.toast(`Loaded ${track.points.length.toLocaleString()} track points.`, 'good');
    } catch (err) {
      this.toast(err.message, 'bad');
    }
    this.el['gpx-input'].value = '';
  }

  startDrawing() {
    this.picker.setMode(this.picker.mode === 'draw' ? 'pan' : 'draw');
    if (this.picker.mode === 'draw') {
      this.toast('Click to place corners, then double-click to close the shape.');
    }
  }

  initImports() {
    this.importsPanel = new ImportsPanel({
      onChange: (datasets) => {
        this.imports = datasets;
        this.merged = null;
        this.onChange('geometry');
      },
      onFocus: (bbox) => {
        if (!bbox) return;
        this.settings.location.lat = (bbox.minLat + bbox.maxLat) / 2;
        this.settings.location.lon = (bbox.minLon + bbox.maxLon) / 2;
        const span = spanOfBbox(bbox);
        if (span > 120) this.settings.size.areaMetres = clamp(span * 1.2, 200, 20000);
        this.picker.update(this.settings);
        this.picker.focus();
        this.syncUi();
        this.onChange('data');
      },
      onMessage: (text, tone) => this.toast(text, tone),
    });
    this.importsPanel.restore();
  }

  featuresForBuild() {
    if (!this.cache.features) return null;
    if (!this.imports.length) return this.cache.features;
    if (!this.merged) this.merged = applyImports(this.cache.features, this.imports).features;
    return this.merged;
  }

  onChange(kind) {
    this.saveSettings();
    if (kind === 'style') return;

    if (kind === 'data') this.dataStale = true;
    clearTimeout(this._rebuildTimer);
    this._rebuildTimer = setTimeout(() => {
      if (this.cacheCovers()) {
        this.dataStale = false;
        this.rebuild();
      } else {
        this.dataStale = true;
        this.markStale();
      }
    }, 320);
  }

  markStale() {
    const btn = this.el['generate-btn'];
    btn.classList.add('is-active');
    btn.querySelector('.btn-label').textContent = this.isNarrow() ? 'Fetch' : 'Fetch map data';
    this.status('This area needs fresh map data — press Fetch map data.', 'warn');
  }

  clearStale() {
    const btn = this.el['generate-btn'];
    btn.classList.remove('is-active');
    btn.querySelector('.btn-label').textContent = this.isNarrow() ? 'Generate' : 'Generate model';
  }

  requiredBbox() {
    const s = this.settings;
    const mmPerMetre = s.size.printMm / s.size.areaMetres;
    const outerMm = shapeOuterRadius({
      shape: s.shape.type,
      radius: s.size.printMm / 2,
      rotation: s.shape.rotation,
      aspect: s.shape.aspect,
      custom: s.shape.type === 'custom' && s.shape.custom
        ? s.shape.custom.map(([lat, lon]) => {
            const proj = createProjection(s.location.lat, s.location.lon);
            const [x, y] = proj.forward(lat, lon);
            return [x * mmPerMetre, y * mmPerMetre];
          })
        : null,
    });
    const radiusM = (outerMm / mmPerMetre) * 1.06;
    const proj = createProjection(s.location.lat, s.location.lon);
    const dLat = proj.metresToDegLat(radiusM);
    const dLon = proj.metresToDegLon(radiusM);
    return {
      minLat: s.location.lat - dLat,
      maxLat: s.location.lat + dLat,
      minLon: s.location.lon - dLon,
      maxLon: s.location.lon + dLon,
    };
  }

  requiredLayers() {
    const layers = [...DATA_LAYERS];
    if (this.settings.layers.trees) layers.push('trees');
    return layers;
  }

  cacheCovers() {
    const c = this.cache;
    if (!c.features || !c.bbox) return false;
    if (c.detail !== this.settings.print.buildingDetail) return false;
    for (const layer of this.requiredLayers()) {
      if (!c.layers.includes(layer)) return false;
    }
    const need = this.requiredBbox();
    return (
      need.minLat >= c.bbox.minLat &&
      need.maxLat <= c.bbox.maxLat &&
      need.minLon >= c.bbox.minLon &&
      need.maxLon <= c.bbox.maxLon
    );
  }

  async generate(opts = {}) {
    if (this.busy) return;
    this.setBusy(true);
    this.clearStale();

    try {
      if (!this.cacheCovers()) {
        const bbox = padBbox(this.requiredBbox(), 0.18);
        const layers = this.requiredLayers();
        const query = overpass.buildQuery(bbox, layers);

        this.progress(0.05);
        const json = await overpass.runQuery(query, {
          onProgress: (msg) => this.status(msg, 'busy'),
        });

        this.progress(0.3);
        this.status('Sorting features…', 'busy');
        this.cache = {
          bbox,
          layers,
          detail: this.settings.print.buildingDetail,
          features: overpass.parseElements(json.elements || []),
          bytes: overpass.estimateSize(json),
        };
        this.merged = null;
        this.dataStale = false;
      }

      if (this.settings.terrain.enabled) {
        this.status('Sampling terrain…', 'busy');
        this.heightGrid = await elevation.fetchHeightGrid(
          padBbox(this.requiredBbox(), 0.05),
          this.settings.terrain.resolution,
          { onProgress: (msg) => this.status(msg, 'busy') }
        );
      } else {
        this.heightGrid = null;
      }

      await this.rebuild({ keepBusy: true, silent: opts.silent });
    } catch (err) {
      this.setBusy(false);
      this.status(err.message, 'bad');
      this.toast(err.message, 'bad');
    }
  }

  async rebuild(opts = {}) {
    if (!this.cache.features) return;
    if (this.busy && !opts.keepBusy) return;
    this.setBusy(true);

    if (this.settings.terrain.enabled && !this.heightGrid) {
      try {
        this.heightGrid = await elevation.fetchHeightGrid(
          padBbox(this.requiredBbox(), 0.05),
          this.settings.terrain.resolution,
          { onProgress: (msg) => this.status(msg, 'busy') }
        );
      } catch (err) {
        this.toast(`Terrain unavailable: ${err.message}`, 'warn');
        this.settings.terrain.enabled = false;
        this.syncUi();
      }
    }

    const jobId = ++this.jobId;
    this._silentJob = Boolean(opts.silent);
    this.status('Building model…', 'busy');

    this.worker.postMessage({
      type: 'build',
      jobId,
      payload: {
        features: this.featuresForBuild(),
        settings: JSON.parse(JSON.stringify(this.settings)),
        heightGrid:
          this.settings.terrain.enabled && this.heightGrid
            ? { ...this.heightGrid, values: this.heightGrid.values.slice() }
            : null,
        routePoints: this.settings.layers.route ? this.settings.route.points : null,
        font: this.font,
      },
    });
  }

  onWorkerMessage(msg) {
    if (msg.jobId !== this.jobId) return;

    if (msg.type === 'progress') {
      this.progress(0.35 + msg.fraction * 0.6);
      this.status(msg.message, 'busy');
      return;
    }

    if (msg.type === 'error') {
      this.setBusy(false);
      this.status(`Build failed: ${msg.message}`, 'bad');
      this.toast(`Build failed: ${msg.message}`, 'bad');
      console.error(msg.stack || msg.message);
      return;
    }

    if (msg.type !== 'done') return;

    this.model = msg.result;
    this.viewer.setModel(msg.result.parts, { frameCamera: !this._hasFramed });
    this._hasFramed = true;
    this.el['viewport-empty'].hidden = true;
    this.el['export-btn'].disabled = !msg.result.parts.length;

    this.applyLayerVisibility();
    this.renderStats(msg.result);
    this.setBusy(false);

    if (this.isNarrow() && !this._silentJob) this.showPane('model');

    const { stats, warnings } = msg.result;
    this.status(
      `${stats.buildingCount.toLocaleString()} buildings · ` +
        `${stats.triangles.toLocaleString()} triangles · built in ${(stats.elapsedMs / 1000).toFixed(1)}s`,
      'good'
    );
    if (!this._silentJob) {
      for (const w of warnings.slice(0, 3)) this.toast(w, 'warn');
    }
  }

  applyLayerVisibility() {
    for (const [id, ui] of this.layerRows) {
      const key = ui.toggleKey;
      const on = key ? Boolean(this.settings.layers[key]) : true;
      this.viewer.setPartVisible(id, on);
      const part = this.model?.parts.find((p) => p.id === id);
      ui.row.querySelector('.layer-count').textContent = part
        ? `${(part.triangleCount / 1000).toFixed(1)}k`
        : '';
      ui.row.classList.toggle('is-off', !on || !part);
    }
  }

  renderStats(result) {
    const { stats } = result;
    const cm3 = stats.volumeMm3 / 1000;
    const grams = cm3 * 1.24 * 0.55;
    this.el['status-stats'].innerHTML = [
      `<span class="s-dims"><b>${stats.widthMm.toFixed(0)}</b>×<b>${stats.depthMm.toFixed(0)}</b>×<b>${stats.heightMm.toFixed(1)}</b> mm</span>`,
      `<span class="s-scale">1:<b>${stats.scaleDenominator.toLocaleString()}</b></span>`,
      `<span class="s-mass">≈<b>${grams.toFixed(0)}</b> g</span>`,
      stats.terrainRelief > 2
        ? `<span class="s-relief"><b>${stats.terrainRelief.toFixed(0)}</b> m relief</span>`
        : '',
    ].join('');

    if (stats.terrainRelief > 0) {
      this.el['relief-readout'].textContent =
        `Real relief across this area: ${stats.terrainRelief.toFixed(0)} m.`;
    }
  }

  doExport() {
    if (!this.model?.parts.length) return;
    const visible = this.model.parts.filter((p) => {
      const key = layerToggleKey(p.id);
      return key ? this.settings.layers[key] !== false : true;
    });
    if (!visible.length) return this.toast('Every layer is switched off.', 'warn');

    try {
      const { lat, lon } = this.settings.location;
      const { blob, filename } = buildExport(this.exportFormat, visible, {
        title: this.settings.nameplate.title || this.settings.location.label,
        coords: geocode.formatCoords(lat, lon),
        scale: `1:${this.model.stats.scaleDenominator.toLocaleString()}`,
        description: `${this.settings.size.areaMetres.toFixed(0)} m across, printed at ${this.settings.size.printMm} mm. Map data © OpenStreetMap contributors.`,
      });
      downloadBlob(blob, filename);
      this.toast(`Saved ${filename} (${formatBytes(blob.size)}).`, 'good');
    } catch (err) {
      this.toast(err.message, 'bad');
    }
  }

  async saveSnapshot() {
    const blob = await this.viewer.snapshot(2);
    if (!blob) return this.toast('Could not capture the view.', 'bad');
    downloadBlob(blob, `${slugify(this.settings.nameplate.title || 'skyline')}.png`);
  }

  async copyLink() {
    const url = this.writeHash();
    history.replaceState(null, '', url);
    try {
      await navigator.clipboard.writeText(url);
      this.toast('Link copied. It carries every setting.', 'good');
    } catch {
      this.toast('Link is in the address bar — copy it from there.', 'warn');
    }
  }

  applyPalette(name) {
    const preset = PALETTES[name] || {};
    for (const part of PARTS) {
      this.settings.colors[part.id] = preset[part.id] || part.color;
    }
    this.syncUi();
    for (const part of PARTS) this.viewer.setPartColor(part.id, this.settings.colors[part.id]);
    this.saveSettings();
  }

  reset() {
    const keep = { ...this.settings.location };
    this.settings = defaultSettings();
    this.settings.location = keep;
    history.replaceState(null, '', location.pathname);
    this.picker.update(this.settings);
    this.picker.clearWaypoints();
    this.syncUi();
    this.onChange('data');
    this.toast('Back to defaults.');
  }

  syncUi() {
    for (const b of this.bindings) b.write(this.get(b.path));

    for (const btn of document.querySelectorAll('[data-shape]')) {
      btn.setAttribute('aria-checked', String(btn.dataset.shape === this.settings.shape.type));
    }
    for (const btn of document.querySelectorAll('[data-profile]')) {
      btn.setAttribute('aria-checked', String(btn.dataset.profile === this.settings.route.profile));
    }
    for (const btn of document.querySelectorAll('[data-format]')) {
      btn.setAttribute('aria-checked', String(btn.dataset.format === this.exportFormat));
    }

    for (const [id, ui] of this.layerRows) {
      const color = this.settings.colors[id] || PARTS.find((p) => p.id === id).color;
      ui.colorInput.value = color;
      ui.swatchLabel.style.background = color;
      if (ui.toggleKey) ui.check.checked = Boolean(this.settings.layers[ui.toggleKey]);
    }

    this.el['building-parts'].checked = this.settings.print.buildingDetail === 'parts';
    this.syncOutputs();
    this.syncConditionals();
    this.updateScaleReadout();
    this.picker.update(this.settings);
    if (this.model) this.applyLayerVisibility();
  }

  syncOutputs() {
    for (const out of document.querySelectorAll('[data-out]')) {
      out.textContent = formatValue(this.get(out.dataset.out), out.dataset.fmt);
    }
  }

  syncConditionals() {
    for (const el of document.querySelectorAll('[data-show-when]')) {
      const [path, expected] = el.dataset.showWhen.split('=');
      const actual = this.get(path);
      const match = expected === 'true'
        ? Boolean(actual)
        : expected === 'false'
          ? !actual
          : String(actual) === expected;
      el.classList.toggle('is-shown', match);
    }
  }

  updateScaleReadout() {
    const s = this.settings;
    const denominator = Math.round(s.size.areaMetres / (s.size.printMm / 1000));
    const perCm = s.size.areaMetres / (s.size.printMm / 10);
    this.el['scale-readout'].innerHTML =
      `Scale <b>1:${denominator.toLocaleString()}</b>\n` +
      `1 cm of print = <b>${perCm < 1000 ? `${perCm.toFixed(0)} m` : `${(perCm / 1000).toFixed(2)} km`}</b> of city`;
  }

  setBusy(busy) {
    this.busy = busy;
    const btn = this.el['generate-btn'];
    btn.disabled = busy;
    btn.classList.toggle('is-busy', busy);
    this.el.progress.hidden = !busy;
    if (!busy) this.progress(0);
  }

  progress(fraction) {
    this.el['progress-bar'].style.width = `${Math.round(clamp(fraction, 0, 1) * 100)}%`;
  }

  status(text, tone = '') {
    this.el['status-text'].textContent = text;
    const dot = this.el['status-dot'];
    dot.className = 'status-dot' + (tone ? ` is-${tone}` : '');
  }

  toast(message, tone = '') {
    const el = document.createElement('div');
    el.className = 'toast' + (tone ? ` is-${tone}` : '');
    el.textContent = message;
    this.el.toasts.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .3s, transform .3s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(6px)';
      setTimeout(() => el.remove(), 320);
    }, tone === 'bad' ? 9000 : 5200);
  }
}

function layerToggleKey(partId) {
  const map = {
    buildings: 'buildings',
    roofs: 'roofs',
    roads: 'roads',
    roadsMajor: 'roads',
    rail: 'rail',
    water: 'water',
    green: 'green',
    trees: 'trees',
    route: 'route',
    frame: 'frame',
    label: 'nameplate',
  };
  return map[partId] || null;
}

function isDataPath(path) {
  return path === 'size.areaMetres' || path.startsWith('location.');
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function padBbox(bbox, fraction) {
  const dLat = (bbox.maxLat - bbox.minLat) * fraction;
  const dLon = (bbox.maxLon - bbox.minLon) * fraction;
  return {
    minLat: bbox.minLat - dLat,
    maxLat: bbox.maxLat + dLat,
    minLon: bbox.minLon - dLon,
    maxLon: bbox.maxLon + dLon,
  };
}

function bboxOfPoints(points) {
  let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
  for (const [lat, lon] of points) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  return { minLat, minLon, maxLat, maxLon };
}

function spanOfBbox(bbox) {
  const midLat = (bbox.minLat + bbox.maxLat) / 2;
  const mLat = (bbox.maxLat - bbox.minLat) * 111320;
  const mLon =
    (bbox.maxLon - bbox.minLon) * 111320 * Math.cos((midLat * Math.PI) / 180);
  return Math.max(mLat, mLon);
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function formatValue(value, fmt) {
  if (value == null) return '';
  switch (fmt) {
    case 'mm': return `${Number(value).toFixed(1)} mm`;
    case 'mm2': return `${Number(value).toFixed(1)} mm²`;
    case 'metres': return `${Math.round(value)} m`;
    case 'deg': return `${Math.round(value)}°`;
    case 'x': return `${Number(value).toFixed(1)}×`;
    case 'ratio': return Number(value).toFixed(2);
    case 'grid': return `${Math.round(value)} × ${Math.round(value)}`;
    case 'int': return Math.round(value).toLocaleString();
    case 'distance':
      return value < 1000
        ? `${Math.round(value / 10) * 10} m`
        : `${(value / 1000).toFixed(value < 10000 ? 2 : 1)} km`;
    default: return String(value);
  }
}

function shapeIcon(id) {
  if (id === 'custom') {
    return `<svg viewBox="0 0 100 100"><polygon points="14,34 52,10 90,30 80,84 26,90" stroke-dasharray="9 7"/></svg>`;
  }
  const ring = buildShapeRing({ shape: id, radius: 38, rotation: 0, aspect: 1.5 });
  const points = ring
    .slice(0, -1)
    .map(([x, y]) => `${(50 + x).toFixed(1)},${(50 - y).toFixed(1)}`)
    .join(' ');
  return `<svg viewBox="0 0 100 100"><polygon points="${points}"/></svg>`;
}

window.addEventListener('DOMContentLoaded', () => {
  window.skylineForge = new App();
});

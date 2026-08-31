import { createProjection } from './core/projection.js';
import { buildShapeRing } from './core/shapes.js';

const L = window.L;

export const BASEMAPS = [
  {
    id: 'carto-light',
    label: 'Light',
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 20,
  },
  {
    id: 'carto-dark',
    label: 'Dark',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 20,
  },
  {
    id: 'osm',
    label: 'Standard',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  },
];

const WORLD_RING = [
  [-89.9, -179.9],
  [-89.9, 179.9],
  [89.9, 179.9],
  [89.9, -179.9],
];

export class MapPicker {
  constructor(element, handlers = {}) {
    this.handlers = handlers;
    this.mode = 'pan';
    this.settings = null;
    this.waypoints = [];
    this.waypointMarkers = [];
    this.drawPoints = [];

    this.map = L.map(element, {
      zoomControl: true,
      attributionControl: true,
      worldCopyJump: true,
      scrollWheelZoom: true,
    }).setView([40.7484, -73.9857], 14);

    this.tileLayer = null;
    this.setBasemap('carto-light');

    this.maskLayer = L.polygon([WORLD_RING], {
      stroke: false,
      fillColor: '#0b0e12',
      fillOpacity: 0.55,
      interactive: false,
      className: 'plate-mask',
    }).addTo(this.map);

    this.outlineLayer = L.polygon([], {
      color: '#ffb454',
      weight: 2.5,
      fillOpacity: 0,
      className: 'plate-outline',
    }).addTo(this.map);

    this.routeLayer = L.polyline([], {
      color: '#e0483e',
      weight: 4,
      opacity: 0.95,
    }).addTo(this.map);

    this.drawLayer = L.polyline([], {
      color: '#7ee0a1',
      weight: 2.5,
      dashArray: '6 5',
    }).addTo(this.map);

    this._buildHandles();
    this._wireInteractions(element);
  }

  setBasemap(id) {
    const def = BASEMAPS.find((b) => b.id === id) || BASEMAPS[0];
    if (this.tileLayer) this.map.removeLayer(this.tileLayer);
    this.tileLayer = L.tileLayer(def.url, {
      attribution: def.attribution,
      subdomains: def.subdomains || 'abc',
      maxZoom: def.maxZoom || 19,
      detectRetina: true,
    });
    this.tileLayer.addTo(this.map);
    if (this.maskLayer) this.maskLayer.bringToFront();
    this.basemapId = def.id;
  }

  _buildHandles() {
    const dot = (cls) =>
      L.divIcon({ className: `handle ${cls}`, iconSize: [16, 16], iconAnchor: [8, 8] });

    this.centreHandle = L.marker([0, 0], {
      icon: dot('handle-centre'),
      draggable: true,
      keyboard: false,
      zIndexOffset: 500,
      title: 'Drag to move the plate',
    }).addTo(this.map);

    this.centreHandle.on('drag', (e) => {
      const { lat, lng } = e.target.getLatLng();
      this._commitCentre(lat, lng, { live: true });
    });
    this.centreHandle.on('dragend', () => this._emitChange());

    this.sizeHandle = L.marker([0, 0], {
      icon: dot('handle-size'),
      draggable: true,
      keyboard: false,
      zIndexOffset: 500,
      title: 'Drag to resize the area',
    }).addTo(this.map);

    this.sizeHandle.on('drag', (e) => {
      if (!this.settings) return;
      const centre = L.latLng(this.settings.location.lat, this.settings.location.lon);
      const metres = centre.distanceTo(e.target.getLatLng());
      this.settings.size.areaMetres = clamp(metres * 2, 120, 40000);
      this._redraw();
      this.handlers.onChange?.(this.settings, { live: true });
    });
    this.sizeHandle.on('dragend', () => this._emitChange());
  }

  _wireInteractions(element) {
    element.addEventListener(
      'wheel',
      (event) => {
        if (!event.shiftKey || !this.settings) return;
        event.preventDefault();
        event.stopPropagation();
        const factor = event.deltaY > 0 ? 1.08 : 1 / 1.08;
        this.settings.size.areaMetres = clamp(
          this.settings.size.areaMetres * factor,
          120,
          40000
        );
        this._redraw();
        this._emitChange();
      },
      { passive: false, capture: true }
    );

    let dragging = null;
    this.outlineLayer.on('mousedown', (e) => {
      if (this.mode !== 'pan') return;
      dragging = {
        start: e.latlng,
        origin: { ...this.settings.location },
      };
      this.map.dragging.disable();
      L.DomEvent.stop(e);
    });

    this.map.on('mousemove', (e) => {
      if (!dragging) return;
      const dLat = e.latlng.lat - dragging.start.lat;
      const dLon = e.latlng.lng - dragging.start.lng;
      this._commitCentre(dragging.origin.lat + dLat, dragging.origin.lon + dLon, {
        live: true,
      });
    });

    this.map.on('mouseup', () => {
      if (!dragging) return;
      dragging = null;
      this.map.dragging.enable();
      this._emitChange();
    });

    this.map.on('click', (e) => {
      if (this.mode === 'route') {
        this.addWaypoint(e.latlng.lat, e.latlng.lng);
      } else if (this.mode === 'draw') {
        this.drawPoints.push([e.latlng.lat, e.latlng.lng]);
        this.drawLayer.setLatLngs([...this.drawPoints, this.drawPoints[0]]);
      }
    });

    this.map.on('dblclick', (e) => {
      if (this.mode !== 'draw') return;
      L.DomEvent.stop(e);
      this.finishDrawing();
    });
  }

  _commitCentre(lat, lon, opts = {}) {
    if (!this.settings) return;
    this.settings.location.lat = clamp(lat, -85, 85);
    this.settings.location.lon = wrapLon(lon);
    this._redraw();
    if (opts.live) this.handlers.onChange?.(this.settings, { live: true });
  }

  _emitChange() {
    this.handlers.onChange?.(this.settings, { live: false });
  }

  update(settings) {
    this.settings = settings;
    this._redraw();
  }

  outlineLatLngs() {
    const s = this.settings;
    if (!s) return [];
    const proj = createProjection(s.location.lat, s.location.lon);
    const mmPerMetre = s.size.printMm / s.size.areaMetres;
    const ring = buildShapeRing({
      shape: s.shape.type,
      radius: s.size.printMm / 2,
      rotation: s.shape.rotation,
      aspect: s.shape.aspect,
      custom:
        s.shape.type === 'custom' && s.shape.custom
          ? s.shape.custom.map(([lat, lon]) => {
              const [x, y] = proj.forward(lat, lon);
              return [x * mmPerMetre, y * mmPerMetre];
            })
          : null,
    });
    return ring.map(([x, y]) => proj.inverse(x / mmPerMetre, y / mmPerMetre));
  }

  _redraw() {
    if (!this.settings) return;
    const ring = this.outlineLatLngs();
    if (!ring.length) return;

    this.outlineLayer.setLatLngs([ring]);
    this.maskLayer.setLatLngs([WORLD_RING, ring]);

    const { lat, lon } = this.settings.location;
    this.centreHandle.setLatLng([lat, lon]);

    const radiusM = this.settings.size.areaMetres / 2;
    const east = L.latLng(lat, lon).toBounds(radiusM * 2).getEast();
    this.sizeHandle.setLatLng([lat, east]);
  }

  focus(animate = true) {
    const ring = this.outlineLatLngs();
    if (!ring.length) return;
    const bounds = L.latLngBounds(ring).pad(0.35);
    this.map.flyToBounds
      ? this.map[animate ? 'flyToBounds' : 'fitBounds'](bounds, { duration: 0.6 })
      : this.map.fitBounds(bounds);
  }

  matchViewport() {
    if (!this.settings) return;
    const bounds = this.map.getBounds();
    const centre = bounds.getCenter();
    const across = Math.min(
      centre.distanceTo(L.latLng(centre.lat, bounds.getEast())) * 2,
      centre.distanceTo(L.latLng(bounds.getNorth(), centre.lng)) * 2
    );
    this.settings.location.lat = centre.lat;
    this.settings.location.lon = centre.lng;
    this.settings.size.areaMetres = clamp(across * 0.92, 120, 40000);
    this._redraw();
    this._emitChange();
  }

  flyTo(lat, lon, zoom) {
    this.map.flyTo([lat, lon], zoom ?? this.map.getZoom(), { duration: 0.8 });
  }

  fitBounds(bbox) {
    this.map.fitBounds(
      [
        [bbox.minLat, bbox.minLon],
        [bbox.maxLat, bbox.maxLon],
      ],
      { padding: [40, 40], maxZoom: 16 }
    );
  }

  setMode(mode) {
    this.mode = mode;
    this.map.getContainer().classList.toggle('mode-route', mode === 'route');
    this.map.getContainer().classList.toggle('mode-draw', mode === 'draw');
    this.map.doubleClickZoom[mode === 'draw' ? 'disable' : 'enable']();
    if (mode !== 'draw') {
      this.drawPoints = [];
      this.drawLayer.setLatLngs([]);
    }
    const editing = mode !== 'pan';
    this.centreHandle.setOpacity(editing ? 0.25 : 1);
    this.sizeHandle.setOpacity(editing ? 0.25 : 1);
    this.handlers.onModeChange?.(mode);
  }

  finishDrawing() {
    if (this.drawPoints.length < 3) return null;
    const points = this.drawPoints.slice();
    this.drawPoints = [];
    this.drawLayer.setLatLngs([]);
    this.handlers.onCustomShape?.(points);
    this.setMode('pan');
    return points;
  }

  addWaypoint(lat, lon) {
    this.waypoints.push({ lat, lon });
    this._renderWaypoints();
    this.handlers.onWaypoints?.(this.waypoints);
  }

  setWaypoints(list) {
    this.waypoints = (list || []).map((w) => ({ lat: w.lat, lon: w.lon }));
    this._renderWaypoints();
  }

  clearWaypoints() {
    this.waypoints = [];
    this._renderWaypoints();
    this.setRoute([]);
    this.handlers.onWaypoints?.(this.waypoints);
  }

  _renderWaypoints() {
    for (const m of this.waypointMarkers) this.map.removeLayer(m);
    this.waypointMarkers = this.waypoints.map((w, i) => {
      const isLast = i === this.waypoints.length - 1;
      const letter = i === 0 ? 'A' : isLast ? 'B' : String(i);
      const marker = L.marker([w.lat, w.lon], {
        draggable: true,
        icon: L.divIcon({
          className: 'waypoint-pin',
          html: `<span>${letter}</span>`,
          iconSize: [24, 24],
          iconAnchor: [12, 12],
        }),
        title: 'Drag to move, click to remove',
      }).addTo(this.map);

      marker.on('dragend', () => {
        const { lat, lng } = marker.getLatLng();
        this.waypoints[i] = { lat, lon: lng };
        this.handlers.onWaypoints?.(this.waypoints);
      });
      marker.on('click', (e) => {
        L.DomEvent.stop(e);
        this.waypoints.splice(i, 1);
        this._renderWaypoints();
        this.handlers.onWaypoints?.(this.waypoints);
      });
      return marker;
    });
  }

  setRoute(points) {
    this.routeLayer.setLatLngs(points || []);
  }

  invalidateSize() {
    this.map.invalidateSize();
  }
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function wrapLon(lon) {
  let l = lon;
  while (l > 180) l -= 360;
  while (l < -180) l += 360;
  return l;
}

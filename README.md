# Skyline Forge

Turn any city, neighbourhood or address into a **3D-printable model** — in the
browser, with no account, no server and no upload.

Search for a place, pick a plate shape, choose which layers you want in which
colours, optionally highlight a route across it, and export a colour 3MF or an
STL you can drop straight into your slicer.

**→ [Open the tool](https://dassey.github.io/skyline-forge/)** ·
[Notes for contributors](CLAUDE.md) ·
[How it is built](ARCHITECTURE.md)

---

## What it does

| | |
|---|---|
| **Find anywhere** | City, address, postcode, landmark or raw coordinates. Street addresses are resolved by Nominatim, which indexes house numbers; everything else uses Photon, which is built for type-ahead. |
| **Ten plate shapes** | Circle, square, rounded square, rectangle, hexagon, octagon, triangle, heart, star — or draw your own outline on the map. |
| **Real layers, real colours** | Buildings, roofs, main roads, streets, rail, water, parks, trees, route, frame and nameplate, each a separately coloured solid. |
| **Houses look like houses** | Pitched roofs, not flat boxes: gables, hips, spires and skillions from OSM's roof tags — and a gabled default for anything house-shaped, so machine-traced suburbs read as neighbourhoods. Roofs are their own colour; terracotta over white is the classic. |
| **Highlighted routes** | Route A→B by car, foot or bike, or drop in a GPX file — your marathon, your commute, your road trip — as a raised ribbon across the plate. |
| **Real terrain** | Optional elevation, so San Francisco arrives with its hills on. |
| **Engraved nameplate** | Raised city name and coordinates on a bar below the map. |
| **Print-aware** | Streets are widened to a printable minimum, slivers are dropped, and nothing needs supports. |
| **Bring your own data** | Drop in GeoJSON, KML, KMZ or a zipped Shapefile when OSM is thin. Reprojected automatically, heights read from any column. |
| **Four export formats** | Colour 3MF, merged STL, per-layer STL bundle, or OBJ+MTL. |

Everything runs client-side. The only network traffic is fetching map data.

It works on a phone: one pane at a time, and the settings live in a bottom
sheet that stays out of the way until you pull it up.

---

## The idea worth stealing

Most map-to-STL tools stack layers on top of each other and let the slicer
work it out. This one **carves the plate into disjoint regions** instead.

Every square millimetre is awarded to exactly one part, in priority order:

```
route → buildings → rail → main roads → streets → water → parks → ground
```

(Roofs are the one part outside the contest: each sits face-to-face on its
building, carved out of the building's own height, in its own colour.)

Each region is then extruded as its own watertight prism. That single decision
buys three things:

- **Crisp colour boundaries.** No two parts share a footprint, so there is no
  z-fighting in the preview and no ambiguity in the slicer.
- **One geometry, any number of filaments.** A single-colour print and a
  five-filament print come off exactly the same mesh.
- **Water that sits *below* the ground.** Because the regions tile the plate,
  the neighbouring side walls close the gap — a recessed river stays watertight
  without any boolean surgery on the base.

The test suite asserts this directly: the surface layers must not cover more
than 100% of the plate.

---

## Printing it

The model comes out **Z-up, in millimetres, sitting flat on the bed** — no
rotation, no scaling, no supports.

### Multi-material (AMS, MMU, Mosaic)

Export **3MF**. It arrives as one object with a coloured part per layer, so you
assign a filament per part and print.

### Single colour

Export **STL**. Everything is merged into one solid.

### Manual filament swaps

Export the **per-layer STL bundle**. Every file shares the same origin, so
loading them together reassembles the model exactly. A README in the ZIP has
the click-by-click for PrusaSlicer, Orca, Bambu Studio and Cura.

### "My slicer reports thousands of non-manifold edges"

Expected, and not a leak.

Each coloured layer is its own closed solid. Where two of them meet, they each
carry the wall between them, so that shared face has four triangles around it
rather than two — and mesh checkers count every one. A dense city has thousands
of such faces.

The number that matters is **open** edges, and it is zero. `test/manifold.mjs`
re-reads an exported 3MF the way a slicer does — welding by the coordinates
actually written to the file — and reports both counts separately:

```
$ node test/manifold.mjs test/out/manhattan-midtown.3mf
  holes (1 triangle) 0        <- leaks: none
  shared (4+)        4,810    <- parts meeting face to face
  degenerate faces   0
```

Watertight parts are exactly what a multi-material slicer wants, because each
becomes a volume it can assign a filament to. Let it "repair" if it offers;
the sliced result is the same. To avoid the warning entirely, export the
single-file STL and print in one colour, or use the per-layer bundle where each
file is independently closed.

### Settings that actually matter

| Setting | Why |
|---|---|
| **Thinnest street** | Set it to roughly your nozzle diameter (0.85 mm for a 0.4 mm nozzle). Below that, narrow streets slice into nothing. |
| **Layer height** | 0.12–0.16 mm keeps the nameplate lettering and the kerb lines legible. |
| **Base thickness** | 2 mm is enough. Increase it if you plan to hang the plate. |
| **Height scale** | OSM heights are conservative. 1.5–2× usually reads better as a skyline. |

Skip the brim — the plate has plenty of bed contact.

---

## Where the data comes from

| Source | Used for | Notes |
|---|---|---|
| [OpenStreetMap](https://www.openstreetmap.org/copyright) via [Overpass](https://overpass-api.de/) | Buildings, roads, rail, water, parks, trees | ODbL. Four mirrors, tried in turn. |
| [Photon](https://photon.komoot.io/) | Search-as-you-type | Purpose-built for typeahead. |
| [Nominatim](https://nominatim.openstreetmap.org/) | Committed lookups, reverse geocoding | Throttled to 1 req/s per their policy. |
| [Open-Meteo](https://open-meteo.com/) | Elevation | Copernicus DEM GLO-90, ~90 m postings. |
| [Valhalla](https://valhalla1.openstreetmap.de/) | Routing | Car, foot and bike. Falls back to OSRM. |

All of these are free services run on donated hardware. Requests are debounced,
throttled, cached in memory and in `sessionStorage`, and the downloaded extract
is reused whenever the plate is only being nudged. Please keep it that way.

### Building heights

OpenStreetMap knows exact heights for some buildings, floor counts for many
more, and nothing at all for the rest. The fallback chain is:

1. `height` / `building:height` (metres, feet and `12'6"` all parse)
2. `building:levels` × 3.2 m, plus a partial allowance for `roof:levels`
3. A typical height for the building type — 6.5 m for a house, 30 m for a
   hotel, 120 m for anything tagged `skyscraper`
4. 9 m

So the skyline is *plausible*, not surveyed. Use **Height scale** to taste.

---

## Bringing your own data

OpenStreetMap coverage outside city centres is often machine-traced: every
building an identical rectangle, none of them with a height. That is a data
problem, and it is usually fixable — most councils and counties publish
building footprints on an open-data portal, frequently LiDAR-derived and
carrying real heights.

Open **Your own data** and drop a file anywhere on the page.

| Format | Notes |
|---|---|
| **GeoJSON** | The easy one — a single-click export from QGIS, ArcGIS, geopandas or Overpass. |
| **Shapefile** | Zip the `.shp`, `.dbf` and `.prj` together and drop the ZIP in. |
| **KML / KMZ** | What Google Earth and My Maps produce. |

Then say what the columns mean:

- **Use as** — buildings, water, parks, streets, rail or trees. Polygons, lines
  and points each offer the layers that make sense for them.
- **Height from** — any numeric column, read as metres, feet or storeys. The
  guess comes from the values, not just the name: a column topping out at 4 is
  counting floors, one reaching 300 is measuring feet. The panel reports the
  range and median it read, and warns when a column resolves to one value
  everywhere — which means the wrong column, and a print as flat as before.
- **Replace here / Keep both** — replace swaps OSM's footprints for yours
  wherever your data reaches, and leaves the rest of the plate untouched.

Imported features are rewritten as OSM-shaped features, so they go through the
same clipping, layering and extrusion as everything else. There is nothing
second-class about them: a plate can be built entirely from an upload, with no
OSM data at all.

### Projections

Government data is almost never in lat/lon. It is in a State Plane zone, a UTM
zone or a local grid, and the numbers look like `850000, 336500` rather than
`-94.5, 39.2`.

Coordinates outside ±180/±90 are detected and reprojected using the `.prj` that
ships with the shapefile — or the `crs` member, if the GeoJSON predates
RFC 7946. Without projection information the upload is **refused** rather than
placed in the wrong hemisphere, with a message saying to include the `.prj` or
re-export as WGS84.

Nothing is uploaded. Files are parsed in the browser and stored in IndexedDB on
your own device, which is also why they are not part of the share link.

---

## Known limits

- **Coverage is OSM's coverage.** A neighbourhood nobody has mapped prints
  empty. It is usually worth a look at the map first.
- **Bridges print as solid roadbed.** No spans, no clearance underneath.
  Tunnels and anything with a negative `layer` are dropped entirely.
- **Terrain is 90 m data.** It captures hills, not kerbs. Pointless in Chicago,
  transformative in Rio.
- **Coastlines are inferred.** Ocean is mapped in OSM as an open line with land
  on the left, so the sea is reconstructed by closing that line around the
  plate edge. It handles the common cases; a plate containing several
  disconnected islands can confuse it.
- **Public APIs rate-limit.** A large area during busy hours may need a retry.
  Shrinking the plate is usually faster than waiting.

---

## Hosting your own copy

It is a static site with no build step. Fork the repository, enable GitHub
Pages, and it works.

```
index.html                the page
css/app.css
js/
├── app.js                state, control binding, the change pipeline
├── imports-ui.js         the "Your own data" panel
├── viewer.js             three.js preview
├── mappicker.js          Leaflet plate picker
├── core/                 projection, polygon ops, mesh building, shapes
├── data/                 Overpass, geocoding, elevation, routing
├── data/import/          GeoJSON / KML / shapefile readers, reprojection
├── model/                tag interpretation, the builder, the worker
└── export/               STL, 3MF, OBJ, ZIP
vendor/                   three.js, Leaflet, earcut, polygon-clipping, proj4
test/                     geometry, import, pipeline and browser suites
```

Every dependency is vendored, so there is no CDN to go down and nothing to
install. Serve the directory over HTTP (ES modules and the worker will not load
from `file://`):

```sh
npx http-server . -p 8080     # then open http://localhost:8080/
```

### Tests

```sh
node test/geometry.mjs    # geometry units — winding, watertightness, booleans
node test/import.mjs      # shapefile/GeoJSON/KML readers and reprojection
node test/smoke.mjs       # live OSM data through the whole pipeline
node test/browser.mjs     # the real page in Chromium, end to end
```

`geometry.mjs` and `import.mjs` need nothing but Node. `smoke.mjs` hits Overpass
and caches responses under `test/.cache`. `browser.mjs` needs Playwright, the
repository's only dependency of any kind — `npm install` is enough.

---

## Credits

Built on the shoulders of the map-to-model tools that came before it —
Map2Model, TerraPrinter, Terrain2STL, osm-to-3dprint, Touch Mapper and
TrailPrint3D — and on:

[three.js](https://threejs.org/) ·
[Leaflet](https://leafletjs.com/) ·
[earcut](https://github.com/mapbox/earcut) ·
[polygon-clipping](https://github.com/mfogel/polygon-clipping)

Map data © OpenStreetMap contributors, licensed under the
[ODbL](https://www.openstreetmap.org/copyright). Models you export are derived
from that data — if you publish or sell prints, credit OpenStreetMap.

Code is MIT licensed.

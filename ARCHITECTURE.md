# Rebuilding Skyline Forge

This document exists to answer one question: **if the code were gone, what
would someone need to know to build it again?**

It is not a tutorial and not API documentation. It is the design — the
decisions, the algorithms, the contracts between modules, and the order to
build them in. Someone competent with JavaScript and a little computational
geometry should be able to work from this to a functionally equivalent tool
without ever seeing the original source.

Three documents, three jobs:

| File | Answers |
|---|---|
| `README.md` | How do I *use* it? |
| `CLAUDE.md` | What will I *break*? |
| `ARCHITECTURE.md` (this) | How do I *rebuild* it? |

Read `CLAUDE.md` alongside this one. It lists the invariants that are easy to
get wrong, each of which was a real bug. This document says what to build;
that one says what will bite.

---

## 1. What it is

A browser tool that turns a place — city, address, postcode, coordinates —
into a 3D-printable model of the ground there: buildings extruded to their
real heights, roads and water and parks as separate coloured solids, on a
plate of a chosen shape, optionally with a highlighted route and a nameplate.
It exports colour 3MF, STL, per-layer STL, or OBJ.

### Hard constraints

These are not preferences. They shaped every decision below.

1. **No build step.** ES modules loaded directly by the browser. No bundler,
   no transpiler, no `npm install` to run the app. A static file server is the
   entire deployment.
2. **No backend.** No account, no key, no upload. Everything runs client-side.
3. **No paid services.** All map data comes from free public APIs used without
   keys, which means they must be treated as a scarce shared resource.
4. **Dependencies are vendored**, not fetched from a CDN. The app must work
   from a local copy with no network except the map data itself.
5. **It must work on a phone.** Not "degrade gracefully" — actually work.

Constraint 1 means every library must be usable as a plain ES module. Two
were not and had to be repackaged; see `vendor/README.md`.

### Size of the thing

Roughly 7,900 lines of JavaScript across 29 modules, 470 lines of HTML, 960 of
CSS. The builder (`js/model/build.js`, ~860 lines) and the polygon toolkit
(`js/core/geom.js`, ~700 lines) are where the difficulty lives. Everything
else is comparatively mechanical.

---

## 2. The one idea

Most map-to-model tools stack layers: draw the ground, put water on top of it,
put roads on top of that, let the slicer sort it out. It is easy and it is
why most of them produce models with z-fighting in preview, ambiguous colour
boundaries, and water that cannot be recessed without cutting the base.

**This tool carves the plate into a disjoint partition instead.** Every square
millimetre of the plate is awarded to exactly one part, in a fixed priority
order. Each resulting region is extruded as its own watertight prism.

```
route → buildings → trees → rail → main roads → streets → water → parks → ground
```

Earlier wins. A street that runs under a building is clipped away where the
building stands; the ground is whatever nobody else claimed.

Three things follow, and they are the whole reason for the design:

- **Colour boundaries are exact.** No two parts share a footprint, so there is
  nothing to z-fight and nothing for the slicer to guess.
- **One geometry serves any number of filaments.** A single-colour print and a
  five-filament print come off the identical mesh.
- **Water can sit below the ground without boolean surgery on the base.**
  Because the regions tile the plate, the neighbouring parts' side walls close
  the gap around a recessed river. It stays watertight for free.

If you rebuild this and find yourself tempted to simplify it into stacked
layers, you are throwing away all three. Don't.

The partition is verifiable, and the test suite verifies it: the region areas
must sum to 99.5–100.5% of the plate area. Measure that from the **boolean
region areas**, not from the triangle soup — the soup also counts the
redundant coplanar triangles earcut emits inside self-touching rings, which
are harmless but will hide the real number.

One part lives outside the partition: **roofs**. They claim no ground — each
is a closed solid stacked face-to-face on its building prism, exactly the way
every part already sits on the base — and they are excluded from the region
areas, so the tiling assertion never sees them. See §10.

---

## 3. Build order

Each layer depends only on the ones above it. Built in this order, every stage
is testable before the next exists.

```
1. projection      lat/lon ⇄ metres
2. geometry core   rings, winding, buffers, boolean ops, triangulation
3. mesh            extrusion to triangles
4. plate shapes    the outline the model is cut to
5. data            Overpass, geocoding, elevation, routing
6. tags            OSM tags → layer + height
7. builder         the partition, the heart of the thing
8. worker          keeps the builder off the main thread
9. export          3MF, STL, OBJ, ZIP
10. UI             controls, preview, map picker, change pipeline
11. import         bring-your-own GeoJSON / KML / Shapefile
```

Stages 1–3 are pure maths with no I/O and no DOM. Keep them that way — it is
what makes them testable in Node, and the test suite that runs against them
found around fourteen real bugs during the original build.

---

## 4. Projection (`js/core/projection.js`, ~60 lines)

**Do not use Web Mercator.** City-scale models never span more than a few
kilometres, and Mercator inflates distances by `sec(latitude)` — at 60°N that
is a factor of two, and the printed model is silently wrong.

Use a local equirectangular projection anchored at the selection centre. It is
both simpler and *more* faithful at this scale:

```
mPerDegLat = 111132.92 − 559.82·cos(2φ) + 1.175·cos(4φ) − 0.0023·cos(6φ)
mPerDegLon = 111412.84·cos(φ) − 93.5·cos(3φ) + 0.118·cos(5φ)

forward(lat, lon) → [(lon − centreLon)·mPerDegLon, (lat − centreLat)·mPerDegLat]
```

Those are the standard WGS84 series expansions, accurate to well under a metre
over any plate this tool produces. Provide `inverse()` too, plus
`metresToDegLat/Lon` for turning a radius into a bounding box, and a haversine
for route distances.

Everything downstream of this point works in **metres east/north from the
centre**. Nothing downstream knows what a latitude is.

---

## 5. Geometry core (`js/core/geom.js`, ~700 lines)

The hardest module, and the one to write tests for first. It wraps
`polygon-clipping` and `earcut` and adds everything they don't do.

### Winding

```
ringArea(ring)   signed shoelace, POSITIVE MEANS COUNTER-CLOCKWISE
orientPolygon()  forces outer rings CCW, holes CW
```

The sign convention is load-bearing and non-obvious. Earcut normalises winding
internally, so the *caps* come out right whatever you hand it — but the wall
builder reads the ring directly and only produces outward-facing normals when
the solid is consistently on the left of travel. Get the sign backwards and
every part is inside-out *and* riddled with unpaired edges, which is exactly
what happened the first time.

### Boolean operations

Wrap every `polygon-clipping` call in a guard. It throws on degenerate input
often enough to matter, and the recovery is reliable:

```
try op(...args)
catch → try op(...args.map(snapMultiPolygon))    // snap to the µm grid, retry
catch → warn, return a caller-supplied fallback
```

Union large sets in **batches** rather than one call with thousands of
polygons; it is dramatically faster and less likely to throw.

### Snapping

Snap all coordinates to a **1 µm grid** before extruding. 3MF writes
millimetres to three decimal places, and boolean output routinely places
vertices nanometres apart. Without the snap those collapse into zero-area
facets on export — 284 of them, in the bug that prompted this. Snapping first
makes the rounding lossless.

### Triangulation, and the boundary trap

`triangulatePolygon()` runs earcut, but must also return the **boundary of the
triangulation** — the set of directed half-edges that have no twin — not the
input rings.

This matters more than it sounds. Earcut occasionally produces a boundary that
is not the input ring, which happens constantly on rings that touch
themselves, which is exactly what the union of many road buffers produces.
Build the walls from the input ring in that case and the solid is left open.
Build them from the triangulation boundary and it is always closed. Call it
`capBoundary()`.

Also reject earcut's "flap" triangles — ones that land outside the polygon —
by testing each triangle's centroid for containment whenever the boundary
disagrees with the input rings. Otherwise they spill colour outside the shape.

### Polyline buffering

Roads and routes are lines that must become polygons. Offset the polyline by
half-width on both sides and cap the ends.

The caps are fiddly and easy to fold inward. Both caps must sweep by −π
starting from `base ± π/2`; interpolating linearly between the two offset
angles takes the near half of the arc and folds the cap into the road.

`densify()` inserts intermediate points so buffered curves stay smooth. The
segment count is `max(0, ceil(dist / maxLen) − 1)` — a `floor` is off by one
and leaves a visible kink.

### Other primitives worth having

- `bandAroundRings()` — for the frame and other outline-following bands.
- `gridSplit()` with bbox bucketing — for splitting huge multipolygons so
  boolean ops stay tractable.
- `dropTinyPolygons(mp, minArea)` — filter whole polygons by `|ringArea|` of
  the **outer ring only**. It must **never drop holes**: a hole is where a
  higher-priority layer already claimed the ground, and filling one in doesn't
  remove a sliver, it makes two parts overlap and puts the wrong colour on top.

---

## 6. Mesh and extrusion (`js/core/mesh.js`, ~280 lines)

A mesh accumulator (positions, normals, indices) plus:

```
extrudePolygon(mesh, poly, bottom, top, { capBottom = true })
```

which does, in order: snap → orient → triangulate → emit top cap → emit bottom
cap (reversed) → emit walls **along `tri.boundary`, never along the input
rings**.

That last point is the same trap as above and is worth stating twice, because
it is invisible until someone runs a mesh checker.

Both `bottom` and `top` accept either a number or an `(x, y) => z` function,
which is what terrain draping and sloped roofs ride on. One rule makes sloped
tops watertight: **a wall whose top and bottom are exactly equal is skipped**
(the two cap boundary edges pair with each other directly), and a wall that is
zero at one end only degenerates to a triangle. The equality is exact — so any
z-function you pass must snap its output to the micron grid, or the eave walls
come back as zero-area facets instead of disappearing.

The test to write: for every part, every directed edge has exactly one twin.
Open edges must be zero. Volume must be positive.

---

## 7. Plate shapes (`js/core/shapes.js`, ~210 lines)

Ten outlines: circle, square, rounded square, rectangle, hexagon, octagon,
triangle, heart, star, and `custom` (an arbitrary ring the user draws on the
map).

Each is generated as a ring, rotated by the user's angle, then scaled.

**Scale to the longest bounding-box axis, measured *after* rotation.** This is
the number the user needs, because it is the number that has to fit on the
print bed. An earlier version normalised the inscribed radius, which made a
heart print at 170 mm when the setting said 160.

---

## 8. Data acquisition (`js/data/`)

| Module | Service | For |
|---|---|---|
| `overpass.js` | Overpass API, 4 mirrors tried in turn | Buildings, roads, rail, water, parks, trees |
| `geocode.js` | Photon *and* Nominatim | Search |
| `elevation.js` | Open-Meteo (Copernicus DEM GLO-90) | Terrain |
| `route.js` | Valhalla, falling back to OSRM | Routes |

### Etiquette is a requirement, not a nicety

These are free services on donated hardware, used without keys. Debounce every
input, throttle every endpoint, cache in memory *and* `sessionStorage`, and
reuse the downloaded extract whenever the plate is only nudged rather than
moved. Nominatim is hard-limited to one request per second by their policy.
**Nothing may poll.**

### Two geocoders, on purpose

Photon is built for type-ahead and is the right thing for search-as-you-type.
But **Photon cannot resolve house numbers** — asked for `6624 N Broadway,
Gladstone MO` it returns the post office at 7170. Address-shaped queries must
go to Nominatim instead, on a longer debounce (~550 ms) to respect the rate
limit. Detect the shape of the query and route accordingly.

### Elevation

Do not use AWS Terrarium tiles. They serve no CORS header, so a browser can
fetch the image but cannot read its pixels — the failure is silent and
confusing. Open-Meteo returns elevations as JSON and works.

---

## 9. Tag interpretation (`js/model/tags.js`, ~230 lines)

Maps OSM tags to a layer, and building tags to a height. The height fallback
chain, in order:

1. `height` / `building:height` — parse metres, feet, and `12'6"`
2. `building:levels` × 3.2 m, plus a partial allowance for `roof:levels`
3. A typical height for the building type — 6.5 m house, 30 m hotel, 120 m for
   anything tagged `skyscraper`
4. 9 m

The result is *plausible*, not surveyed, which is why the UI exposes a height
scale.

Drop tunnels and anything with a negative `layer`. Bridges are kept but print
as solid roadbed — no spans, no clearance.

---

## 10. The builder (`js/model/build.js`, ~860 lines)

`buildModel(features, settings, ctx)` is the heart. It receives parsed
features and returns triangle buffers per part, plus statistics.

### The partition, concretely

Maintain a `claimed` multipolygon, initially empty. Process parts in priority
order. For each:

```js
const claim = (mp, clipTo = cityArea) => {
  if (!mp.length) return [];
  const bounded = intersection(mp, clipTo);
  if (!bounded.length) return [];
  const region = claimed.length ? difference(bounded, claimed) : bounded;
  const kept = dropTinyPolygons(region, minArea);
  if (kept.length) claimed = claimed.length ? union(claimed, kept) : normalize(kept);
  return kept;
};
```

**`claim()` must only claim what it actually emits.** Marking a dropped sliver
as taken punches a hole that nothing can ever fill; and a sliver that happens
to ring a small patch strands that patch as a loose object in the print. The
`kept.length` guard and claiming `kept` rather than `region` are the whole
point of the function.

Ground is the terminal part and must **never** drop slivers — it is the
catch-all that makes the areas sum to 100%.

### Other work the builder owns

- **Road widening.** Streets narrower than the minimum printable width are
  widened to it, or they slice into nothing.
- **`dropNestedBuildings()`** — grid-hashed containment test, removes
  footprints fully inside other footprints.
- **Coastline reconstruction** (`js/model/coastline.js`). Ocean is mapped in
  OSM as an open way with land on the left, so the sea has to be rebuilt by
  closing that line around the plate edge. Join chains **without reversing
  any** — the direction *is* the data. Only close pieces that crossed the
  plate boundary at both ends, and require both a sea-probe-inside and a
  land-probe-outside before accepting the result. Get this wrong and the sea
  consumes the entire plate; that is what happened to Miami.
- **Nameplate attachment** (`horizontalSpanAt()`). The bar must actually touch
  the plate, or it prints as two separate pieces. Raise the bar until the
  plate is wide enough there — on a star, the naive position is in empty
  space.
- **`stats.regionAreas`** — exact boolean areas, for the partition assertion.

### Roofs (`js/core/roof.js`, ~200 lines)

The single change that turns "a plate of boxes" into "a neighbourhood". Each
roof is a **separate closed solid** in its own `roofs` part, sitting
face-to-face on its building prism — outside the ground partition entirely, so
`regionAreas` and the tiling assertion never see it. The prism is extruded to
a lowered wall-top and the roof occupies the difference: heights are carved,
never stacked, so the skyline is exactly as tall as the tags say.

Which buildings get one (`roofSpec` in `tags.js`): an explicit `roof:shape`
always wins, folded onto three buildable forms — ridge (`gabled`, hipped,
gambrel, mansard…), point (`pyramidal`, dome, onion, tent), single slope
(`skillion`, lean_to). Without tags, house-family building types default to
gabled — and so does a **small, low, untyped `building=yes`** (25–400 m², up
to 12 m), because machine-traced suburbs, the places people actually print,
are wall-to-wall untyped rectangles. Area and height gates keep big-box stores
and towers flat.

The construction rests on one observation: split the footprint along its
ridge line and each half's roof plane is a **linear function of x and y** —
so any triangulation of the half is exactly planar, and the ordinary extruder
with a per-vertex top does all the work, gable ends included (the boundary
walls climb from eave to ridge by themselves).

- The ridge is the long axis of the footprint's **minimum-area oriented
  bounding box** (`orientedBounds` in geom.js — convex hull, then rotating
  calipers). Axis-aligned bounds misjudge any rotated house;
  `roof:orientation=across` swaps the axes.
- The halves come from boolean intersection with two half-plane rectangles
  sharing the ridge edge, so both sides compute bit-identical crossing
  points. Each resulting piece is extruded as its own closed solid — an
  L-shaped house yields three pieces, all watertight, and no piece needs any
  other to close.
- Every z is **snapped to the micron grid**, which is what arms the
  extruder's zero-height-wall rule at the eaves and keeps the two halves'
  ridge vertices identical. The coincident interior walls under the ridge are
  shared faces between two closed solids — the same benign category as two
  adjacent buildings.
- Skillion is one solid (the plane is linear over the whole footprint,
  direction from `roof:direction`, compass-parsed). Pyramidal is a bottom cap
  plus a fan to an apex over the box centre, and downgrades to gabled below
  0.8 convexity so the apex cannot hang over a concave footprint's void.
- Refusals fall back to the plain flat prism: footprints with holes
  (courtyards), eave-to-ridge runs under ~0.35 mm printed, rises under
  ~0.2 mm, degenerate bounding boxes. `addRoof` returning null must leave
  the mesh untouched.

Default pitch when OSM tags no height: ~36° from the eave-to-ridge run,
capped in real metres (6 m gabled, 8 m pyramidal), and never more than 60% of
the building's height.

---

## 11. The worker (`js/model/worker.js`, ~60 lines)

Boolean operations on a dense city take seconds. On the main thread that
freezes the map and the 3D view mid-drag, so the builder runs in a module
worker (`type: 'module'`).

Protocol: `{ type: 'build' | 'cancel', jobId, payload }` in, progress messages
and finished buffers out. **Transfer** the buffers rather than copying them.
Track a current job id and ignore results from superseded jobs — the user will
outrun the builder with a slider.

---

## 12. Export (`js/export/`)

`buildExport(format, parts, meta)` with four formats:

| Format | Shape |
|---|---|
| `3mf` | One object, one coloured part per layer. What multi-material slicers want. |
| `stl` | Everything merged into a single solid. |
| `stl-parts` | ZIP of one STL per layer, all sharing an origin so they reassemble on import. Include a README with slicer-specific instructions. |
| `obj` | OBJ + MTL, one material per layer. |

Output is **Z-up, in millimetres, sitting flat on the bed** — no rotation, no
scaling, no supports needed.

### Expect non-manifold edge warnings, and do not fix them

Each coloured part is its own closed solid. Where two parts meet face to face,
each carries its own wall, so that shared face has four triangles around it
rather than two. Mesh checkers count every one, and a dense city has thousands.

The number that matters is **open** edges, and it must be zero. Ship a
diagnostic (`test/manifold.mjs`) that re-reads an exported 3MF the way a slicer
does — welding by the coordinates actually written to the file — and reports
holes and shared faces *separately*.

Fusing the parts into one shell has been tried, measured, and reverted: it
traded 4,660 shared edges for 6,258 actual holes, because XY T-junctions
between independently computed region boundaries defeat the cancellation.
Holes are a real defect. Shared faces are not.

---

## 13. UI (`js/app.js`, `viewer.js`, `mappicker.js`, `index.html`)

- `app.js` — state, control binding, the change pipeline
- `viewer.js` — three.js preview
- `mappicker.js` — Leaflet plate picker
- `imports-ui.js` — the "Your own data" panel

### The change pipeline

The single most important thing in the UI. Every edit is classified as one of:

| Kind | Costs |
|---|---|
| `style` | Repaint only. No rebuild. |
| `geometry` | Rebuild from the cached extract. No network. |
| `data` | Needs a download. |

This is what keeps sliders instant while staying polite to the public APIs.
**When adding a control, choose its kind deliberately** — a mislabelled slider
either lags or hammers Overpass.

### Mobile

One pane at a time, settings in a bottom sheet. Two specific traps:

- **CSS Grid `1fr` has an `auto` minimum**, so a column grows to fit its
  content and overflows the viewport. Always `minmax(0, 1fr)`.
- **`renderer.setSize(w, h, false)` skips CSS sizing**, so the canvas displays
  at its backing-store size — twice the viewport on a 2× phone, with the model
  apparently off-screen. Set `.viewport canvas { width: 100%; height: 100% }`.
- Fit the camera to whichever axis is tighter, not just the vertical FOV, and
  re-fit when the aspect ratio changes by more than ~10%.

---

## 14. Import subsystem (`js/data/import/`)

OSM coverage outside city centres is often machine-traced — every building an
identical rectangle with no height. The fix is the user's own data, which most
councils publish, frequently LiDAR-derived with real heights.

| Module | Job |
|---|---|
| `shapefile.js` | `.shp` + `.dbf` + `.prj` readers |
| `unzip.js` | ZIP via `DecompressionStream('deflate-raw')` |
| `geojson.js`, `kml.js` | The easier formats |
| `index.js` | Orchestration, projection detection, column guessing |
| `merge.js` | Rewrites imports as OSM-shaped features |
| `store.js` | IndexedDB persistence |

### Three things that will catch you

1. **Shapefile ring winding is the reverse of GeoJSON.** Outer rings are
   clockwise. Find holes by orientation, not by position in the list.
2. **Refuse projected data that has no `.prj`. Never guess.** Coordinates
   outside ±180/±90 are projected; without projection information, say so and
   stop. Guessing puts a neighbourhood in the Arctic — the original test
   fixture landed at 76°N before this check existed.
3. **Guess the height unit from the values, not the column name.** A column
   topping out at 4 is counting floors; one reaching 300 is measuring feet.
   Report the range and median back to the user, and warn when a column
   resolves to a single value everywhere — that means the wrong column and a
   print as flat as before.

Use **IndexedDB**, not localStorage: the quota is too small, and uploaded
datasets have no business in a share link.

**Imported features are rewritten as OSM-shaped features and flow through the
identical pipeline.** The builder does not know or care where a footprint came
from. Keep it that way — it is why a plate can be built entirely from an
upload with no OSM data at all.

---

## 15. Data contracts

Three shapes hold the system together. Keep them JSON-serialisable: the
settings object crosses into the worker, persists to localStorage, and packs
into a share link.

**Parts** — ordered list of `{ id, label, color, hint }`. The order *is* the
priority order and the paint order. One part maps to one preview mesh, one
3MF object, one OBJ material, one file in the STL bundle. Keep that one-to-one.
The full list: route, buildings, roofs, trees, rail, main roads, streets,
water, parks, ground, frame, nameplate — roofs being the one that competes for
no ground (§2).

**Settings** — nested groups: `location`, `shape`, `size`, `layers`,
`heights` (mm, measured from the top of the base slab), `print`, `terrain`,
`nameplate`, `route`, `colors`. Merge saved settings against defaults with a
tolerant deep merge so older links keep working when new keys appear.

Defaults worth knowing: 1500 m of real world across a 160 mm plate, 2 mm base,
0.85 mm minimum road width (about one nozzle diameter), 0.5 mm² minimum
feature area, water recessed 0.7 mm.

**Features** — the neutral form the builder consumes, produced by both the
Overpass parser and the import merger.

---

## 16. Tests

Four suites, ~553 checks. The first two need nothing but Node and should run
constantly.

| Suite | Checks | Needs |
|---|---|---|
| `geometry.mjs` | 189 | Nothing. Pure maths. |
| `import.mjs` | 56 | Nothing. |
| `smoke.mjs` | 237 | Overpass on first run; caches to `test/.cache` |
| `browser.mjs` | 71 | Playwright; network stubbed |

What they must assert, in rough order of value:

1. **Watertightness.** Every part: every directed edge has exactly one twin,
   zero open edges, positive volume.
2. **The partition.** Region areas sum to 99.5–100.5% of the plate, measured
   from boolean areas.
3. **Winding.** `ringArea` sign convention; outer CCW, holes CW after
   orientation.
4. **Printed size.** Longest bounding-box axis equals the requested size,
   after rotation, for every shape including the non-convex ones.
5. **Import correctness.** Shapefile winding, reprojection, refusal of
   projected data without a `.prj`.
6. **The real page loads.** `browser.mjs` serves the repository, drives
   Chromium, and fails on any asset that does not resolve or any console
   error. It is the only test that catches a broken relative path.

Two notes for anyone re-running these. Overpass and Nominatim reject Node's
default User-Agent with 406 and 403 — the tests set one; browsers send their
own, so there is nothing to fix in the app. And keep `browser.mjs` hermetic
with stubbed network: it must not hammer the free APIs on every run.

---

## 17. Things already tried that do not work

Repeated from `CLAUDE.md` because they are exactly the ideas a rebuilder will
have, in the order they will have them:

- **Fusing the coloured parts into one manifold shell.** Measured worse. See
  §12.
- **Stacking layers instead of partitioning.** Loses crisp colour boundaries,
  single-geometry multi-material, and recessed water. See §2.
- **Web Mercator.** Wrong by `sec(latitude)`. See §4.
- **Building walls from input rings.** Leaves open solids. See §5.
- **Routing address queries to Photon.** Cannot resolve house numbers. See §8.
- **AWS Terrarium elevation tiles.** No CORS header. See §8.
- **`polygon-clipping` and `proj4` published ESM builds.** Both unusable in a
  browser — one leaves a bare `splaytree` specifier, the other is a directory
  of relative imports. Vendor them as wrapped UMD bundles;
  `vendor/README.md` has the recipe.

---

## 18. If you are starting over

Build stages 1–3 first and write `test/geometry.mjs` against them before
touching anything that talks to a network or a DOM. That suite found around
fourteen real bugs during the original build, every one of which would have
been far harder to isolate through the UI — inverted winding, a folded buffer
cap, an off-by-one in densification, walls welded to the wrong boundary,
dropped holes, over-eager claims.

The geometry is the project. The rest is plumbing.

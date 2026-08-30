# Notes for whoever works on this next

Read this before changing geometry code. Most of it is things that already went
wrong once.

Three documents, three jobs. `README.md` is how to *use* it. This file is what
will *break*. [`ARCHITECTURE.md`](ARCHITECTURE.md) is how to *rebuild* it from
nothing — the design, the algorithms, the module contracts and the order to
build them in. If you are new here and the code no longer exists, start there.

## What is here

**Skyline Forge** — a buildless browser tool that turns OpenStreetMap data into
3D-printable city models. It is the whole repository: `index.html` at the root
is the app, and GitHub Pages serves it at `https://dassey.github.io/skyline-forge/`.

It did not always live here. Until August 2026 the app sat in a `skyline/`
subfolder because the root held an unrelated "Character Creator" page, and the
repository itself was called `gen`. Both are gone. If you find a stale
`/gen/` or `/skyline/` path anywhere, it is a leftover — fix it.

## Working on it

No build step, no bundler, no `npm install` to run the app. Everything is
vendored in `vendor/`. ES modules are loaded directly by the browser.

```sh
npx http-server . -p 8080     # then http://localhost:8080/
```

It must be served over HTTP — ES modules and the model worker will not load
from `file://`.

```sh
node test/geometry.mjs    # 189 checks. Pure maths, no network. Run this constantly.
node test/import.mjs      #  56 checks. Shapefile/GeoJSON/KML readers, reprojection.
node test/smoke.mjs       # 237 checks. Live Overpass, cached under test/.cache.
node test/browser.mjs     #  71 checks. Real page in Chromium, network stubbed.
node test/manifold.mjs f  # Diagnostic, not a suite. Reads an exported 3MF.
npm run lint
```

`browser.mjs` needs Playwright (`npm install` — it is the only dependency the
repository has, and nothing the app itself ships needs it) and a fixture in
`test/.cache`, which `smoke.mjs` populates on its first run. `smoke.mjs` caches
Overpass responses on disk, so only the first run touches the network — delete
`test/.cache` to refresh.

## Invariants that will break silently if you touch them

These are load-bearing. Each has a test, and each was a real bug first.

**Ring winding.** `ringArea` is a signed shoelace where **positive means
counter-clockwise**. `orientPolygon` forces outer rings CCW and holes CW. This
matters for the *side walls*, not the caps: earcut normalises winding
internally, so its triangles are always CCW whatever it is handed, but the wall
builder reads the ring directly and only produces outward normals when the
solid is consistently on the left of travel. Get this wrong and every part is
inside-out *and* riddled with unpaired edges.

**Walls weld to the triangulation boundary, never to the input rings.** Earcut
occasionally produces a boundary that is not the input ring — on rings that
touch themselves, which the union of many road buffers throws off constantly.
Building walls from the ring in that case leaves the solid open. See
`capBoundary()`.

**Geometry is snapped to a 1 µm grid before extruding.** 3MF writes millimetres
to three decimals; boolean output routinely places vertices nanometres apart.
Without the snap those collapse on export into zero-area facets. Snapping makes
the rounding lossless.

**`dropTinyPolygons` must never drop holes.** A hole is where a higher-priority
layer already claimed the ground. Filling one in does not remove a sliver, it
makes two parts overlap and puts the wrong colour on top.

**`claim()` must only claim what it emits.** Marking a dropped sliver as taken
punches a hole nothing can fill, and a sliver that happens to ring a small patch
strands it as a loose object.

**Printed size is the longest bounding-box axis, measured after rotation.**
`scaleToExtent` in `shapes.js`. Users need the number that has to fit on the
bed. An earlier version normalised the *inscribed* radius, which made a heart
print at 170 mm when you asked for 160.

**Shapefile ring winding is the reverse of GeoJSON.** Outer rings are clockwise.
Holes are found by orientation, not position.

**Projected data with no `.prj` is refused, never guessed.** Coordinates outside
±180/±90 are projected. Guessing puts a neighbourhood in the Arctic — which the
test fixture did, at 76°N, before the check existed.

**Roof z-values are snapped to the micron grid, and a zero-height wall is
exactly zero.** The extruder skips wall quads whose top and bottom are
*identical* — that is how a roof's eave meets the wall top without emitting
zero-area facets. The comparison is `===` on purpose; it works because
`roof.js` snaps every z it produces. Feed the extruder an unsnapped sloped top
and the eave walls come back as degenerate facets in the 3MF.

**Each gabled half is its own closed solid.** The two halves share bit-identical
ridge vertices because both sides snap the same coordinates, but neither needs
the other to be watertight. Do not "optimise" them into one open-seamed solid.

**Roofs carve the building's height, they never add to it.** `addRoof` returns
the lowered wall-top and the prism stops there; the ridge lands exactly at the
height the flat roof would have had. Stack them instead and every tagged
building height in the model is wrong.

## The central design idea

The plate is carved into a **disjoint partition**: every square millimetre is
awarded to exactly one part, in priority order (route → buildings → rail → main
roads → streets → water → parks → ground), and each region is extruded as its
own watertight prism.

Roofs are the one part outside the partition: they claim no ground, they sit
face-to-face on top of the building prisms — the same stacking every part
already does against the base. They are deliberately absent from
`stats.regionAreas`, so the tiling assertion below is unaffected.

Do not "simplify" this into stacked layers. It is what makes colour boundaries
crisp, lets one geometry serve both single- and multi-material prints, and lets
water sit recessed below the ground without cutting the base.

`smoke.mjs` asserts the partition covers 99.5–100.5% of the plate, measured from
the **boolean region areas**, not from the triangle soup. The soup also counts
redundant coplanar triangles earcut emits inside self-touching rings, which are
harmless but hide the real number.

## Dead ends — do not redo these

**Fusing the coloured parts into one manifold shell.** Tried, measured,
reverted. It traded 4,660 shared edges for 6,258 actual holes, because XY
T-junctions between independently computed region boundaries defeat the
cancellation. Holes are a real defect; shared faces are not. Fixing it properly
means rebuilding the planar subdivision with consistent edges. Not worth it for
a warning that costs nothing.

**Thousands of "non-manifold edges" in an exported 3MF are expected.** They are
edges where two closed parts meet face to face. Open edges are zero. Check with
`test/manifold.mjs`, which separates the two counts. Do not "fix" this.

**Photon cannot resolve house numbers.** Asked for `6624 N Broadway, Gladstone
MO` it returns the post office at number 7170. Address-shaped queries go to
Nominatim. Do not route them back.

**AWS Terrarium elevation tiles serve no CORS header.** A browser can fetch the
image but not read its pixels. Elevation comes from Open-Meteo instead.

**polygon-clipping's and proj4's published ESM builds are unusable here.** They
leave bare specifiers (`splaytree`) or are a directory of relative imports. Both
are vendored as wrapped UMD bundles — see `vendor/README.md` for the refresh
recipe.

**CSS Grid `1fr` has an `auto` minimum**, so a column grows to fit its content
and overflows the viewport. Always `minmax(0, 1fr)`.

**`renderer.setSize(w, h, false)` skips CSS sizing.** The canvas then displays
at its backing-store size — twice the viewport on a 2× phone, with the model
apparently off-screen. `.viewport canvas` sets `width/height: 100%`.

## Layout

```
js/
  app.js          state, control binding, the change pipeline
  imports-ui.js   the "Your own data" panel
  viewer.js       three.js preview          mappicker.js  Leaflet plate picker
  core/           projection, polygon ops, mesh building, plate shapes
  data/           overpass, geocoding, elevation, routing
  data/import/    GeoJSON / KML / shapefile readers, reprojection, merge
  model/          tag interpretation, the builder, the worker
  export/         STL, 3MF, OBJ, ZIP
```

The change pipeline in `app.js` classifies every edit as **style** (repaint
only), **geometry** (rebuild from the cached extract, no network) or **data**
(needs a download). Getting that right is what keeps sliders instant while
staying polite to the free public APIs. When adding a control, pick its `kind`
deliberately.

Imported features are rewritten as OSM-shaped features in `data/import/merge.js`
and flow through the identical pipeline. The model builder does not know or care
where a footprint came from — keep it that way.

## External services

Overpass, Nominatim, Photon, Open-Meteo and Valhalla are free, run on donated
hardware, and are used without keys. Requests are debounced, throttled, and
cached in memory and `sessionStorage`; the downloaded extract is reused whenever
the plate is only nudged. Nominatim is hard-limited to one request a second.
Do not add anything that polls.

Overpass and Nominatim reject Node's default User-Agent (406 and 403). The
tests set one; browsers send their own, so there is nothing to fix in the app.

## Running it fully offline

Everything except map data works with no network: the app, the libraries, the
font, the exporters. A local copy needs only a static file server. What still
needs the internet is fetching OSM data, geocoding, elevation and routing —
there is no offline OSM extract support, and adding it would mean shipping or
importing a `.osm.pbf`, which nothing here parses today.

`node test/geometry.mjs` and `node test/import.mjs` run offline. The other two
need network on first run.

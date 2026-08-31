# Skyline Forge

Turn any city, neighbourhood or address into a 3D-printable model, in the
browser. Pick a plate shape, choose layers and colours, add a route, export
3MF / STL / OBJ.

**→ [Open the tool](https://dassey.github.io/skyline-forge/)**

Static site, no build step. To run locally, serve the directory over HTTP:

```sh
npx http-server . -p 8080
```

Tests: `node test/geometry.mjs`, `node test/import.mjs`, `node test/smoke.mjs`,
`node test/browser.mjs` (the last one needs `npm install`).

Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright)
contributors, ODbL. Code is MIT.

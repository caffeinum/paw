three.js r186 (`three@0.186.1`, MIT), vendored verbatim from the npm tarball's `build/` — no package.json
dependency, no bundler. Used only by the Office view (`web/app/office*.js`), loaded lazily on first open.
`three.module.js` imports `./three.core.js` relatively, so no importmap is needed.

Served with a one-year immutable cache (the path carries the version — rename the folder on upgrade).

Refresh: `npm pack three@<version>` (respect the 7-day release-age gate) → copy `build/three.module.js`,
`build/three.core.js` and `LICENSE` here.

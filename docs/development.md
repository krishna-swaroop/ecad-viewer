# Development

## Setup

Node 18 or later, then from the repo root:

```bash
npm install
```

## Building

```bash
npm run build -w packages/ecad-viewer-app
```

Writes `ecad-viewer.js`, `parser.worker.js` and `ecad-renderer.js` to
`packages/ecad-viewer-app/build/`. The parser is bundled from source, so it
does not need building first.

`npm run build-all -w packages/ecad-viewer-app` also builds the parser's
`dist/`, the CJK glyph bundle (`glyph-full.js`) and the 3D viewer
(`3d-viewer.js`).

`npm run serve -w packages/ecad-viewer-app` starts an esbuild dev server on
port 8012 (`ECAD_VIEWER_PORT` overrides it) that rebuilds into
`static/ecad_viewer/` with source maps and `DEBUG` on.

The WebAssembly triangulator is committed prebuilt
(`third_party/earcut-wasm/earcut_wasm.mjs`). Only rebuild it if you change
`earcut_wasm.cpp`; that needs Emscripten (see its
[README](../packages/ecad-viewer-app/third_party/earcut-wasm/README.md)).

## Testing

There is no CI on pull requests. The only workflow in `.github/workflows/`
publishes Docker images (see below). The local suites are the merge gate: run
them before you ask for review and say in the PR what you ran.

```bash
# Parser: Jest
npm test -w packages/kicad-parser

# Viewer and renderer: @web/test-runner in headless Chrome
npm test -w packages/ecad-viewer-app

# Type checks and lint
npm run lint -w packages/kicad-parser
npm run lint:types -w packages/ecad-viewer-app
npm run lint -w packages/ecad-viewer-app
npm run lint -w packages/ecad-renderer
```

Notes:

- The parser's round-trip suite runs `kicad-cli sch erc` on every serialized
  fixture. It looks for `kicad-cli` in `KICAD_CLI`, then `PATH`, then the usual
  install locations (including the macOS app bundle). Without KiCad installed
  those cases are skipped; set `REQUIRE_KICAD_CLI=1` to make a missing
  `kicad-cli` a failure.
- The viewer tests need a local Chrome. They import from `packages/` directly,
  so they test source, not the built bundle.
- Some suites use shared fixtures (`packages/kicad-parser/tests/fixtures/`),
  for example the design-variant oracle shared with KiCAD-Prism.

## Branch model

- Branch from `dev` and open pull requests against `dev`.
- `main` is updated only by merging `dev` into it.
- Prism pins a specific commit (its `scripts/ecad-viewer-upstream.lock`), not a
  branch, so merging to `dev` does not by itself change Prism.

Keep commits focused and write the reason for a change in the commit body.
Performance changes should state the board, the method and the before and
after numbers, as the existing perf commits do.

## Releases and publishing

`.github/workflows/publish.yml` is inherited from upstream and has not been
adapted to this fork. It runs when a GitHub release is published (or by manual
dispatch), and:

- looks up the latest release tag of `Huaqiu-Electronics/ecad-viewer`, not of
  this repo;
- builds the root `Dockerfile`, which clones `Huaqiu-Electronics/ecad-viewer`
  rather than using this checkout;
- pushes to `ghcr.io/Huaqiu-Electronics/ecad-viewer-service` and an Aliyun
  registry, using secrets (`Huaqiu_Electronics_TOKEN`,
  `ALIYUNCS_DOCKER_PASSWORD`) that this fork does not have.

It has never run in this fork. Do not rely on it to ship anything.

The fork's real delivery path is the Prism rebuild described in
[prism-integration.md](prism-integration.md): Prism builds from a pinned commit
of this repo and commits the bundles. The upstream release tags (`2.1.x` and
earlier) remain in the history but do not mark fork releases.

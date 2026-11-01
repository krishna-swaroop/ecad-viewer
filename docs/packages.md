# Packages

The repo is an npm workspace (`packages/*`). Three packages:

| Directory                  | npm name             | What it is                                          |
| -------------------------- | -------------------- | --------------------------------------------------- |
| `packages/kicad-parser`    | `kicad-sexpr-parser` | S-expression parser and serializer for KiCad files  |
| `packages/ecad-viewer-app` | `ecad-viewer-app`    | The viewer: web components, renderers, viewers, UI  |
| `packages/ecad-renderer`   | `ecad-renderer`      | Draws one library symbol or footprint into a canvas |

## kicad-parser

Tokenizes and parses schematics, boards and drawing sheets into plain objects
(`src/schematic_parser.ts`, `src/board_parser.ts`,
`src/drawing_sheet_parser.ts`), and writes schematics back out
(`src/schematic_serializer.ts`). `ecad-renderer` uses the same parsers for
`.kicad_sym` and `.kicad_mod` files. It reads KiCad 9 and KiCad 10
syntax, including KiCad 10 schematic and board variant records.

The viewer and the renderer bundle the parser from source (the build aliases
`kicad-parser` to `packages/kicad-parser/src`), so a parser change needs only a
viewer rebuild. `npm run build` in this package produces a standalone CommonJS
and ESM build in `dist/` for other consumers.

Tests are Jest (`tests/`). The round-trip suite parses each fixture,
serializes it, and runs `kicad-cli sch erc` on the result; see
[development.md](development.md#testing) for how `kicad-cli` is found.

## ecad-viewer-app

The viewer itself. Main areas under `src/`:

| Path                 | Contents                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `ecad-viewer/`       | The `<ecad-viewer>` and `<ecad-viewer-embedded>` elements, the host API, document comparison and diff, comment overlay, insets |
| `viewers/board/`     | PCB viewer: painters, layers, net labels, measure tool, diff layers                                                            |
| `viewers/schematic/` | Schematic viewer: painters, DNP, hover overlay                                                                                 |
| `viewers/base/`      | Shared viewer, viewport, layer and diff-presentation code                                                                      |
| `graphics/`          | Canvas2D renderer (schematics) and WebGL2 renderer (boards), with view culling and polygon triangulation                       |
| `kicanvas/`          | Project model, parser worker pool, and the panels inherited from KiCanvas                                                      |
| `kicad/`             | Document model built on the parser output                                                                                      |
| `3d-viewer/`         | three.js glTF viewer inherited from upstream (loaded as a separate module)                                                     |
| `kc-ui/`             | UI components                                                                                                                  |

`third_party/` holds the vendored JS earcut, the WebAssembly earcut
([README](../packages/ecad-viewer-app/third_party/earcut-wasm/README.md)) and
KiCad's newstroke font.

Build output goes to `build/`:

- `ecad-viewer.js`: the viewer bundle (ES module).
- `parser.worker.js`: the parser worker the viewer spawns.
- `ecad-renderer.js`: the standalone renderer, built from
  `packages/ecad-renderer`.
- `ecad-viewer-esbuild-meta.json`: esbuild metafile, for bundle-size checks.

`build-all` also produces `3d-viewer.js` and `glyph-full.js` (CJK glyphs), which
the page loads through an import map (see `static/index.html`).

Browser tests live in `test/` and run under `@web/test-runner` in Chrome.

## ecad-renderer

A small bundle that draws a parsed library symbol or footprint into a canvas
the host owns, using the viewer's own painters. Prism uses it to show library
assets without loading the whole viewer. API and gesture options are in its
[README](../packages/ecad-renderer/README.md).

It has no build or test script of its own: the viewer build emits
`ecad-renderer.js`, and its tests run in the viewer's suite
(`test/ecad-renderer.test.ts`). `npm run lint -w packages/ecad-renderer`
type-checks it.

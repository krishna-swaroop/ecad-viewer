# ecad-viewer (KiCAD-Prism fork)

<p>
    English | <a href="README_zh.md">中文</a>
</p>

A browser viewer for KiCad schematics, boards and library assets. This fork is
maintained as the KiCad file viewer for
[KiCAD-Prism](https://github.com/krishna-swaroop/KiCAD-Prism), a self-hosted
design-review platform. It started from
[Huaqiu-Electronics/ecad-viewer](https://github.com/Huaqiu-Electronics/ecad-viewer),
which is itself built on [KiCanvas](https://github.com/theacodes/kicanvas), and
has diverged a long way from both.

What the fork adds on top of upstream, in short:

- Revision comparison: a reference and a comparison revision rendered as one
  scene from a KiCad-shaped `DOCUMENT_DIFF`, with added, removed and modified
  items coloured through the normal painters.
- Host API for an embedding app: comment markers and area comments, cross-probe
  between schematic and board, page navigation, layer visibility, net
  highlighting and per-net routing statistics.
- Insets: pinned magnified views of a pin or pad, chainable, with a 3D mode when
  the host supplies a 3D board.
- PCB measure mode with snapping to pads, vias and tracks.
- KiCad 10 design variants, text variables, DNP on sheets, embedded hyperlinks.
- `ecad-renderer`: a separate bundle that draws a single library symbol or
  footprint into a canvas.
- Load and interaction work: board zone fills triangulated in WebAssembly,
  view culling for large layers, and the removal of a duplicate schematic paint.
  On the largest public board benchmarked (CERN EDA-04903, 56.81 MB) the fork
  opens the PCB in 6.67 s against 33.1 s for upstream and 138.6 s for KiCanvas.

See [docs/performance-and-features.md](docs/performance-and-features.md) for
the measurements and where each one comes from.

## Documentation

| Page                                                                                                                     | Contents                                                                 |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| [docs/packages.md](docs/packages.md)                                                                                     | The packages in this repo and what each one does                         |
| [docs/prism-integration.md](docs/prism-integration.md)                                                                   | How KiCAD-Prism builds and embeds the viewer                             |
| [docs/development.md](docs/development.md)                                                                               | Building, testing, branch model and releases                             |
| [docs/performance-and-features.md](docs/performance-and-features.md)                                                     | Performance and features compared with KiCanvas and upstream ecad-viewer |
| [docs/DOCUMENT_DIFF_REVIEW_ARCHITECTURE.md](docs/DOCUMENT_DIFF_REVIEW_ARCHITECTURE.md)                                   | The document comparison contract                                         |
| [packages/ecad-renderer/README.md](packages/ecad-renderer/README.md)                                                     | Standalone symbol and footprint rendering                                |
| [packages/ecad-viewer-app/third_party/earcut-wasm/README.md](packages/ecad-viewer-app/third_party/earcut-wasm/README.md) | The WebAssembly polygon triangulator                                     |

## Quick start

Node 18 or later.

```bash
git clone https://github.com/krishna-swaroop/ecad-viewer.git
cd ecad-viewer
npm install
npm run serve -w packages/ecad-viewer-app
```

The dev server listens on http://127.0.0.1:8012 (set `ECAD_VIEWER_PORT` to
change it) and serves the demo pages in `packages/ecad-viewer-app/static`.
`http://127.0.0.1:8012/?zip-url=./video.zip` opens the bundled demo project.

## Usage

The bundle registers an `<ecad-viewer>` element. Point it at KiCad files:

```html
<ecad-viewer>
    <ecad-source src="design/design.kicad_pro"></ecad-source>
    <ecad-source src="design/design.kicad_sch"></ecad-source>
    <ecad-source src="design/design.kicad_pcb"></ecad-source>
</ecad-viewer>
<script type="module" src="./ecad_viewer/ecad-viewer.js"></script>
```

`<ecad-viewer-embedded url="a.kicad_sch;b.kicad_sch">` is the lighter embed
inherited from upstream. An app that drives the viewer from script (as Prism
does) uses the public methods on the `ECadViewer` element; see
[docs/prism-integration.md](docs/prism-integration.md).

## Contributing

Open pull requests against `dev`. `main` only moves by merging `dev`. There is
no CI on pull requests, so run the local suites before asking for review; see
[docs/development.md](docs/development.md).

## Credits and licence

This repository is a fork of
[Huaqiu-Electronics/ecad-viewer](https://github.com/Huaqiu-Electronics/ecad-viewer),
by Ethan Chien and the Huaqiu Electronics team, released under the MIT licence
in [LICENSE.md](LICENSE.md) (copyright 2024 深圳华秋电子有限公司). Upstream
ecad-viewer is built on [KiCanvas](https://github.com/theacodes/kicanvas) by
Alethea Katherine Flowers, also MIT; the KiCanvas copyright headers are kept in
the files that carry them. The fork's changes are released under the same
licence.

Other third-party code:

- [three-gltf-viewer](https://github.com/donmccurdy/three-gltf-viewer), MIT
- [mapbox/earcut](https://github.com/mapbox/earcut) and
  [mapbox/earcut.hpp](https://github.com/mapbox/earcut.hpp), ISC, in
  `packages/ecad-viewer-app/third_party/`
- KiCad's newstroke stroke font, in `packages/ecad-viewer-app/third_party/newstroke`
  (see its `README.txt` and `THIRD_PARTY_README.md`)

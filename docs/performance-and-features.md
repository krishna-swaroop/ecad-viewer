# Performance and features compared with KiCanvas and upstream ecad-viewer

Every figure here was measured, and each one names its source: a file in the
KiCon Europe 2026 benchmark material, or a commit in this repo. Figures are
copied as recorded. Where a source does not say which machine was used, this
page says so.

## Cold-open benchmark against KiCanvas and upstream

Source: the KiCon Europe 2026 viewer-load benchmark (`benchmark-viewer-load/`
in the KiCon material: `README.md` for method, `summary.json` for medians,
`results-v4.jsonl` for raw runs). It is not in this repo.

**Builds compared**, each built from source with its own production build and
served from one local origin with caching disabled:

| Viewer               | Source                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------- |
| KiCanvas             | `theacodes/kicanvas` @ main                                                             |
| Upstream ecad-viewer | `Huaqiu-Electronics/ecad-viewer` @ `a2679a1`                                            |
| This fork            | `krishna-swaroop/ecad-viewer` @ `4ee6a34` (`perf/wasm-triangulation`, merged as PR #27) |

**Method**, in short:

- Time to interactive, not first paint: a run ends when the viewer has
  dispatched `kicanvas:load` and the main thread has then gone 750 ms with no
  task over 50 ms.
- Cold start: a new Chrome process per run, no HTTP, module or parse cache.
  3 runs per cell, median reported.
- Schematic runs load the `.kicad_pro` and every `.kicad_sch`; PCB runs load
  the `.kicad_pro` and the board.
- All three viewers measured interleaved in one session (2026-08-31, 303 runs).
  The benchmark README notes that cells drifted by up to 38% between days on
  the same machine, so only ratios within a session are comparable.
- Adjusted in the competitors' favour: KiCanvas's click-to-interact overlay is
  disabled, and off-localhost requests are blocked for all three, so KiCanvas
  is not charged for its Google Fonts fetch.
- Machine: macOS with Google Chrome driven by `puppeteer-core`. The machine
  model and Chrome version are not recorded in the result files.

**Corpus**: public projects from the `kicad_monkey` test corpus
(`tests/corpus/kicad.zip` in
[krishna-swaroop/kicad_monkey](https://github.com/krishna-swaroop/kicad_monkey)),
including CERN's wren-hw board EDA-04903 (`cern_wren_eda_04903`).

### Results (median time to interactive, ms)

The seven-project comparison set from `summary.json` (`summary`), where every
cell opened in all three viewers. Speed-up columns are this fork against each
other viewer, as computed in `summary.json`.

| Project                  | Doc | Size (MB) | This fork | Upstream | KiCanvas | vs upstream | vs KiCanvas |
| ------------------------ | --- | --------: | --------: | -------: | -------: | ----------: | ----------: |
| cern_wren_eda_04903      | pcb |     56.81 |    6674.9 |  33124.2 | 138648.3 |       4.96× |      20.77× |
| cern_wren_eda_04903      | sch |     20.24 |       589 |    675.9 |   1444.4 |       1.15× |       2.45× |
| jumperless_v5r7          | pcb |      26.7 |    2159.9 |   2867.6 |   2920.9 |       1.33× |       1.35× |
| jumperless_v5r7          | sch |      4.13 |     377.3 |   1044.9 |      430 |       2.77× |       1.14× |
| speedy_processing_module | pcb |     16.42 |    1104.9 |   9364.7 |  47038.5 |       8.48× |      42.57× |
| speedy_processing_module | sch |     19.61 |       387 |    456.4 |   1337.1 |       1.18× |       3.46× |
| icepi_sbc                | pcb |      5.61 |     579.2 |   2385.9 |     5137 |       4.12× |       8.87× |
| icepi_sbc                | sch |      2.98 |       150 |    342.3 |      214 |       2.28× |       1.43× |
| cm5_minima_rev2          | pcb |      2.63 |     401.9 |      539 |   1271.4 |       1.34× |       3.16× |
| cm5_minima_rev2          | sch |      0.95 |       122 |    224.2 |    122.5 |       1.84× |          1× |
| taillight                | pcb |      1.72 |     177.1 |    221.4 |    215.3 |       1.25× |       1.22× |
| taillight                | sch |      0.17 |      78.1 |    125.1 |     60.9 |        1.6× |       0.78× |
| led_component            | pcb |      0.05 |      87.1 |     63.9 |     56.1 |       0.73× |       0.64× |
| led_component            | sch |      0.01 |     101.1 |       46 |     35.9 |       0.45× |       0.36× |

Outside the comparison set (`summary.json`, `all`):

- `celebration_led_assembly` schematic (4.28 MB): 231.5 ms for this fork,
  389 ms for upstream, 38318.3 ms for KiCanvas (165.52×).
- `4-ch-backplane` board (26.82 MB): 1269.3 ms for this fork, 6515.8 ms for
  upstream. KiCanvas does not open it: it throws `this.polygons is not iterable`
  and never emits a document (three 10-minute and three 300-second attempts,
  per the benchmark README).

Where the fork is slower: on the smallest designs. The benchmark README puts
this down to the parser worker pool's fixed start-up cost when there is nothing
to parallelise. The largest design the fork loses on is the 2.31 MB
`nrf9151_feather` board (315.7 ms against 282.2 ms for upstream, 0.89×).

### Cost per viewer

From `summary.json` (`app`):

|                                    | This fork | Upstream | KiCanvas |
| ---------------------------------- | --------: | -------: | -------: |
| JS bundle (MB)                     |    0.9778 |   3.5774 |   0.5249 |
| App boot (ms)                      |    109.95 |   142.75 |     87.9 |
| Input to frame (ms)                |     31.45 |     30.5 |     72.9 |
| Peak JS heap on EDA-04903 PCB (MB) |     245.3 |    284.4 |    882.6 |

Heap is not lower across the board: on several mid-size boards the fork holds
more heap than upstream (for example `jumperless_v5r7` PCB, 116.5 MB against
66.2 MB). The benchmark README describes this as buying open time with memory.

## Performance work in the fork

Measured as part of each change and recorded in the commit message or the
file named. Machine and browser are given where the source states them.

### Net labels off the zoom path (PR #39, `fef6f3c`)

Board: EDA-04903-V1-0 (7k pads, 27k tracks, 4.5k vias, 39k label candidates).
Method: 40-step ×1.1 zoom-in from fit, synchronous update cost before the
render frame.

- 40 steps: 2414 ms → 82 ms warm, 194 ms cold.
- Per label rebuild: 60–125 ms → 3–11 ms warm.
- Rebuilds: 40 of 40 ticks → 13 of 40.
- `end_layer` for a label layer: 55–75 ms → 3–5 ms.
- Frame time with labels on matches labels off: p50 8.4 ms, p90 18.5 ms
  against 20.8 ms. Panning the densest area at zoom 25 stays under 11 ms p90.

Machine not stated in the commit.

### Schematic paint fix (PR #26, `bd5caee`)

Opening a sheet painted it twice: once for real and once through a null
renderer just to measure it for zoom-to-fit. The fit now reads the bounds the
real paint recorded. Text drawing was also batched and shaping cached.

KiCon benchmark README ("The schematic paint fix"), `d09118f` against
`bd5caee`, one session, all 19 schematic and 15 board projects in the corpus:

- Schematics: 1.47× median, 14 of 19 projects at least 20% faster, 6.8 s →
  4.0 s summed across the set.
- `jumperless_v5r7`: 1350 ms → 419 ms (3.22×).
- Boards: unchanged (median 0.98×), within the ±9% run-to-run spread.
- Median document load fell 16%; the time from load to interactive fell 82%.

### Hover overlay rebuilt only when the hovered item changes (PR #26, `6f99d1d`)

Canvas draw calls over a 40-step pointer sweep on schematics:

| Project                  | Before |  After |
| ------------------------ | -----: | -----: |
| 4-ch-backplane           |   9307 |      0 |
| speedy_processing_module |   8774 |      0 |
| icepi_sbc                | 267297 |  52157 |
| jumperless_v5r7          | 408575 | 109622 |
| cern_wren_eda_04903      | 825395 | 301976 |

The same PR keeps the Canvas2D and WebGL frame paths from forcing a layout read
every frame (`7856bf4`, `d353668`) and skips redundant Canvas2D state writes
(`536e24f`). Those commits do not record numbers.

### Zone fills triangulated in WebAssembly (PR #27, `7bd17db`, `86de6b2`)

`mapbox/earcut.hpp` compiled to wasm replaces JS earcut for polygon
triangulation, with JS earcut kept as a fallback. Source:
`packages/ecad-viewer-app/third_party/earcut-wasm/README.md`.

On the zone fills of a large board (789 polygons, 702,436 points), Chrome 141,
Apple silicon, median of 5:

- Triangulate and expand to vertices: 1051 ms (JS) → 715 ms (wasm), 1.47×.
- Cold load of the same board, 5 runs each, medians: document load 2944 ms →
  2587 ms (−357 ms, 12.1%); time to interactive 2977 ms → 2622 ms (−355 ms,
  11.9%).

The bundle grew from 915 KB to 952 KB (commit message).

### View culling for large WebGL layers (PR #58, `d22057c`; PR #64, `334c051`)

Large layers are ordered into a coarse grid at commit, and each frame draws
only the vertex ranges that meet the view. No GPU objects are added. Board:
EDA-04903, GPU time from timer queries.

- One inset, 300×220 at 2×: 4.8–5.2 ms per frame off, 2.5–3.2 ms on. The inset
  submits 156k of 6.36M vertices. The fitted main view renders identically on
  and off; load medians 7062 ms against 7171 ms, within run-to-run spread.
- Six insets per frame (PR #64): GPU 16.4 ms median, 25.7 ms max with culling
  off; 9.2 ms median, 15.6 ms max with it on. Main thread 0.8 ms off, 2.9 ms on.

Machine not stated in the commits.

## Features

KiCanvas is the base both viewers share: schematic and board rendering in the
browser. The table lists what upstream ecad-viewer added on top of that, and
what this fork added since. Fork entries cite the pull request in this repo.

| Feature                                                                                                  | Upstream ecad-viewer | This fork                                                                                  |
| -------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------ |
| Schematic and PCB viewers, layers, nets, footprints panels                                               | yes (from KiCanvas)  | yes                                                                                        |
| WebGL2 board renderer, parser worker pool                                                                | yes                  | yes, plus wasm triangulation (#27) and view culling (#58)                                  |
| BOM view                                                                                                 | yes                  | yes                                                                                        |
| 3D board view (three.js, glTF from a kicad-cli server)                                                   | yes                  | yes                                                                                        |
| Altium import through a kicad-cli server                                                                 | yes                  | yes                                                                                        |
| ERC result display through an iframe bridge                                                              | yes                  | yes                                                                                        |
| Load a project from a ZIP                                                                                | yes                  | yes                                                                                        |
| Revision comparison from a KiCad-shaped `DOCUMENT_DIFF`, side by side and old/new                        | no                   | yes (#2, see [DOCUMENT_DIFF_REVIEW_ARCHITECTURE.md](DOCUMENT_DIFF_REVIEW_ARCHITECTURE.md)) |
| Comment mode, comment markers and area comments, anchor resolution reported to the host                  | no                   | yes (#2, #43)                                                                              |
| Host API for an embedding app: source replacement, page state, layer and net control (`host-adapter.ts`) | no                   | yes (#2)                                                                                   |
| Standalone symbol and footprint renderer (`ecad-renderer`), multi-unit symbols                           | no                   | yes (#14, #15, #16)                                                                        |
| Library cross-probing between symbol and footprint                                                       | no                   | yes (#21)                                                                                  |
| Pin hit testing on symbols                                                                               | no                   | yes (#17)                                                                                  |
| Project text variables, including through sheet instances                                                | no                   | yes (#11, #13)                                                                             |
| DNP cross on every symbol and on hierarchical sheets                                                     | no                   | yes (#3)                                                                                   |
| KiCad 9 `body_style` token, KiCad 10 top-level sheet paths                                               | no                   | yes (#4, #5, #68)                                                                          |
| KiCad 10 design variants (schematic and PCB)                                                             | no                   | yes (#29–#36)                                                                              |
| Pad numbers and net names on pads, tracks and vias                                                       | no                   | yes (#37)                                                                                  |
| Per-net routing statistics, multi-net highlight                                                          | no                   | yes (#40, #41, #42)                                                                        |
| Embedded schematic hyperlinks                                                                            | no                   | yes (#44)                                                                                  |
| Insets: pinned magnified views of pins and pads, chained insets, labels at inset zoom                    | no                   | yes (#47–#65)                                                                              |
| 3D view of PCB insets (3D board supplied by the host)                                                    | no                   | yes (#66)                                                                                  |
| PCB measure mode with snapping to pads, vias and tracks                                                  | no                   | yes (#67)                                                                                  |

"Upstream" means `Huaqiu-Electronics/ecad-viewer` as of the commit this fork
last shares with it (`a6456d3`, 2026-07-11). Upstream may have added features
since.

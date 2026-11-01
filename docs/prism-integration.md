# How KiCAD-Prism uses the viewer

[KiCAD-Prism](https://github.com/krishna-swaroop/KiCAD-Prism) does not install
this repo from npm. It builds the bundles from a sibling checkout and commits
the output.

## Build and vendoring

Prism expects this repo checked out next to it as `../ecad-viewer` (override
with `ECAD_VIEWER_DIR`) and runs `./scripts/build-ecad-viewer.sh` from the
Prism root. That script:

- refuses to build unless the commit in Prism's
  `scripts/ecad-viewer-upstream.lock` is an ancestor of the checkout, and
  refuses a dirty source tree unless `ECAD_ALLOW_DIRTY=1` is set;
- writes `frontend/public/ecad-viewer.js`, `parser.worker.js` and
  `ecad-renderer.js`;
- writes `frontend/public/ecad-viewer.manifest.json` with the source commit,
  source-tree digest, artifact digests and the dirty flag;
- updates the digest in the viewer `<script>` tag in `frontend/index.html` and
  the renderer cache key in `frontend/src/lib/ecad-renderer-build.ts`.

So a change here reaches Prism only when someone rebuilds there and commits the
generated files, usually together with a bump of `ecad-viewer-upstream.lock`.
The full procedure is Prism's `.agents/skills/prism-viewer-rebuild/SKILL.md`.

## Runtime

Prism's React frontend creates `<ecad-viewer>` elements and drives them through
public methods on `ECadViewer` (`src/ecad-viewer/ecad_viewer.ts`). The main
groups:

| Area                 | Methods                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sources              | `replaceSources`, `appendSources`                                                                                                                            |
| Pages and navigation | `getSchematicPages`, `showPage`, `switchPage`, `navigateSchematicPage`, `navigateSchematicParent`, `zoomToLocation`                                          |
| Cross-probe          | `requestCrossProbe`, `crossProbe`, `findLabelInstances`, `focusLabelInstance`                                                                                |
| Board state          | `getPcbViewState`, `setPcbLayerVisibility`, `setPcbLayerHighlight`, `setPcbTrackHighlight`, `getHighlightedNets`, `focusHighlightedNets`, `getNetStatistics` |
| Comments             | `setCommentMode`, `setCommentOverlays`, `clearCommentOverlays`                                                                                               |
| Comparison           | `prepareComparison`, `loadDocumentComparison`, `previewDocumentDiff`, `selectDocumentDiff`, `clearDocumentComparison`                                        |
| Variants             | `getVariants`, `getVariant`, `setVariant`                                                                                                                    |
| Tools                | `setMeasureMode`, `setMeasureUnits`, `enableInsets`, `setInsetMode`, `insetProvider`, `setInsetPeer`                                                         |
| Layout               | `setActive`, `resize`, `setViewportInsets`                                                                                                                   |

The comparison contract (what Prism sends, how diffs are drawn) is written up in
[DOCUMENT_DIFF_REVIEW_ARCHITECTURE.md](DOCUMENT_DIFF_REVIEW_ARCHITECTURE.md).

Prism sets `source-mode="host"` and supplies every source itself. A host-mode
viewer ignores bridged ZIPs, and Prism's page carries no
`ecad-viewer-mode` meta tag, so the bundle reads no query-string configuration
and installs no postMessage bridge there (see
[Standalone mode](#standalone-mode)).

### Standalone mode

The demo app (`static/index.html`) opts in with
`<meta name="ecad-viewer-mode" content="standalone">`. Only then does the bundle:

- read `?zip-url=`, `?app=`, `?default-page=`, `?design_urls=` and the rest.
  `?cli-server-addr=` is kept only on the page's own origin and `?ai-url=`
  only when it is https or relative;
- install the iframe bridge. It accepts messages from `window.parent` alone, on
  the page's origin or one listed in
  `<meta name="ecad-viewer-bridge-origins" content="https://a https://b">`, and
  replies only to the origin the parent spoke from.

`ecad-renderer.js` is loaded separately where Prism shows a single library
symbol or footprint (`frontend/src/lib/ecad-renderer.ts` and the workspace's
library asset renderer).

## Things to keep in mind when changing the viewer

- Prism's typed wrapper for the element is `frontend/src/lib/ecad-viewer.ts`.
  Renaming or changing a public method here needs a matching change there.
- The parser is bundled into `ecad-viewer.js`, so parser changes also need the
  viewer rebuild.
- Prism serves the bundle under its own Content Security Policy. The
  WebAssembly triangulator falls back to JS earcut if wasm cannot be
  instantiated (see the
  [earcut-wasm README](../packages/ecad-viewer-app/third_party/earcut-wasm/README.md)).

# Native-shaped document comparison

## Goal

`ecad-viewer` will implement the same rendering boundary as KiCad's native
diff dialog:

1. accept a reference revision, a comparison revision, and a KiCad-shaped
   `DOCUMENT_DIFF`;
2. render one normal comparison document scene;
3. inject reference-side items that were removed;
4. paint unchanged comparison items in neutral monochrome and apply
   Added/Removed/Modified/Conflict status colors through the normal item
   painters;
5. use precomputed bounds and a lightweight retained overlay for selection;
6. never parse, reload, remount, or rebuild the document scene for a warm
   selection.

The generic Graphics API is not part of this contract. Its only supported
public use is comment markers and comment areas. Diff graphics are native item
presentation owned by the comparison renderer.

## Public boundaries

### Comment overlays

Hosts can publish comment identities, anchors, and optional area bounds through
`setCommentOverlays()`. Marker shape, colors, placement, hit testing, and
render-layer policy are viewer-owned. Arbitrary lines, polygons, text, colors,
blend modes, and review decorations are not public.

### KiCad diff JSON

The viewer mirrors:

- `KICAD_DIFF::PROJECT_DIFF`
- `KICAD_DIFF::DOCUMENT_DIFF`
- `KICAD_DIFF::ITEM_CHANGE`
- `KICAD_DIFF::PROPERTY_DELTA`

Native field names and change-kind strings are preserved. Prism adapters must
normalize any independent differ output into this contract before invoking the
viewer.

KiCad bboxes are converted once from document internal units to millimetres:

- schematic: `100 nm/IU`, or `0.0001 mm/IU`;
- PCB: `1 nm/IU`, or `0.000001 mm/IU`.

### Revision sources

The host-facing comparison request will carry complete source sets rather than
one file:

```ts
type EcadDocumentComparisonRequest = {
    comparisonKey: string;
    reference: EcadSourceUpdate;
    comparison: EcadSourceUpdate;
    diff: KiCadDocumentDiff | KiCadProjectDiff;
    documentPath?: string;
    activeSheetPath?: string;
};
```

Both revisions are required because removed geometry does not exist in the
comparison source and native `DOCUMENT_DIFF` JSON contains bounds/properties,
not the complete renderable item.

## Rendering architecture

### Preparation

1. Validate and index the diff.
2. Parse reference and comparison sources concurrently through the shared
   worker pool.
3. Resolve the requested `DOCUMENT_DIFF` to the matching documents.
4. Build source indexes by full hierarchy path and terminal UUID/timestamp.
5. Create one comparison paint model:
    - every comparison item;
    - top-level removed reference items;
    - removed child items only when their parent still exists in comparison.
6. Compile an item-identity to presentation map.
7. Paint once through the normal schematic or board painters.
8. Store exact item/group bounds and page/layer membership.

### Selection

A selection request performs only:

1. O(1) index lookup;
2. cached page activation when required;
3. atomic replacement of the selection overlay;
4. camera assignment from precomputed bounds;
5. one scheduled frame.

The selected row is a Prism concern and updates immediately. A cold sheet may
show a canvas-local preparation indicator; already prepared sheets must not
reparse or repaint.

### Schematic

The comparison sheet instance supplies normal context. Added and modified
comparison items are status-colored. Removed reference items are appended to
the same retained layer graph. Parent symbol status is inherited by pins and
fields. Full hierarchy identity is `projectPath + KIID_PATH`, not filename or
terminal UUID alone.

### PCB

The comparison board supplies normal context and physical layer behavior.
Removed tracks, arcs, vias, zones, drawings, footprints, pads, and footprint
graphics are appended from reference. Status color is resolved per native item
inside the board painters. Existing physical layer visibility remains
authoritative. Routing entries may group by `(kind, net)` while retaining every
member ID and a precomputed union bbox.

## Performance risks and controls

| Risk                                                  | Control                                                                                 |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Two revisions oversubscribe parser workers            | One shared bounded worker pool; start both project loads concurrently                   |
| Parse-cache collision displays the wrong revision     | Full-content deterministic cache key plus parser-build version                          |
| Duplicate full scenes double memory                   | Retain all comparison items but only reference items required for removals              |
| Modified parent causes repeated child styling lookups | Compile direct and inherited status maps once                                           |
| Hierarchical pages repaint on every navigation        | Cache painted page scenes by revision key, full project path, theme, and diff signature |
| Selection walks nested changes                        | Build `EcadDocumentDiffIndex` before first interaction                                  |
| Selection triggers full paint                         | Dedicated selection overlay target; camera changes never mutate presentation            |
| Large zones/tracks block the main thread              | Chunk retained-buffer compilation and record long tasks                                 |
| Stale rapid navigation becomes visible                | Monotonic request IDs; latest-selection-wins                                            |

## Benchmark plan

Instrumentation is local-only behind the existing ECAD performance flag.

Record for each comparison:

- source bytes and file counts per revision;
- worker parse time, model construction time, and cache hits;
- diff validation/indexing time;
- identity resolution time and unresolved IDs;
- comparison-scene compilation time;
- total/removed/colored item counts;
- retained Canvas2D command and WebGL vertex counts;
- scene memory estimate;
- first interactive frame.

Record for each selection:

- click-to-visible-frame;
- change/group index lookup;
- page cache hit;
- overlay replacement time and primitive count;
- camera assignment;
- parser invocation count;
- full-paint count.

Fixture tiers:

1. small: one schematic page and two-layer PCB;
2. medium: hierarchical schematic, four-layer PCB, zones and vias;
3. large: JTYU-OBC-class hierarchy and board;
4. pathological: repeated sheet instances, duplicate IDs, deleted sheets,
   moved footprints, large zones, and thousands of routing changes.

Targets:

- warm same-page selection p95 <= 100 ms;
- warm cached cross-page selection p95 <= 200 ms;
- cold sheet activation p95 <= 1.5 s with no task over 50 ms;
- zero parsing, source replacement, or full document paint on warm selection;
- initial comparison interactivity within 10% of loading one normal comparison
  revision plus unavoidable reference parsing;
- rapid next/previous navigation never displays an older request.

## Prism integration sequence

1. Preserve current Commit and Release views and revision-selection tray.
2. Replace Prism's semantic-composite canvas with one `<ecad-viewer>` in
   document-comparison mode.
3. Normalize Prism's independent semantic differ into KiCad-shaped
   `PROJECT_DIFF`/`DOCUMENT_DIFF`.
4. Keep `kicad-monkey` as the source-identity/design-data provider and
   `kicad-cruncher` as deterministic artifact orchestration/cache tooling.
5. Add a native `kicad-cli diff --format json` provider when KiCad V11 is
   available; both providers feed the same normalization boundary.
6. Remove review presentation, review frame, measurement, and arbitrary diff
   overlay calls from Prism.
7. Retain comparison comments through the comment-only overlay API.
8. Keep BOM and Stackup tabs driven by their typed data services; they do not
   share the graphics path.

## Non-goals for this branch

- old image-overlay, ghost, or split comparison modes;
- public arbitrary graphics primitives;
- formal approvals, assignments, or notifications;
- copying KiCad GPL implementation code into this MIT repository;
- synthesizing a mutable composite KiCad document.

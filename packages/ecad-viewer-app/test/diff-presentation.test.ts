import { expect } from "@esm-bundle/chai";
import { Color } from "../src/base/color";
import {
    buildDocumentDiffIndex,
    type KiCadDocumentDiff,
} from "../src/ecad-viewer/document-diff";
import {
    apply_diff_color,
    build_diff_focus_presentation,
    build_diff_presentation,
    index_paint_items,
    source_id_of,
} from "../src/viewers/base/diff-presentation";
import { Pad } from "../src/kicad/board";
import { fit_adaptive_stroke_width } from "../src/viewers/base/overlay-scene";

class PaintItem {
    constructor(
        public uuid: string,
        private readonly children: PaintItem[] = [],
        public readonly pins: PaintItem[] = [],
    ) {}

    *items(): Generator<PaintItem> {
        yield* this.children;
    }
}

class PaintDocument {
    constructor(private readonly paintItems: PaintItem[]) {}

    *items(): Generator<PaintItem> {
        yield* this.paintItems;
    }
}

function change(
    id: string,
    kind: "added" | "removed" | "modified",
    children: KiCadDocumentDiff["changes"] = [],
): KiCadDocumentDiff["changes"][number] {
    return {
        id,
        typeName: "SCH_SYMBOL",
        kind,
        properties: [],
        bbox: [0, 0, 1000, 1000],
        children,
    };
}

suite("native diff presentation", () => {
    test("indexes nested native paint items", () => {
        const child = new PaintItem("child");
        const parent = new PaintItem("parent", [child]);
        const index = index_paint_items(new PaintDocument([parent]));

        expect(index.get("parent")).to.deep.equal([parent]);
        expect(index.get("child")).to.deep.equal([child]);
    });

    test("indexes identity-only schematic pins omitted by active-unit painting", () => {
        const activePin = new PaintItem("active-pin");
        const inactivePin = new PaintItem("inactive-pin");
        const symbol = new PaintItem(
            "symbol",
            [activePin],
            [activePin, inactivePin],
        );
        const index = index_paint_items(new PaintDocument([symbol, activePin]));

        expect(index.get("active-pin")).to.deep.equal([activePin]);
        expect(index.get("inactive-pin")).to.deep.equal([inactivePin]);
    });

    test("promotes an identity-only schematic pin to its painted symbol", () => {
        const activePin = new PaintItem("active-pin");
        const inactivePin = new PaintItem("inactive-pin");
        const symbol = new PaintItem(
            "symbol",
            [activePin],
            [activePin, inactivePin],
        );
        const document: KiCadDocumentDiff = {
            path: "root.kicad_sch",
            docType: "kicad_sch",
            changes: [
                {
                    ...change("/inactive-pin", "modified"),
                    typeName: "SCH_PIN",
                },
            ],
        };

        const presentation = build_diff_presentation(
            buildDocumentDiffIndex(document),
            new PaintDocument([]),
            new PaintDocument([symbol, activePin]),
        );

        expect(presentation.diagnostics).to.deep.equal([]);
        expect(presentation.statusByItem.get(inactivePin)).to.equal("modified");
        expect(presentation.statusByItem.get(symbol)).to.equal("modified");
        expect(
            presentation.itemsBySideAndSourceId.get("comparison:inactive-pin"),
        ).to.deep.equal([symbol]);
        expect(presentation.resolution.sourceResolved).to.equal(1);
    });

    test("promotes regular nested paint items to their painted owner", () => {
        const pad = new PaintItem("pad");
        const footprint = new PaintItem("footprint", [pad]);
        const document: KiCadDocumentDiff = {
            path: "root.kicad_pcb",
            docType: "kicad_pcb",
            changes: [
                {
                    ...change("/pad", "modified"),
                    typeName: "PCB_PAD",
                },
            ],
        };

        const presentation = build_diff_presentation(
            buildDocumentDiffIndex(document),
            new PaintDocument([]),
            new PaintDocument([footprint]),
        );

        expect(
            presentation.itemsBySideAndSourceId.get("comparison:pad"),
        ).to.deep.equal([footprint]);
    });

    test("colorizes the composite scene so unchanged context subdues", () => {
        // The retained composite scene has to carry the review's meaning on its
        // own, before anything is selected: unchanged geometry subdued, changed
        // geometry in its status hue. Without this the whole page paints at full
        // strength and nothing distinguishes a change from its surroundings.
        const item = new PaintItem("changed");
        const presentation = build_diff_presentation(
            buildDocumentDiffIndex({
                path: "root.kicad_sch",
                docType: "kicad_sch",
                changes: [
                    {
                        ...change("/changed", "modified"),
                        typeName: "SCH_SYMBOL",
                    },
                ],
            }),
            new PaintDocument([]),
            new PaintDocument([item]),
        );

        expect(presentation.colorizeChanges).to.equal(true);
        expect(presentation.statusByItem.get(item)).to.equal("modified");
    });

    test("builds a monochrome focus scene without coloring every change", () => {
        const item = new PaintItem("changed");
        const presentation = build_diff_presentation(
            buildDocumentDiffIndex({
                path: "root.kicad_pcb",
                docType: "kicad_pcb",
                changes: [
                    {
                        ...change("/changed", "modified"),
                        typeName: "PCB_TRACK",
                    },
                ],
            }),
            new PaintDocument([]),
            new PaintDocument([item]),
        );

        const focus = build_diff_focus_presentation(presentation);

        // Same colorize flag as the composite scene it derives from; what makes
        // it a *focus* scene is the empty status map, which subdues changed
        // geometry too and leaves the replayed selection as the only colour.
        expect(focus.colorizeChanges).to.equal(true);
        expect(focus.statusByItem.size).to.equal(0);
        expect(presentation.statusByItem.size).to.be.greaterThan(0);
        expect(focus.itemsBySourceId).to.equal(presentation.itemsBySourceId);
        expect(focus.signature).to.equal(`${presentation.signature}:focus`);
    });

    test("uses modern PCB pad UUIDs instead of an absent legacy tstamp", () => {
        const pad = new Pad(
            {
                uuid: "modern-pad",
                number: "1",
                type: "smd",
                shape: "rect",
                at: {
                    position: { x: 0, y: 0 },
                    rotation: 0,
                    unlocked: false,
                },
                size: { x: 1, y: 1 },
                layers: ["F.Cu"],
            } as never,
            {} as never,
        );

        expect(source_id_of(pad)).to.equal("modern-pad");
    });

    test("styles comparison items and injects removed reference items once", () => {
        const removedChild = new PaintItem("removed-child");
        const removedParent = new PaintItem("removed-parent", [removedChild]);
        const modified = new PaintItem("modified");
        const added = new PaintItem("added");
        const reference = new PaintDocument([removedParent]);
        const comparison = new PaintDocument([modified, added]);
        const document: KiCadDocumentDiff = {
            path: "root.kicad_sch",
            docType: "kicad_sch",
            changes: [
                change("/removed-parent", "removed", [
                    change("/removed-child", "removed"),
                ]),
                change("/modified", "modified"),
                change("/added", "added"),
            ],
        };

        const presentation = build_diff_presentation(
            buildDocumentDiffIndex(document),
            reference,
            comparison,
        );

        expect(presentation.statusByItem.get(removedParent)).to.equal(
            "removed",
        );
        expect(presentation.statusByItem.get(removedChild)).to.equal("removed");
        expect(presentation.statusByItem.get(modified)).to.equal("modified");
        expect(presentation.statusByItem.get(added)).to.equal("added");
        expect(presentation.referenceItems).to.deep.equal([removedParent]);
        expect(presentation.diagnostics).to.deep.equal([]);
    });

    test("reports unresolved source identities without synthesizing geometry", () => {
        const document: KiCadDocumentDiff = {
            path: "root.kicad_sch",
            docType: "kicad_sch",
            changes: [change("/missing", "modified")],
        };

        const presentation = build_diff_presentation(
            buildDocumentDiffIndex(document),
            new PaintDocument([]),
            new PaintDocument([]),
        );

        expect(presentation.referenceItems).to.deep.equal([]);
        expect(presentation.diagnostics).to.deep.equal([
            {
                changeId: "/missing",
                sourceId: "missing",
                side: "comparison",
                reason: "item-not-found",
                typeName: "SCH_SYMBOL",
            },
        ]);
        expect(presentation.resolution.changes).to.equal(1);
        expect(presentation.resolution.sourceResolved).to.equal(0);
    });

    test("reports an ambiguous source id instead of silently taking the first", () => {
        const first = new PaintItem("twin");
        const second = new PaintItem("twin");
        const document: KiCadDocumentDiff = {
            path: "root.kicad_sch",
            docType: "kicad_sch",
            changes: [change("/twin", "modified")],
        };

        const presentation = build_diff_presentation(
            buildDocumentDiffIndex(document),
            new PaintDocument([]),
            new PaintDocument([first, second]),
        );

        expect(presentation.diagnostics).to.deep.equal([
            {
                changeId: "/twin",
                sourceId: "twin",
                side: "comparison",
                reason: "source-id-ambiguous",
                matchCount: 2,
                typeName: "SCH_SYMBOL",
            },
        ]);
        // Selection behaviour is unchanged for this measurement pass.
        expect(presentation.itemsBySourceId.get("twin")).to.deep.equal([first]);
        expect(presentation.resolution.ambiguousSourceIds).to.equal(1);
    });

    test("reports a second change that overwrites an existing side target", () => {
        const item = new PaintItem("shared");
        const document: KiCadDocumentDiff = {
            path: "root.kicad_sch",
            docType: "kicad_sch",
            changes: [
                change("/shared", "modified"),
                change("/shared", "added"),
            ],
        };

        const presentation = build_diff_presentation(
            buildDocumentDiffIndex(document),
            new PaintDocument([]),
            new PaintDocument([item]),
        );

        expect(
            presentation.diagnostics.map((entry) => entry.reason),
        ).to.deep.equal(["duplicate-change-target"]);
        expect(presentation.resolution.duplicateChangeTargets).to.equal(1);
        expect(presentation.resolution.sourceResolved).to.equal(2);
    });

    test("paints a reference-sourced modified item as modified", () => {
        const oldInstance = new PaintItem("old-instance");
        const document: KiCadDocumentDiff = {
            path: "root.kicad_sch",
            docType: "kicad_sch",
            changes: [
                {
                    ...change("/old-instance", "modified"),
                    sourceSide: "reference",
                },
            ],
        };
        const presentation = build_diff_presentation(
            buildDocumentDiffIndex(document),
            new PaintDocument([oldInstance]),
            new PaintDocument([]),
        );

        expect(presentation.statusByItem.get(oldInstance)).to.equal("modified");
        expect(presentation.referenceItems).to.deep.equal([oldInstance]);
        expect(presentation.diagnostics).to.deep.equal([]);
    });

    test("promotes a nested retained item to an owning-symbol halo", () => {
        const nestedLabel = new PaintItem("nested-label");
        const owningSymbol = new PaintItem("owner", [nestedLabel]);
        const document: KiCadDocumentDiff = {
            path: "root.kicad_sch",
            docType: "kicad_sch",
            changes: [
                {
                    ...change("/nested-label", "removed"),
                    typeName: "SCH_LABEL",
                    sourceSide: "reference",
                    retainReference: true,
                },
            ],
        };

        const presentation = build_diff_presentation(
            buildDocumentDiffIndex(document),
            new PaintDocument([owningSymbol]),
            new PaintDocument([]),
        );

        expect(presentation.statusByItem.get(nestedLabel)).to.equal("removed");
        expect(presentation.statusByItem.get(owningSymbol)).to.equal("removed");
        expect(presentation.referenceItems).to.deep.equal([owningSymbol]);
        expect(
            presentation.itemsBySideAndSourceId.get("reference:nested-label"),
        ).to.deep.equal([owningSymbol]);
        expect(presentation.diagnostics).to.deep.equal([]);
    });

    test("retains the owner when a dependent child is also document-level", () => {
        const pin = new PaintItem("pin");
        const owningSymbol = new PaintItem("owner", [pin]);
        const document: KiCadDocumentDiff = {
            path: "root.kicad_sch",
            docType: "kicad_sch",
            changes: [
                {
                    ...change("/pin", "removed"),
                    typeName: "SCH_PIN",
                    sourceSide: "reference",
                    retainReference: true,
                },
            ],
        };

        const presentation = build_diff_presentation(
            buildDocumentDiffIndex(document),
            // KiCad schematics yield PinInstance from both
            // SchematicSymbol.items() and KicadSch.items().
            new PaintDocument([owningSymbol, pin]),
            new PaintDocument([]),
        );

        expect(presentation.referenceItems).to.deep.equal([owningSymbol]);
        expect(presentation.statusByItem.get(owningSymbol)).to.equal("removed");
        expect(
            presentation.itemsBySideAndSourceId.get("reference:pin"),
        ).to.deep.equal([owningSymbol]);
    });

    test("promotes a nested symbol identity to its top-level paint root", () => {
        const nestedSymbol = new PaintItem("nested-symbol");
        const owningSymbol = new PaintItem("owner", [nestedSymbol]);
        const document: KiCadDocumentDiff = {
            path: "root.kicad_sch",
            docType: "kicad_sch",
            changes: [
                {
                    ...change("/nested-symbol", "removed"),
                    sourceSide: "reference",
                    retainReference: true,
                },
            ],
        };

        const presentation = build_diff_presentation(
            buildDocumentDiffIndex(document),
            new PaintDocument([owningSymbol]),
            new PaintDocument([]),
        );

        expect(presentation.referenceItems).to.deep.equal([owningSymbol]);
        expect(presentation.statusByItem.get(owningSymbol)).to.equal("removed");
    });

    test("keeps same-UUID reference and comparison targets side-specific", () => {
        const oldInstance = new PaintItem("shared-id");
        const newInstance = new PaintItem("shared-id");
        const root = {
            ...change("/shared-id", "modified"),
            sourceSide: "comparison" as const,
            children: [
                {
                    ...change("/shared-id", "modified"),
                    sourceSide: "reference" as const,
                    retainReference: true,
                },
            ],
        };
        const presentation = build_diff_presentation(
            buildDocumentDiffIndex({
                path: "root.kicad_sch",
                docType: "kicad_sch",
                changes: [root],
            }),
            new PaintDocument([oldInstance]),
            new PaintDocument([newInstance]),
        );

        expect(
            presentation.itemsBySideAndSourceId.get("reference:shared-id"),
        ).to.deep.equal([oldInstance]);
        expect(
            presentation.itemsBySideAndSourceId.get("comparison:shared-id"),
        ).to.deep.equal([newInstance]);
    });

    test("renders unchanged context as subdued monochrome", () => {
        const copper = Color.from_css("rgba(200, 50, 40, 1)");
        const darkContext = apply_diff_color(
            copper,
            "unchanged",
            Color.from_css("#001023"),
        );
        const lightContext = apply_diff_color(
            copper,
            "unchanged",
            Color.from_css("#ffffff"),
        );

        const darkRange =
            Math.max(darkContext.r, darkContext.g, darkContext.b) -
            Math.min(darkContext.r, darkContext.g, darkContext.b);
        const lightRange =
            Math.max(lightContext.r, lightContext.g, lightContext.b) -
            Math.min(lightContext.r, lightContext.g, lightContext.b);
        expect(darkRange).to.be.lessThan(0.001);
        expect(lightRange).to.be.lessThan(0.001);
        expect(darkContext.a).to.be.closeTo(0.76, 0.001);
        expect(lightContext.a).to.be.closeTo(0.76, 0.001);
        expect(darkContext.r).to.not.equal(lightContext.r);
    });

    test("keeps changed geometry chromatic against monochrome context", () => {
        // This contrast is the whole composite reading: on one page, painted
        // with one background, changed geometry has to carry colour where
        // unchanged geometry has none. Asserted together so a future tweak to
        // either branch cannot quietly collapse the gap.
        const background = Color.from_css("#001023");
        const source = Color.from_css("rgba(200, 50, 40, 1)");
        const chroma = (color: ReturnType<typeof apply_diff_color>) =>
            Math.max(color.r, color.g, color.b) -
            Math.min(color.r, color.g, color.b);

        const unchanged = apply_diff_color(source, "unchanged", background);
        for (const status of ["added", "removed", "modified"] as const) {
            const changed = apply_diff_color(source, status, background);
            expect(chroma(changed)).to.be.greaterThan(chroma(unchanged) + 0.1);
            expect(changed.a).to.be.greaterThan(unchanged.a);
        }
    });

    test("tints A/R/M toward status colors while retaining some source identity", () => {
        const source = Color.from_css("rgba(10, 20, 30, 0.4)");
        const added = apply_diff_color(source, "added");
        const removed = apply_diff_color(source, "removed");
        const modified = apply_diff_color(source, "modified");

        // Not a full RGB replace of the status palette alone.
        expect(added.to_css()).to.not.equal("rgba(51, 153, 77, 0.4)");
        expect(removed.to_css()).to.not.equal("rgba(204, 51, 51, 0.4)");
        expect(modified.to_css()).to.not.equal("rgba(217, 166, 25, 0.4)");
        // Bias toward status: green/red/amber channels dominate.
        expect(added.g).to.be.greaterThan(added.r);
        expect(removed.r).to.be.greaterThan(removed.g);
        expect(modified.r).to.be.greaterThan(modified.b);
        expect(added.a).to.be.at.least(0.72);
    });

    test("leaves drawing-sheet paper white under unchanged remapping", () => {
        // Paper is bypassed in DocumentPainter; apply_diff_color would otherwise
        // mute geometry against paper. Assert muted copper ≠ pure white.
        const paper = Color.white;
        const muted = apply_diff_color(
            Color.from_css("rgb(200, 50, 40)"),
            "unchanged",
            Color.from_css("rgb(194, 194, 194)"),
        );
        expect(paper.r).to.equal(1);
        expect(paper.g).to.equal(1);
        expect(paper.b).to.equal(1);
        expect(muted.r).to.not.equal(paper.r);
        expect(muted.r).to.be.closeTo(muted.g, 0.001);
        expect(muted.g).to.be.closeTo(muted.b, 0.001);
    });

    test("boosts animated routing at fit and preserves close-zoom width", () => {
        expect(fit_adaptive_stroke_width(3, 1, 1)).to.equal(5);
        expect(fit_adaptive_stroke_width(3, 2, 1)).to.equal(4);
        expect(fit_adaptive_stroke_width(3, 3, 1)).to.equal(3);
        expect(fit_adaptive_stroke_width(3, 6, 1)).to.equal(3);
    });
});

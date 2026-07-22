import { expect } from "@esm-bundle/chai";
import { Color } from "../src/base/color";
import {
    buildDocumentDiffIndex,
    type KiCadDocumentDiff,
} from "../src/ecad-viewer/document-diff";
import {
    apply_diff_color,
    build_diff_presentation,
    index_paint_items,
} from "../src/viewers/base/diff-presentation";
import { fit_adaptive_stroke_width } from "../src/viewers/base/overlay-scene";

class PaintItem {
    constructor(
        public uuid: string,
        private readonly children: PaintItem[] = [],
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
            },
        ]);
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

    test("softly desaturates unchanged colors while preserving source hue", () => {
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

        const sourceRange =
            Math.max(copper.r, copper.g, copper.b) -
            Math.min(copper.r, copper.g, copper.b);
        const darkRange =
            Math.max(darkContext.r, darkContext.g, darkContext.b) -
            Math.min(darkContext.r, darkContext.g, darkContext.b);
        const lightRange =
            Math.max(lightContext.r, lightContext.g, lightContext.b) -
            Math.min(lightContext.r, lightContext.g, lightContext.b);
        expect(darkRange).to.be.greaterThan(0.001);
        expect(lightRange).to.be.greaterThan(0.001);
        expect(darkRange).to.be.lessThan(sourceRange);
        expect(lightRange).to.be.lessThan(sourceRange);
        expect(darkContext.a).to.be.closeTo(0.76, 0.001);
        expect(lightContext.a).to.be.closeTo(0.76, 0.001);
        expect(darkContext.r).to.not.equal(lightContext.r);
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
        expect(muted.r).to.be.greaterThan(muted.g);
        expect(muted.g).to.be.greaterThan(muted.b);
    });

    test("boosts animated routing at fit and preserves close-zoom width", () => {
        expect(fit_adaptive_stroke_width(3, 1, 1)).to.equal(5);
        expect(fit_adaptive_stroke_width(3, 2, 1)).to.equal(4);
        expect(fit_adaptive_stroke_width(3, 3, 1)).to.equal(3);
        expect(fit_adaptive_stroke_width(3, 6, 1)).to.equal(3);
    });
});

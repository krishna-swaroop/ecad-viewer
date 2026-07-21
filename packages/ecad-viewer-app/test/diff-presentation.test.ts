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
        expect(presentation.removedItems).to.deep.equal([removedParent]);
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

        expect(presentation.removedItems).to.deep.equal([]);
        expect(presentation.diagnostics).to.deep.equal([
            {
                changeId: "/missing",
                sourceId: "missing",
                side: "comparison",
                reason: "item-not-found",
            },
        ]);
    });

    test("uses fixed A/R/M colors and contrasting monochrome context", () => {
        const source = Color.from_css("rgba(10, 20, 30, 0.4)");
        const added = apply_diff_color(source, "added");
        const removed = apply_diff_color(source, "removed");
        const modified = apply_diff_color(source, "modified");
        const darkContext = apply_diff_color(
            source,
            "unchanged",
            Color.from_css("#001023"),
        );
        const lightContext = apply_diff_color(
            source,
            "unchanged",
            Color.from_css("#ffffff"),
        );

        expect(added.to_css()).to.equal("rgba(51, 153, 77, 0.4)");
        expect(removed.to_css()).to.equal("rgba(204, 51, 51, 0.4)");
        expect(modified.to_css()).to.equal("rgba(217, 166, 25, 0.4)");
        expect(darkContext.r).to.be.greaterThan(0.5);
        expect(lightContext.r).to.be.lessThan(0.5);
        expect(darkContext.r).to.equal(darkContext.g);
        expect(darkContext.g).to.equal(darkContext.b);
        expect(lightContext.r).to.equal(lightContext.g);
        expect(lightContext.g).to.equal(lightContext.b);
        expect(darkContext.a).to.equal(0.4);
        expect(lightContext.a).to.equal(0.4);
    });

    test("leaves drawing-sheet paper white under unchanged remapping", () => {
        // Paper is bypassed in DocumentPainter; apply_diff_color would otherwise
        // collapse Color.white onto the same neutral as geometry. Assert the
        // intended contrast target: muted gray must not equal pure white.
        const paper = Color.white;
        const muted = apply_diff_color(
            Color.from_css("rgb(0, 0, 0)"),
            "unchanged",
            Color.from_css("rgb(194, 194, 194)"),
        );
        expect(paper.r).to.equal(1);
        expect(paper.g).to.equal(1);
        expect(paper.b).to.equal(1);
        expect(muted.r).to.be.lessThan(0.5);
        expect(muted.r).to.not.equal(paper.r);
    });
});

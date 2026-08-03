import { expect } from "@esm-bundle/chai";
import {
    diff_selection_copper_layers,
    type BoardDiffSelectionEntry,
} from "../src/viewers/board/diff-layers";

function entry(item: object): BoardDiffSelectionEntry {
    return { item, status: "modified", routing: true };
}

suite("board diff layer focus", () => {
    test("uses every copper layer carrying selected route segments", () => {
        const layers = diff_selection_copper_layers([
            entry({ typeId: "LineSegment", layer: "F.Cu" }),
            entry({ typeId: "LineSegment", layer: "In2.Cu" }),
            entry({ typeId: "ArcSegment", layer: "B.Cu" }),
            entry({ typeId: "Via", layers: ["F.Cu", "B.Cu"] }),
        ]);

        expect([...layers]).to.have.members(["F.Cu", "In2.Cu", "B.Cu"]);
    });

    test("does not expose untouched inner layers merely crossed by a through via", () => {
        const layers = diff_selection_copper_layers([
            entry({ typeId: "LineSegment", layer: "F.Cu" }),
            entry({ typeId: "LineSegment", layer: "B.Cu" }),
            entry({ typeId: "Via", layers: ["F.Cu", "B.Cu"] }),
        ]);

        expect([...layers]).to.have.members(["F.Cu", "B.Cu"]);
        expect(layers.has("In1.Cu")).to.equal(false);
    });

    test("uses via endpoints when the selected change has no track geometry", () => {
        const layers = diff_selection_copper_layers([
            entry({ typeId: "Via", layers: ["In1.Cu", "B.Cu"] }),
        ]);

        expect([...layers]).to.have.members(["In1.Cu", "B.Cu"]);
    });
});

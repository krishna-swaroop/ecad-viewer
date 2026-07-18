import { expect } from "@esm-bundle/chai";
import {
    prepareComparisonDocument,
    selectComparisonDocument,
} from "../src/ecad-viewer/document-comparison";
import type {
    KiCadDocumentDiff,
    KiCadItemChange,
} from "../src/ecad-viewer/document-diff";

function change(
    id: string,
    kind: KiCadItemChange["kind"],
    bbox: [number, number, number, number],
    refdes?: string,
): KiCadItemChange {
    return {
        id,
        typeName: "SCH_SYMBOL",
        kind,
        properties: [],
        bbox,
        refdes,
        children: [],
    };
}

const schematic: KiCadDocumentDiff = {
    path: "hardware/root.kicad_sch",
    docType: "kicad_sch",
    changes: [
        change("/root/symbol-a", "added", [0, 0, 10_000, 20_000], "U1"),
        change(
            "/root/symbol-b",
            "modified",
            [10_000, 20_000, 30_000, 40_000],
            "U2",
        ),
    ],
};

suite("document comparison preparation", () => {
    test("requires an explicit path for a multi-document PROJECT_DIFF", () => {
        expect(() =>
            selectComparisonDocument({
                documents: [
                    schematic,
                    {
                        ...schematic,
                        path: "hardware/board.kicad_pcb",
                        docType: "kicad_pcb",
                    },
                ],
            }),
        ).to.throw("documentPath is required");
    });

    test("resolves a document by normalized suffix", () => {
        const selected = selectComparisonDocument(
            { documents: [schematic] },
            "root.kicad_sch",
        );
        expect(selected.path).to.equal("hardware/root.kicad_sch");
    });

    test("precomputes O(1) member and group targets in world units", () => {
        const prepared = prepareComparisonDocument(schematic);
        const member = prepared.targets.get("change:/root/symbol-a");
        const group = prepared.targets.get("group:/root/symbol-a");

        expect(prepared.context).to.equal("SCH");
        expect(member).to.deep.include({
            id: "/root/symbol-a",
            kind: "change",
            category: "added",
            sourceIds: ["symbol-a"],
            bounds: [0, 0, 1, 2],
        });
        expect(group).to.deep.include({
            id: "/root/symbol-a",
            kind: "group",
            category: "added",
            sourceIds: ["symbol-a"],
            bounds: [0, 0, 1, 2],
        });
    });
});

import { expect } from "@esm-bundle/chai";
import {
    bbox_to_world,
    buildDocumentDiffIndex,
    parseKiCadDocumentDiff,
    parseKiCadProjectDiff,
    split_kiid_path,
    type KiCadDocumentDiff,
    type KiCadItemChange,
} from "../src/ecad-viewer/document-diff";

const value = (v: unknown) => ({ type: "string", v });

function change(
    id: string,
    typeName: string,
    kind: KiCadItemChange["kind"],
    bbox: [number, number, number, number],
    refdes?: string,
): KiCadItemChange {
    return {
        id,
        typeName,
        kind,
        bbox,
        refdes,
        properties: [
            {
                name: "Value",
                before: value("old"),
                after: value("new"),
            },
        ],
        children: [],
    };
}

suite("KiCad DOCUMENT_DIFF contract", () => {
    test("validates native field names and nested changes", () => {
        const native = {
            path: "main.kicad_sch",
            docType: "kicad_sch",
            changes: [
                {
                    ...change(
                        "/sheet-uuid/symbol-uuid",
                        "SCH_SYMBOL",
                        "modified",
                        [10000, 20000, 30000, 40000],
                        "U1",
                    ),
                    children: [
                        change(
                            "/sheet-uuid/symbol-uuid/pin-uuid",
                            "SCH_PIN",
                            "modified",
                            [10000, 20000, 1000, 1000],
                        ),
                    ],
                },
            ],
        };

        const parsed = parseKiCadDocumentDiff(native);
        expect(parsed.path).to.equal("main.kicad_sch");
        expect(parsed.changes[0]?.children[0]?.typeName).to.equal("SCH_PIN");
        expect(parsed.changes[0]?.properties[0]?.before.v).to.equal("old");
    });

    test("validates PROJECT_DIFF documents", () => {
        const project = parseKiCadProjectDiff({
            documents: [
                {
                    path: "main.kicad_pcb",
                    docType: "kicad_pcb",
                    changes: [],
                },
            ],
        });
        expect(project.documents).to.have.length(1);
    });

    test("rejects unknown change kinds before painting", () => {
        expect(() =>
            parseKiCadDocumentDiff({
                path: "main.kicad_sch",
                docType: "kicad_sch",
                changes: [
                    {
                        ...change("/item", "SCH_SYMBOL", "added", [0, 0, 1, 1]),
                        kind: "changed",
                    },
                ],
            }),
        ).to.throw("not a KiCad change kind");
    });

    test("converts KiCad internal units to viewer millimetres", () => {
        const schematic = bbox_to_world(
            [10000, 20000, 30000, 40000],
            "schematic-iu",
        );
        expect([
            schematic.x,
            schematic.y,
            schematic.w,
            schematic.h,
        ]).to.deep.equal([1, 2, 3, 4]);

        const pcb = bbox_to_world(
            [1000000, 2000000, 3000000, 4000000],
            "pcb-iu",
        );
        expect([pcb.x, pcb.y, pcb.w, pcb.h]).to.deep.equal([1, 2, 3, 4]);
    });

    test("preserves hierarchy identity and precomputes routing groups", () => {
        const document: KiCadDocumentDiff = {
            path: "main.kicad_pcb",
            docType: "kicad_pcb",
            changes: [
                change(
                    "/track-a",
                    "PCB_TRACK",
                    "added",
                    [0, 0, 1000000, 1000000],
                    "GND",
                ),
                change(
                    "/track-b",
                    "PCB_VIA",
                    "added",
                    [2000000, 2000000, 1000000, 1000000],
                    "GND",
                ),
                change(
                    "/footprint/pad",
                    "PAD",
                    "modified",
                    [5000000, 5000000, 1000000, 1000000],
                    "U1",
                ),
            ],
        };

        const index = buildDocumentDiffIndex(document);
        expect(index.bySourceId.get("pad")).to.have.length(1);
        expect(split_kiid_path("/footprint/pad")).to.deep.equal([
            "footprint",
            "pad",
        ]);

        const group = index.groups.find((candidate) =>
            candidate.id.startsWith("net:"),
        );
        expect(group?.members).to.have.length(2);
        expect([
            group?.worldBounds.x,
            group?.worldBounds.y,
            group?.worldBounds.w,
            group?.worldBounds.h,
        ]).to.deep.equal([0, 0, 3, 3]);
    });
});

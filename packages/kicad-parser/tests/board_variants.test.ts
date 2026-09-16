/**
 * VAR-03 — board variant header, footprint variant records and the base
 * `attr dnp` flag (KiCad 10). Fixtures: tests/fixtures/design-variants.
 *
 * There is no board serializer in this package (only the schematic has one),
 * so there is no board round-trip test; that is a documented absence, not an
 * omission.
 */
import * as fs from "fs";
import * as path from "path";

import { BoardParser } from "../src/board_parser";
import type * as B from "../src/proto/board";

const root = path.resolve(__dirname, "fixtures", "design-variants");
const parser = new BoardParser();
const identity = JSON.parse(fs.readFileSync(path.join(root, "expected", "oracle.json"), "utf8")).identity.footprints;

function load(relative: string): B.I_KicadPCB {
    return parser.parse(fs.readFileSync(path.join(root, relative), "utf8"));
}

function byUuid(pcb: B.I_KicadPCB, uuid: string): B.I_Footprint {
    const found = pcb.footprints.find((fp) => fp.uuid === uuid);
    if (!found) throw new Error(`no footprint ${uuid}`);
    return found;
}

function uuidOf(reference: string, pkg: string): string {
    const entry = Object.entries<any>(identity).find(([, meta]) => meta.reference === reference && meta.package === pkg);
    if (!entry) throw new Error(`no identity for ${reference} ${pkg}`);
    return entry[0];
}

describe("board variant header", () => {
    test("names and descriptions in file order", () => {
        const pcb = load("oracle/variants_oracle.kicad_pcb");
        expect(pcb.variants).toEqual([
            { name: "Lite", description: "Cost-reduced build" },
            { name: "Pro" },
            { name: "BoardOnly" },
        ]);
    });

    test("a board without the header has no variants key", () => {
        expect(load("no_variants/plain.kicad_pcb").variants).toBeUndefined();
    });
});

describe("footprint variant records", () => {
    const pcb = load("oracle/variants_oracle.kicad_pcb");

    test("explicit true, explicit false, omitted, and a no-op record", () => {
        expect(byUuid(pcb, uuidOf("R1", "R_0603_1608Metric")).variants).toEqual([
            { name: "Lite", dnp: true, fields: [] },
            { name: "Pro", dnp: false, fields: [] },
        ]);
        const r3 = byUuid(pcb, uuidOf("R3", "R_0603_1608Metric")).variants![0]!;
        expect(r3).toEqual({ name: "Lite", exclude_from_bom: true, exclude_from_pos_files: true, fields: [] });
        expect("dnp" in r3).toBe(false);
    });

    test("base attr dnp is read and kept apart from the records", () => {
        const r2 = byUuid(pcb, uuidOf("R2", "R_0603_1608Metric"));
        expect(r2.attr.dnp).toBe(true);
        expect(r2.attr.smd).toBe(true);
        expect(r2.variants).toEqual([{ name: "Lite", dnp: false, fields: [] }]);
        expect(byUuid(pcb, uuidOf("R1", "R_0603_1608Metric")).attr.dnp).toBeUndefined();
    });

    test("duplicate references stay separate footprints keyed by uuid", () => {
        const base = byUuid(pcb, uuidOf("Q1", "SOT-23"));
        const alternate = byUuid(pcb, uuidOf("Q1", "SOT-89-3"));
        expect(base.attr.dnp).toBeUndefined();
        expect(base.variants).toEqual([{ name: "Lite", dnp: true, fields: [] }]);
        expect(alternate.attr.dnp).toBe(true);
        expect(alternate.variants).toEqual([{ name: "Lite", dnp: false, fields: [] }]);
        expect(pcb.footprints.filter((fp) => fp.properties_kicad_8.some((p) => p.name === "Reference" && p.value === "Q1")).length).toBe(2);
    });

    test("field overrides: empty, escaped and non-ASCII values", () => {
        const c1 = byUuid(pcb, uuidOf("C1", "C_0603_1608Metric")).variants!;
        expect(c1.map((v) => v.name)).toEqual(["Lite", "Pro", "Édition-µ"]);
        expect(c1[0]!.fields).toEqual([
            { name: "Value", value: "100nF" },
            { name: "MPN", value: "X-LITE" },
        ]);
        expect(c1[1]!.fields).toEqual([{ name: "MPN", value: "" }]);
        expect(c1[2]!.fields).toEqual([
            { name: "Value", value: "4.7µF" },
            { name: "Note", value: 'She said "bye"' },
        ]);
    });

    test("a footprint-only variant name and a footprint without records", () => {
        expect(byUuid(pcb, uuidOf("J9", "PinHeader_1x02_P2.54mm_Vertical")).variants).toEqual([{ name: "PcbOnly", dnp: true, fields: [] }]);
        expect(load("no_variants/plain.kicad_pcb").footprints[0]!.variants).toBeUndefined();
    });

    test("names are kept as written; case folding is the resolver's job", () => {
        const pcb2 = load("case_fold/casefold.kicad_pcb");
        expect(pcb2.variants).toEqual([{ name: "lite" }]);
        expect(pcb2.footprints.map((fp) => fp.variants![0]!.name)).toEqual(["LITE", "lite"]);
    });

    test("a bare (dnp) token means true, as KiCad's parseMaybeAbsentBool does", () => {
        const text = fs
            .readFileSync(path.join(root, "no_variants/plain.kicad_pcb"), "utf8")
            .replace("(embedded_fonts no)\n(model", '(variant (name "Bare") (dnp) (exclude_from_bom no))\n(embedded_fonts no)\n(model');
        expect(text).toContain('(name "Bare")');
        expect(parser.parse(text).footprints[0]!.variants).toEqual([{ name: "Bare", dnp: true, exclude_from_bom: false, fields: [] }]);
    });

    test("KiCad 11 exclude_from_sim inside a record is ignored, the rest survives", () => {
        const pcb3 = load("kicad11_tokens/k11.kicad_pcb");
        expect(pcb3.footprints[0]!.variants).toEqual([{ name: "Lite", dnp: true, fields: [] }]);
    });
});

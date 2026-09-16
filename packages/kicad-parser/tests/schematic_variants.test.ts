/**
 * VAR-02 — symbol and sheet instance variant records (KiCad 10).
 *
 * Fixtures come from the shared oracle set (tests/fixtures/design-variants);
 * the identities below are the ones listed in expected/oracle.json.
 */
import * as fs from "fs";
import * as path from "path";

import { SchematicParser } from "../src/schematic_parser";
import type * as S from "../src/proto/schematic";

const root = path.resolve(__dirname, "fixtures", "design-variants");
const parser = new SchematicParser();

function load(relative: string): S.I_KicadSch {
    return parser.parse(fs.readFileSync(path.join(root, relative), "utf8"));
}

function symbolByReference(schematic: S.I_KicadSch, reference: string, unit = 1): S.I_SchematicSymbol {
    const found = (schematic.symbols ?? []).find(
        (symbol) =>
            symbol.unit === unit &&
            symbol.instances.projects.some((project) => project.paths.some((p) => p.reference === reference)),
    );
    if (!found) throw new Error(`no symbol ${reference} unit ${unit}`);
    return found;
}

function records(symbol: S.I_SchematicSymbol, reference: string): S.I_SchematicVariant[] {
    for (const project of symbol.instances.projects) {
        for (const p of project.paths) {
            if (p.reference === reference) return p.variants ?? [];
        }
    }
    throw new Error(`no instance ${reference}`);
}

function record(symbol: S.I_SchematicSymbol, reference: string, name: string): S.I_SchematicVariant {
    const found = records(symbol, reference).find((v) => v.name === name);
    if (!found) throw new Error(`no record ${name} on ${reference}`);
    return found;
}

describe("symbol instance variant records", () => {
    const sch = load("oracle/variants_oracle.kicad_sch");

    test("explicit true, explicit false and absent tokens are kept apart", () => {
        expect(record(symbolByReference(sch, "R1"), "R1", "Lite")).toEqual({ name: "Lite", dnp: true, fields: [] });
        expect(record(symbolByReference(sch, "R2"), "R2", "Lite")).toEqual({ name: "Lite", dnp: false, fields: [] });
        const r3 = record(symbolByReference(sch, "R3"), "R3", "Lite");
        expect(r3).toEqual({ name: "Lite", in_bom: false, in_pos_files: false, fields: [] });
        expect("dnp" in r3).toBe(false);
    });

    test("a record equal to base and a fields-only record survive verbatim", () => {
        const r4 = symbolByReference(sch, "R4");
        expect(records(r4, "R4")).toEqual([
            { name: "Lite", fields: [{ name: "MPN", value: "R4-LITE" }] },
            { name: "Pro", dnp: false, fields: [] },
        ]);
    });

    test("empty, escaped and non-ASCII field values", () => {
        const c1 = symbolByReference(sch, "C1");
        expect(record(c1, "C1", "Lite").fields).toEqual([
            { name: "Value", value: "100nF" },
            { name: "MPN", value: "X-LITE" },
        ]);
        expect(record(c1, "C1", "Pro").fields).toEqual([{ name: "MPN", value: "" }]);
        expect(record(c1, "C1", "Édition-µ").fields).toEqual([
            { name: "Value", value: "4.7µF" },
            { name: "Note", value: 'She said "bye"' },
        ]);
    });

    test("records are per instance path: the same symbol carries different records on different sheets", () => {
        const channel = load("oracle/channel.kicad_sch");
        const symbol = channel.symbols![0]!;
        const paths = symbol.instances.projects[0]!.paths;
        expect(paths.map((p) => p.reference)).toEqual(["R7", "R8"]);
        expect(paths[0]!.variants).toEqual([{ name: "Lite", fields: [{ name: "MPN", value: "A-LITE" }] }]);
        expect(paths[1]!.variants).toBeUndefined();
    });

    test("each unit of a multi-unit symbol keeps its own records", () => {
        expect(records(symbolByReference(sch, "U1", 1), "U1").map((v) => v.name)).toEqual(["Lite", "Pro"]);
        expect(records(symbolByReference(sch, "U1", 2), "U1").map((v) => v.name)).toEqual(["Lite"]);
    });

    test("the base in_pos_files token is read", () => {
        expect(symbolByReference(sch, "R1").in_pos_files).toBe(true);
    });

    test("a symbol without records has no variants key", () => {
        const plain = load("no_variants/plain.kicad_sch");
        expect(plain.symbols![0]!.instances.projects[0]!.paths[0]!.variants).toBeUndefined();
    });
});

describe("sheet instance variant records", () => {
    const sch = load("oracle/variants_oracle.kicad_sch");
    const sheetNamed = (name: string) =>
        sch.sheets!.find((sheet) => sheet.properties.some((p) => p.name === "Sheetname" && p.text === name))!;

    test("dnp and in_bom records on a sheet instance", () => {
        const wireless = sheetNamed("Wireless").instances.projects[0]!.paths[0]!;
        expect(wireless.variants).toEqual([
            { name: "Lite", dnp: true, fields: [] },
            { name: "Pro", in_bom: false, fields: [] },
        ]);
    });

    test("two instances of one sheet file are distinct sheet symbols with their own records", () => {
        expect(sheetNamed("CH_A").instances.projects[0]!.paths[0]!.variants).toBeUndefined();
        expect(sheetNamed("CH_B").instances.projects[0]!.paths[0]!.variants).toEqual([{ name: "Lite", dnp: true, fields: [] }]);
    });
});

describe("round trip", () => {
    const sources = [
        "oracle/variants_oracle.kicad_sch",
        "oracle/wireless.kicad_sch",
        "oracle/channel.kicad_sch",
        "legacy_in_bom/legacy.kicad_sch",
        "case_fold/casefold.kicad_sch",
    ];

    test.each(sources)("%s keeps every variant record through parse → save → parse", (relative) => {
        const first = load(relative);
        const saved = parser.save(first);
        const second = parser.parse(saved);
        const collect = (schematic: S.I_KicadSch) => {
            const out: Array<[string, S.I_SchematicVariant[] | undefined]> = [];
            for (const symbol of schematic.symbols ?? []) {
                for (const project of symbol.instances.projects) {
                    for (const p of project.paths) out.push([`symbol:${symbol.uuid}:${p.path}`, p.variants]);
                }
            }
            for (const sheet of schematic.sheets ?? []) {
                for (const project of sheet.instances.projects) {
                    for (const p of project.paths) out.push([`sheet:${sheet.uuid}:${p.path}`, p.variants]);
                }
            }
            return out;
        };
        expect(collect(second)).toEqual(collect(first));
        expect(collect(first).some(([, variants]) => variants && variants.length > 0)).toBe(true);
        expect(parser.save(second)).toBe(saved);
        // The serializer writes exactly the file's tokens: an absent token never becomes `(dnp no)`.
        expect((saved.match(/\(variant\n/g) ?? []).length).toBe(collect(first).reduce((n, [, v]) => n + (v?.length ?? 0), 0));
    });

    test("the serialized form is what KiCad's own writer produces", () => {
        const sch = load("oracle/variants_oracle.kicad_sch");
        const saved = parser.save(sch);
        expect(saved).toContain('(variant\n\t\t\t\t\t\t(name "Lite")\n\t\t\t\t\t\t(in_bom no)\n\t\t\t\t\t\t(in_pos_files no)\n\t\t\t\t\t)');
        expect(saved).toContain('(field\n\t\t\t\t\t\t\t(name "MPN")\n\t\t\t\t\t\t\t(value "")\n\t\t\t\t\t\t)');
        expect(saved).toContain('(value "She said \\"bye\\"")');
    });
});

describe("tolerance", () => {
    test("KiCad 11 symbol_override / pin_map_override tokens are ignored, the supported tokens survive", () => {
        const sch = load("kicad11_tokens/k11.kicad_sch");
        const symbol = sch.symbols![0]!;
        expect(records(symbol, "R1")).toEqual([{ name: "Lite", dnp: true, fields: [] }]);
        expect(parser.save(sch)).not.toContain("symbol_override");
    });

    test("pre-release files keep the raw in_bom token; inversion is the resolver's job", () => {
        const sch = load("legacy_in_bom/legacy.kicad_sch");
        expect(sch.version).toBe(20260101);
        expect(record(symbolByReference(sch, "R10"), "R10", "Lite")).toEqual({ name: "Lite", in_bom: true, fields: [] });
        expect(record(symbolByReference(sch, "R11"), "R11", "Lite")).toEqual({ name: "Lite", in_bom: false, fields: [] });
    });
});

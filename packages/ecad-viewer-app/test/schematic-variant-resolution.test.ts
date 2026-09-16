/**
 * VAR-04 — schematic effective-state resolution against the shared oracle
 * fixtures (packages/kicad-parser/tests/fixtures/design-variants).
 *
 * expected/oracle.json is the hand-computed, natively verified state from
 * the contract packet; every occurrence flag it lists is checked here through
 * the page contexts of a loaded project, so the sheet fold, per-path records,
 * per-unit records and field overrides are exercised on real hierarchy.
 */
import { expect } from "@esm-bundle/chai";
import { SchematicParser } from "kicad-parser";

import { ProjectSettings } from "../src/kicad/project-settings";
import { KicadSch, SchematicInstanceContext } from "../src/kicad/schematic";
import {
    VariantRecord,
    fold_sheet_flags,
    resolve_field_text,
    resolve_sheet_flags,
    resolve_symbol_flags,
} from "../src/kicad/variant-resolution";
import { Project } from "../src/kicanvas/project";

const FIXTURES = "/kicad-parser/tests/fixtures/design-variants";

/**
 * The test server's esbuild plugin turns every fixture file it serves into an
 * ES module (a string default export for KiCad sources, an object for JSON),
 * so the fixtures are imported rather than fetched.
 */
async function asset(path: string): Promise<unknown> {
    const module = await import(/* @vite-ignore */ `${FIXTURES}/${path}`);
    return module.default;
}

async function text(path: string): Promise<string> {
    const content = await asset(path);
    if (typeof content !== "string")
        throw new Error(`${path} did not load as text`);
    return content;
}

async function json_of(path: string): Promise<unknown> {
    // `.json` is served as JSON (not importable as a module); `.kicad_pro`
    // is rewritten into a module whose default export is the parsed object.
    const response = await fetch(`${FIXTURES}/${path}`);
    const raw = await response.text();
    try {
        return JSON.parse(raw);
    } catch {
        const content = await asset(path);
        return typeof content === "string" ? JSON.parse(content) : content;
    }
}

/**
 * Build a project on the main thread (no parser worker in the test runner):
 * parse each schematic, register the documents and settings, and let the
 * project derive its page tree exactly as `load()` does afterwards.
 */
async function load_fixture(
    directory: string,
    files: string[],
): Promise<Project> {
    const parser = new SchematicParser();
    const project = new Project();
    const documents: Array<[string, KicadSch]> = [];
    for (const filename of files) {
        if (filename.endsWith(".kicad_pro")) {
            project._project_name = filename.replace(/\.kicad_pro$/, "");
            project.settings = ProjectSettings.load(
                await json_of(`${directory}/${filename}`),
            );
            continue;
        }
        const document = new KicadSch(
            filename,
            parser.parse(await text(`${directory}/${filename}`)),
        );
        document.project = project;
        documents.push([filename, document]);
    }
    project._files_by_name = new Map(documents);
    project._sch = documents.map(([, document]) => document);
    project._determine_schematic_hierarchy();
    return project;
}

type Expected = {
    identity: {
        occurrences: Record<
            string,
            {
                reference: string;
                symbolUuid: string;
                sheetInstancePath: string;
                unit: number;
            }
        >;
    };
    default: { occurrences: Record<string, Record<string, unknown>> };
    variants: Array<{
        name: string;
        occurrences: Record<string, Record<string, unknown>>;
    }>;
};

const FLAG_KEYS = {
    dnp: "dnp",
    excludeFromBom: "exclude_from_bom",
    excludeFromBoard: "exclude_from_board",
    excludeFromSim: "exclude_from_sim",
    excludeFromPosFiles: "exclude_from_pos_files",
} as const;

/** Effective flag from the differential maps (packet 2.7). */
function expected_flag(
    expected: Expected,
    variant: string | null,
    occurrence: string,
    flag: keyof typeof FLAG_KEYS,
): boolean {
    const base = expected.default.occurrences[occurrence]?.[flag] === true;
    if (variant === null) return base;
    const override = expected.variants.find((v) => v.name === variant)!
        .occurrences[occurrence]?.[flag];
    return typeof override === "boolean" ? override : base;
}

suite("schematic variant resolution — pure rules", () => {
    const base = {
        dnp: false,
        in_bom: true,
        on_board: true,
        exclude_from_sim: false,
        in_pos_files: true,
    };

    test("absent tokens inherit base, present tokens replace it", () => {
        const record = new VariantRecord({ name: "A", dnp: true, fields: [] });
        const flags = resolve_symbol_flags(base, record, 20260306);
        expect(flags).to.deep.equal({
            dnp: true,
            exclude_from_bom: false,
            exclude_from_board: false,
            exclude_from_sim: false,
            exclude_from_pos_files: false,
        });
        expect(
            resolve_symbol_flags({ ...base, dnp: true }, undefined, 20260306)
                .dnp,
        ).to.equal(true);
        expect(
            resolve_symbol_flags(
                { ...base, dnp: true },
                new VariantRecord({ name: "A", dnp: false, fields: [] }),
                20260306,
            ).dnp,
        ).to.equal(false);
    });

    test("in_bom is positive from 20260306 and the excluded flag before (packet N3)", () => {
        const record = new VariantRecord({
            name: "A",
            in_bom: true,
            fields: [],
        });
        expect(
            resolve_symbol_flags(base, record, 20260306).exclude_from_bom,
        ).to.equal(false);
        expect(
            resolve_symbol_flags(base, record, 20260101).exclude_from_bom,
        ).to.equal(true);
        expect(
            resolve_symbol_flags(base, record, undefined).exclude_from_bom,
        ).to.equal(false);
        expect(
            resolve_sheet_flags(
                {
                    dnp: false,
                    in_bom: true,
                    on_board: true,
                    exclude_from_sim: false,
                },
                record,
                20260101,
            ).exclude_from_bom,
        ).to.equal(true);
    });

    test("the sheet fold ORs everything except position-file exclusion", () => {
        const own = resolve_symbol_flags(base, undefined, 20260306);
        const folded = fold_sheet_flags(own, [
            {
                dnp: true,
                exclude_from_bom: false,
                exclude_from_board: false,
                exclude_from_sim: false,
            },
            {
                dnp: false,
                exclude_from_bom: true,
                exclude_from_board: false,
                exclude_from_sim: false,
            },
        ]);
        expect(folded).to.deep.equal({
            dnp: true,
            exclude_from_bom: true,
            exclude_from_board: false,
            exclude_from_sim: false,
            exclude_from_pos_files: false,
        });
        expect(own.dnp).to.equal(false, "fold returns a copy");
    });

    test("field overrides replace by name, empty included, never Reference", () => {
        const record = new VariantRecord({
            name: "A",
            fields: [
                { name: "MPN", value: "" },
                { name: "Reference", value: "X9" },
            ],
        });
        expect(resolve_field_text(record, "MPN", "base")).to.equal("");
        expect(resolve_field_text(record, "Value", "base")).to.equal("base");
        expect(resolve_field_text(record, "Reference", "R1")).to.equal("R1");
        expect(resolve_field_text(undefined, "MPN", undefined)).to.equal(
            undefined,
        );
    });
});

suite("schematic variant resolution — oracle fixture", () => {
    let project: Project;
    let expected: Expected;

    suiteSetup(async () => {
        project = await load_fixture("oracle", [
            "variants_oracle.kicad_pro",
            "variants_oracle.kicad_sch",
            "wireless.kicad_sch",
            "antenna.kicad_sch",
            "channel.kicad_sch",
        ]);
        expected = (await json_of("expected/oracle.json")) as Expected;
    });

    /** Context + symbol for one expected occurrence id. */
    function occurrence(id: string): {
        context: SchematicInstanceContext;
        symbol: ReturnType<KicadSch["symbols"]["get"]>;
    } {
        const meta = expected.identity.occurrences[id]!;
        const page = project.pages.find(
            (p) => p.sheet_path === meta.sheetInstancePath,
        );
        if (!page) throw new Error(`no page for ${meta.sheetInstancePath}`);
        const context = page.schematic_context!;
        const symbol = (context.document as KicadSch).symbols.get(
            meta.symbolUuid,
        );
        if (!symbol) throw new Error(`no symbol ${meta.symbolUuid}`);
        return { context, symbol };
    }

    test("the project builds the five-page hierarchy including the repeated sheet", () => {
        const paths = new Set(project.pages.map((p) => p.sheet_path));
        for (const meta of Object.values(expected.identity.occurrences)) {
            expect(
                paths.has(meta.sheetInstancePath),
                meta.sheetInstancePath,
            ).to.equal(true);
        }
        expect(project.pages.length).to.equal(5);
    });

    for (const variant of [
        null,
        "Lite",
        "Pro",
        "Unused",
        "Édition-µ",
        "BoardOnly",
        "PcbOnly",
        "Nope",
    ]) {
        test(`every occurrence flag matches expected/oracle.json under ${variant ?? "default"}`, () => {
            const known = expected.variants.some((v) => v.name === variant);
            const effective_name = variant !== null && known ? variant : null;
            for (const id of Object.keys(expected.identity.occurrences)) {
                const { context, symbol } = occurrence(id);
                context.variant = variant;
                const flags = context.effective_flags(symbol!);
                for (const [expected_key, actual_key] of Object.entries(
                    FLAG_KEYS,
                )) {
                    expect(
                        flags[actual_key],
                        `${id} ${variant} ${expected_key}`,
                    ).to.equal(
                        expected_flag(
                            expected,
                            effective_name,
                            id,
                            expected_key as keyof typeof FLAG_KEYS,
                        ),
                    );
                }
            }
        });
    }

    test("field overrides reach property_text, value and footprint; Reference never changes", () => {
        const c1 = Object.entries(expected.identity.occurrences).find(
            ([, m]) => m.reference === "C1",
        )![0];
        const { context, symbol } = occurrence(c1);
        context.variant = null;
        expect(context.value(symbol!)).to.equal("1uF");
        expect(context.property_text(symbol!, "MPN")).to.equal("X-1");
        context.variant = "Lite";
        expect(context.value(symbol!)).to.equal("100nF");
        expect(context.property_text(symbol!, "Value")).to.equal("100nF");
        expect(context.property_text(symbol!, "MPN")).to.equal("X-LITE");
        expect(context.property_text(symbol!, "Note")).to.equal('He said "hi"');
        context.variant = "Pro";
        expect(context.property_text(symbol!, "MPN")).to.equal("");
        expect(context.value(symbol!)).to.equal("1uF");
        context.variant = "Édition-µ";
        expect(context.value(symbol!)).to.equal("4.7µF");
        expect(context.property_text(symbol!, "Note")).to.equal(
            'She said "bye"',
        );
        expect(context.reference(symbol!)).to.equal("C1");

        const q1 = Object.entries(expected.identity.occurrences).find(
            ([, m]) => m.reference === "Q1",
        )![0];
        const q = occurrence(q1);
        q.context.variant = "Lite";
        expect(q.context.footprint(q.symbol!)).to.equal(
            "Package_TO_SOT_SMD:SOT-89-3",
        );
        expect(
            q.context.resolve_symbol_text_var(q.symbol!, "FOOTPRINT_NAME"),
        ).to.equal("SOT-89-3");
        q.context.variant = null;
        expect(q.context.footprint(q.symbol!)).to.equal(
            "Package_TO_SOT_SMD:SOT-23",
        );
    });

    test("records are looked up by this page's instance path (R7 vs R8 share one symbol)", () => {
        const [r7] = Object.entries(expected.identity.occurrences).find(
            ([, m]) => m.reference === "R7",
        )!;
        const [r8] = Object.entries(expected.identity.occurrences).find(
            ([, m]) => m.reference === "R8",
        )!;
        const a = occurrence(r7);
        const b = occurrence(r8);
        expect(a.symbol).to.equal(b.symbol);
        a.context.variant = "Lite";
        b.context.variant = "Lite";
        expect(a.context.property_text(a.symbol!, "MPN")).to.equal("A-LITE");
        expect(b.context.property_text(b.symbol!, "MPN")).to.equal("CH-BASE");
        expect(a.context.dnp(a.symbol!)).to.equal(false);
        expect(b.context.dnp(b.symbol!)).to.equal(
            true,
            "CH_B's sheet record folds onto R8",
        );
    });

    test("an explicit (dnp no) under a DNP sheet is still DNP (OR fold, R12)", () => {
        const [r12] = Object.entries(expected.identity.occurrences).find(
            ([, m]) => m.reference === "R12",
        )!;
        const { context, symbol } = occurrence(r12);
        context.variant = "Lite";
        expect(context.variant_record(symbol!)!.dnp).to.equal(false);
        expect(context.dnp(symbol!)).to.equal(true);
        expect(context.resolve_symbol_text_var(symbol!, "DNP")).to.equal("DNP");
    });

    test("sheet symbols report their own effective flags folded with their ancestors", () => {
        const root = project.root_schematic_page!.schematic_context!;
        const wireless = (root.document as KicadSch).sheets.find(
            (s) => s.sheetname === "Wireless",
        )!;
        root.variant = null;
        expect(root.sheet_dnp(wireless)).to.equal(false);
        root.variant = "Lite";
        expect(root.sheet_dnp(wireless)).to.equal(true);
        root.variant = "Pro";
        expect(root.sheet_flags(wireless)).to.deep.equal({
            dnp: false,
            exclude_from_bom: true,
            exclude_from_board: false,
            exclude_from_sim: false,
        });
        const wireless_page = project.pages.find(
            (p) => p.name === "Wireless",
        )!.schematic_context!;
        const antenna = (wireless_page.document as KicadSch).sheets.find(
            (s) => s.sheetname === "Antenna",
        )!;
        wireless_page.variant = "Lite";
        expect(wireless_page.sheet_dnp(antenna)).to.equal(
            true,
            "inherits from Wireless",
        );
    });

    test("switching A → B → default never mutates the parsed symbols", () => {
        const before = new Map<string, string>();
        for (const page of project.pages) {
            for (const symbol of (page.document as KicadSch).symbols.values()) {
                before.set(
                    `${page.sheet_path}/${symbol.uuid}`,
                    JSON.stringify([
                        symbol.dnp,
                        symbol.in_bom,
                        symbol.on_board,
                        symbol.exclude_from_sim,
                        symbol.in_pos_files,
                        symbol.get_property_text("Value"),
                        symbol.get_property_text("MPN"),
                    ]),
                );
            }
        }
        for (const variant of ["Lite", "Pro", null, "Édition-µ", null]) {
            for (const page of project.pages) {
                const context = page.schematic_context!;
                context.variant = variant;
                for (const symbol of (
                    context.document as KicadSch
                ).symbols.values()) {
                    context.effective_flags(symbol);
                    context.value(symbol);
                    context.property_text(symbol, "MPN");
                }
            }
        }
        for (const page of project.pages) {
            for (const symbol of (page.document as KicadSch).symbols.values()) {
                expect(
                    JSON.stringify([
                        symbol.dnp,
                        symbol.in_bom,
                        symbol.on_board,
                        symbol.exclude_from_sim,
                        symbol.in_pos_files,
                        symbol.get_property_text("Value"),
                        symbol.get_property_text("MPN"),
                    ]),
                ).to.equal(before.get(`${page.sheet_path}/${symbol.uuid}`));
            }
        }
    });

    test("${VARIANT} and ${VARIANT_DESC} resolve through the context", () => {
        const root = project.root_schematic_page!.schematic_context!;
        root.variant = null;
        expect(root.resolve_text_var("VARIANT")).to.equal("");
        expect(root.resolve_text_var("VARIANT_DESC")).to.equal("");
        root.variant = "Lite";
        expect(root.resolve_text_var("VARIANT")).to.equal("Lite");
        expect(root.resolve_text_var("VARIANTNAME")).to.equal("Lite");
        // The project's variant catalogue arrives with VAR-05; until then the
        // description is empty rather than invented.
        expect(root.resolve_text_var("VARIANT_DESC")).to.equal("");
    });

    test("a context without a project resolves the default design", () => {
        const document = new KicadSch("lonely.kicad_sch", {
            uuid: "lonely",
            symbols: [],
        } as never);
        const context = new SchematicInstanceContext(document, "/lonely");
        expect(context.active_variant).to.equal(null);
        expect(context.ancestor_sheet_flags()).to.deep.equal([]);
    });
});

suite("schematic variant resolution — legacy in_bom fixture", () => {
    test("(version 20260101) inverts the in_bom token, as KiCad reads it", async () => {
        const project = await load_fixture("legacy_in_bom", [
            "legacy.kicad_pro",
            "legacy.kicad_sch",
        ]);
        const expected = (await json_of(
            "expected/legacy_in_bom.json",
        )) as Expected;
        const context = project.root_schematic_page!.schematic_context!;
        expect((context.document as KicadSch).version).to.equal(20260101);
        for (const [id, meta] of Object.entries(
            expected.identity.occurrences,
        )) {
            const symbol = (context.document as KicadSch).symbols.get(
                meta.symbolUuid ?? id.split("/").at(-1)!,
            )!;
            context.variant = null;
            expect(
                context.excluded_from_bom(symbol),
                `${meta.reference} default`,
            ).to.equal(expected_flag(expected, null, id, "excludeFromBom"));
            context.variant = "Lite";
            expect(
                context.excluded_from_bom(symbol),
                `${meta.reference} Lite`,
            ).to.equal(expected_flag(expected, "Lite", id, "excludeFromBom"));
        }
    });
});

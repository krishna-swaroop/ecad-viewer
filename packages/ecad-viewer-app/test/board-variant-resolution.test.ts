/**
 * VAR-06 — board footprint effective-state resolution against the shared
 * oracle fixtures (packages/kicad-parser/tests/fixtures/design-variants).
 *
 * expected/oracle.json holds the hand-computed, natively verified state from
 * the contract packet; every footprint flag and field it lists is checked here
 * through a loaded KicadPCB, so per-token fallback, case-insensitive record
 * lookup, explicit false, empty fields, duplicate references and the
 * board-header registry are exercised on real files.
 */
import { expect } from "@esm-bundle/chai";
import { BoardParser } from "kicad-parser";

import { KicadPCB } from "../src/kicad";
import {
    DEFAULT_VARIANT_PLACEHOLDER,
    FootprintVariantRecord,
    find_footprint_variant,
    normalize_variant_name,
    resolve_footprint_field_text,
    resolve_footprint_flags,
} from "../src/kicad/board-variant-resolution";
import themes from "../src/kicanvas/themes";
import {
    DNP_HATCH_OPACITY,
    LayerNames,
    LayerSet,
} from "../src/viewers/board/layers";
import { FootprintPainter } from "../src/viewers/board/footprint-painter";
import { BoardViewer } from "../src/viewers/board/viewer";

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
    const response = await fetch(`${FIXTURES}/${path}`);
    const raw = await response.text();
    return JSON.parse(raw);
}

async function board_fixture(directory: string, filename: string) {
    return new KicadPCB(
        filename,
        new BoardParser().parse(
            await text(`${directory}/${filename}`),
        ) as never,
    );
}

type Expected = {
    identity: {
        footprints: Record<string, { reference: string; package: string }>;
    };
    catalog: Array<{
        name: string;
        description: string | null;
        sources: string[];
    }>;
    default: { footprints: Record<string, Record<string, unknown>> };
    variants: Array<{
        name: string;
        footprints: Record<string, Record<string, unknown>>;
    }>;
};

const FLAG_KEYS = {
    dnp: "dnp",
    excludeFromBom: "exclude_from_bom",
    excludeFromPosFiles: "exclude_from_pos_files",
} as const;

/** Effective flag from the differential maps (packet 2.7). */
function expected_flag(
    expected: Expected,
    variant: string | null,
    uuid: string,
    flag: keyof typeof FLAG_KEYS,
): boolean {
    const base = expected.default.footprints[uuid]?.[flag] === true;
    if (variant === null) return base;
    const override = expected.variants.find((v) => v.name === variant)!
        .footprints[uuid]?.[flag];
    return typeof override === "boolean" ? override : base;
}

suite("board variant resolution — pure rules", () => {
    const base = {
        dnp: false,
        exclude_from_bom: false,
        exclude_from_pos_files: false,
    };

    test("absent tokens inherit base, present tokens replace it", () => {
        const record = new FootprintVariantRecord({
            name: "A",
            dnp: true,
            fields: [],
        });
        expect(resolve_footprint_flags(base, record)).to.deep.equal({
            dnp: true,
            exclude_from_bom: false,
            exclude_from_pos_files: false,
        });
        expect(
            resolve_footprint_flags(
                { ...base, dnp: true, exclude_from_bom: true },
                new FootprintVariantRecord({
                    name: "A",
                    dnp: false,
                    fields: [],
                }),
            ),
        ).to.deep.equal({
            dnp: false,
            exclude_from_bom: true,
            exclude_from_pos_files: false,
        });
        expect(resolve_footprint_flags(base, undefined)).to.deep.equal(base);
    });

    test("record lookup is case-insensitive and first-match in file order (N16/N17)", () => {
        const records = FootprintVariantRecord.from_list([
            { name: "Lite", dnp: true, fields: [] },
            { name: "lite", exclude_from_bom: true, fields: [] },
        ]);
        for (const name of ["Lite", "lite", "LITE"]) {
            expect(find_footprint_variant(records, name)?.name, name).to.equal(
                "Lite",
            );
        }
        expect(find_footprint_variant(records, "Pro")).to.equal(undefined);
        expect(find_footprint_variant(records, null)).to.equal(undefined);
    });

    test("empty, sentinel and unknown names all resolve the base (N17/N18)", () => {
        expect(normalize_variant_name("")).to.equal(null);
        expect(normalize_variant_name(null)).to.equal(null);
        expect(normalize_variant_name(DEFAULT_VARIANT_PLACEHOLDER)).to.equal(
            null,
        );
        expect(
            normalize_variant_name(DEFAULT_VARIANT_PLACEHOLDER.toLowerCase()),
        ).to.equal(null);
        expect(normalize_variant_name("Lite")).to.equal("Lite");
        const flags = resolve_footprint_flags(
            { ...base, dnp: true },
            find_footprint_variant(
                FootprintVariantRecord.from_list([
                    { name: "Lite", dnp: false, fields: [] },
                ]),
                "< Default >",
            ),
        );
        expect(flags.dnp).to.equal(true);
    });

    test("field overrides replace by exact name, empty included", () => {
        const record = new FootprintVariantRecord({
            name: "A",
            fields: [
                { name: "MPN", value: "" },
                { name: "mpn", value: "lower" },
            ],
        });
        expect(resolve_footprint_field_text(record, "MPN", "base")).to.equal(
            "",
        );
        expect(resolve_footprint_field_text(record, "Value", "base")).to.equal(
            "base",
        );
        expect(resolve_footprint_field_text(record, "mpn", "base")).to.equal(
            "lower",
        );
        expect(
            resolve_footprint_field_text(undefined, "MPN", undefined),
        ).to.equal(undefined);
    });
});

suite("board variant resolution — oracle fixture", () => {
    let board: KicadPCB;
    let expected: Expected;

    suiteSetup(async () => {
        board = await board_fixture("oracle", "variants_oracle.kicad_pcb");
        expected = (await json_of("expected/oracle.json")) as Expected;
    });

    test("the board header registry arrives in file order with descriptions", () => {
        expect(board.variants.map((v) => v.name)).to.deep.equal([
            "Lite",
            "Pro",
            "BoardOnly",
        ]);
        expect(board.variants[0]!.description).to.equal("Cost-reduced build");
        expect(board.variants[1]!.description).to.equal(undefined);
    });

    test("every footprint is identified by uuid with its base package", () => {
        for (const [uuid, meta] of Object.entries(
            expected.identity.footprints,
        )) {
            const footprint = board.find_footprint(uuid);
            expect(footprint, uuid).to.not.equal(null);
            expect(footprint!.uuid).to.equal(uuid);
            expect(footprint!.reference, uuid).to.equal(meta.reference);
        }
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
        test(`every footprint flag matches expected/oracle.json under ${variant ?? "default"}`, () => {
            const known = expected.variants.some((v) => v.name === variant);
            const effective_name = variant !== null && known ? variant : null;
            for (const uuid of Object.keys(expected.identity.footprints)) {
                const footprint = board.find_footprint(uuid)!;
                const flags = footprint.effective_flags(variant);
                for (const [expected_key, actual_key] of Object.entries(
                    FLAG_KEYS,
                )) {
                    expect(
                        flags[actual_key],
                        `${uuid} ${variant} ${expected_key}`,
                    ).to.equal(
                        expected_flag(
                            expected,
                            effective_name,
                            uuid,
                            expected_key as keyof typeof FLAG_KEYS,
                        ),
                    );
                }
            }
        });
    }

    test("field overrides reach effective property text; baseline values stay without one", () => {
        const c1 = board.find_footprint(
            "78868d5e-e525-51b9-adcc-94b26de45321",
        )!;
        expect(c1.effective_value(null)).to.equal("1uF");
        expect(c1.property_text("MPN", null)).to.equal("X-1");
        expect(c1.property_text("Note", null)).to.equal('He said "hi"');
        expect(c1.effective_value("Lite")).to.equal("100nF");
        expect(c1.property_text("MPN", "Lite")).to.equal("X-LITE");
        expect(c1.property_text("Note", "Lite")).to.equal('He said "hi"');
        expect(c1.property_text("MPN", "Pro")).to.equal("");
        expect(c1.effective_value("Pro")).to.equal("1uF");
        expect(c1.effective_value("Édition-µ")).to.equal("4.7µF");
        expect(c1.property_text("Note", "Édition-µ")).to.equal(
            'She said "bye"',
        );

        const r4 = board.find_footprint(
            "3557800a-6a99-56d7-bd1f-6b1cf8abec66",
        )!;
        expect(r4.property_text("MPN", null)).to.equal("R4-BASE");
        expect(r4.property_text("MPN", "Lite")).to.equal("R4-LITE");

        const [q1_sot23, q1_sot89] = [
            board.find_footprint("5a220ef8-f143-59ec-941e-de3da0b7105e")!,
            board.find_footprint("8bdd2fcb-5aff-5a3a-a6e2-96f479a3fb83")!,
        ];
        expect(q1_sot23.effective_value(null)).to.equal("BC847");
        expect(q1_sot89.effective_value(null)).to.equal("BCX56");
        expect(q1_sot23.effective_value("Lite")).to.equal("BC847");
        expect(q1_sot89.effective_value("Lite")).to.equal("BCX56");
    });

    test("alternate footprints with one reference resolve independently by uuid", () => {
        const sot23 = board.find_footprint(
            "5a220ef8-f143-59ec-941e-de3da0b7105e",
        )!;
        const sot89 = board.find_footprint(
            "8bdd2fcb-5aff-5a3a-a6e2-96f479a3fb83",
        )!;
        expect(sot23.reference).to.equal("Q1");
        expect(sot89.reference).to.equal("Q1");
        expect([
            sot23.effective_dnp(null),
            sot89.effective_dnp(null),
        ]).to.deep.equal([false, true]);
        expect([
            sot23.effective_dnp("Lite"),
            sot89.effective_dnp("Lite"),
        ]).to.deep.equal([true, false]);
    });

    test("effective properties merge overrides without touching Reference or Value", () => {
        const c1 = board.find_footprint(
            "78868d5e-e525-51b9-adcc-94b26de45321",
        )!;
        const before = JSON.stringify({
            properties: c1.properties,
            properties_kicad_8: c1.properties_kicad_8.map((property) => [
                property.name,
                property.value,
            ]),
            value: c1.value,
            reference: c1.reference,
        });
        const base_properties = {
            Datasheet: "",
            Description: "",
            MPN: "X-1",
            Note: 'He said "hi"',
        };
        expect(c1.effective_properties(null)).to.deep.equal(base_properties);
        expect(c1.effective_properties("Lite")).to.deep.equal({
            ...base_properties,
            MPN: "X-LITE",
        });
        expect(c1.effective_properties("Lite")).to.not.have.property("Value");
        expect(c1.effective_properties("Lite")).to.not.have.property(
            "Reference",
        );
        expect(c1.effective_properties("Pro").MPN).to.equal("");
        expect(
            JSON.stringify({
                properties: c1.properties,
                properties_kicad_8: c1.properties_kicad_8.map((property) => [
                    property.name,
                    property.value,
                ]),
                value: c1.value,
                reference: c1.reference,
            }),
        ).to.equal(before, "resolution never mutates the parsed footprint");
    });

    test("the DNP hatch is a separate, non-interactive layer that never replaces item layers", () => {
        const layers = new LayerSet(board, themes.default.board);
        const dnp_layer = layers.by_name(LayerNames.dnp)!;
        expect(dnp_layer).to.not.equal(undefined);
        expect(dnp_layer.interactive).to.equal(false);
        expect(dnp_layer.opacity).to.equal(DNP_HATCH_OPACITY);
        expect(
            [...layers.in_ui_order()].map((layer) => layer.name),
        ).to.not.contain(LayerNames.dnp);
        // Display order paints back-to-front; the hatch must come after the
        // copper and silkscreen layers to be visible over them.
        const display_order = [...layers.in_display_order()].map(
            (layer) => layer.name,
        );
        expect(display_order.indexOf(LayerNames.dnp)).to.be.greaterThan(
            display_order.indexOf("F.Cu"),
        );
        expect(display_order.indexOf(LayerNames.dnp)).to.be.greaterThan(
            display_order.indexOf("F.SilkS"),
        );

        // `layers_for` only needs the parent's `layers_for` and variant.
        const layers_for = (
            footprint: (typeof board.footprints)[number],
            variant: string | null,
        ) =>
            FootprintPainter.prototype.layers_for.call(
                Object.assign(Object.create(FootprintPainter.prototype), {
                    view_painter: {
                        layers_for: () => ["F.Cu", "F.Mask"],
                        active_variant: variant,
                    },
                }) as FootprintPainter,
                footprint,
            );

        const r2 = board.find_footprint(
            "4b298f09-2eff-5fd1-982c-b1eb072ccbe8",
        )!;
        expect(r2.effective_dnp(null)).to.equal(true, "base dnp renders");
        expect(layers_for(r2, null)).to.contain(LayerNames.dnp);
        expect(layers_for(r2, null)).to.contain("F.Cu");
        expect(layers_for(r2, "Lite")).to.not.contain(
            LayerNames.dnp,
            "Lite clears R2's DNP without removing its copper layers",
        );
        expect(layers_for(r2, "Lite")).to.contain("F.Cu");
        const r1 = board.find_footprint(
            "ec3880bf-62c2-5c41-a50f-6381596c30ef",
        )!;
        expect(layers_for(r1, null)).to.not.contain(LayerNames.dnp);
        expect(layers_for(r1, "Lite")).to.contain(LayerNames.dnp);
        expect(layers_for(r1, "litre")).to.not.contain(LayerNames.dnp);
    });

    test("set_variant rebuilds the scene and the DNP hatch follows the selection", async () => {
        const canvas = document.createElement("canvas");
        canvas.width = 800;
        canvas.height = 600;
        document.body.append(canvas);
        const viewer = new BoardViewer(canvas, false, themes.default.board);

        const dnp_items = (viewer_layers: LayerSet) =>
            [
                ...viewer_layers.by_name(LayerNames.dnp)!.items,
            ] as (typeof board.footprints)[number][];

        try {
            await viewer.setup();
            await viewer.load(board);
            expect(viewer.get_variant()).to.equal(null);

            const default_scene = viewer.layers as LayerSet;
            expect(dnp_items(default_scene).length).to.equal(
                2,
                "base DNP footprints (R2, the SOT-89 alternate) render",
            );

            expect(viewer.set_variant("Lite")).to.equal(true);
            expect(viewer.set_variant("Lite")).to.equal(
                false,
                "selecting the current variant is a no-op",
            );
            expect(viewer.get_variant()).to.equal("Lite");
            const lite_scene = viewer.layers as LayerSet;
            expect(lite_scene).to.not.equal(default_scene);
            expect(dnp_items(lite_scene).length).to.equal(
                7,
                "Lite DNP footprints from the fingerprint evidence",
            );
            expect(
                (
                    viewer as unknown as {
                        painter: { active_variant: string | null };
                    }
                ).painter.active_variant,
                "the repainted painter resolves the selection",
            ).to.equal("Lite");

            expect(viewer.set_variant(null)).to.equal(true);
            expect(viewer.get_variant()).to.equal(null);
            expect(dnp_items(viewer.layers as LayerSet).length).to.equal(2);
            expect(viewer.set_variant("< Default >")).to.equal(
                false,
                "the sentinel selects the already-selected default",
            );
            expect(
                viewer.set_variant("Nope"),
                "an unknown name resolves the base and is kept as requested",
            ).to.equal(true);
            expect(
                dnp_items(viewer.layers as LayerSet).length,
                "an unknown name falls back to the base flags",
            ).to.equal(2);
        } finally {
            viewer.dispose();
            canvas.remove();
        }
    });
});

suite("board variant resolution — case folding fixture", () => {
    test("board names and footprint records fold case-insensitively (packet 2.1/2.4)", async () => {
        const board = await board_fixture("case_fold", "casefold.kicad_pcb");
        const expected = (await json_of("expected/case_fold.json")) as Expected;
        expect(board.variants.map((v) => v.name)).to.deep.equal(["lite"]);
        for (const name of ["Lite", "lite", "LITE"]) {
            for (const uuid of Object.keys(expected.identity.footprints)) {
                const footprint = board.find_footprint(uuid)!;
                expect(
                    footprint.effective_dnp(name),
                    `${uuid} under ${name}`,
                ).to.equal(
                    expected_flag(expected, "Lite", uuid, "dnp"),
                    `${uuid} under ${name} matches the folded expectation`,
                );
            }
        }
    });
});

suite("board variant resolution — PCB-only fixture", () => {
    test("header and footprint-only names resolve their records", async () => {
        const board = await board_fixture("pcb_only", "board_only.kicad_pcb");
        const expected = (await json_of("expected/pcb_only.json")) as Expected;
        expect(board.variants.map((v) => v.name)).to.deep.equal(["Lite"]);
        expect(board.variants[0]!.description).to.equal("Board header only");

        for (const uuid of Object.keys(expected.identity.footprints)) {
            const footprint = board.find_footprint(uuid)!;
            for (const [expected_key, actual_key] of Object.entries(
                FLAG_KEYS,
            )) {
                expect(
                    footprint.effective_flags("Lite")[actual_key],
                    `${uuid} Lite ${expected_key}`,
                ).to.equal(
                    expected_flag(
                        expected,
                        "Lite",
                        uuid,
                        expected_key as keyof typeof FLAG_KEYS,
                    ),
                );
                expect(
                    footprint.effective_flags("Extra")[actual_key],
                    `${uuid} Extra ${expected_key}`,
                ).to.equal(
                    expected_flag(
                        expected,
                        "Extra",
                        uuid,
                        expected_key as keyof typeof FLAG_KEYS,
                    ),
                );
            }
        }

        const r1 = board.find_footprint(
            "a5a00e79-583d-5825-b802-d444463f02f3",
        )!;
        const r2 = board.find_footprint(
            "319d3f24-17f8-52a6-8f02-447748d9a168",
        )!;
        expect(r1.effective_dnp(null)).to.equal(false);
        expect(r1.effective_dnp("Lite")).to.equal(true);
        expect(r1.effective_dnp("lite")).to.equal(
            true,
            "case-insensitive record lookup",
        );
        expect(r1.effective_dnp("Nope")).to.equal(false);
        expect(r2.effective_excluded_from_bom("Extra")).to.equal(true);
        expect(r2.effective_excluded_from_bom("extra")).to.equal(
            true,
            "case-insensitive record lookup",
        );
    });
});

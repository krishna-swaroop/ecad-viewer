/**
 * VAR-05 — schematic variant lifecycle: catalog discovery, BOM recompute,
 * painter effective state and the public ecad-viewer API, checked against the
 * shared oracle fixtures (packages/kicad-parser/tests/fixtures/design-variants).
 */
import { expect } from "@esm-bundle/chai";
import { BoardParser, SchematicParser } from "kicad-parser";

import { KicadPCB, KicadSch } from "../src/kicad";
import { ProjectSettings } from "../src/kicad/project-settings";
import { SchematicInstanceContext } from "../src/kicad/schematic";
import { Project, resolve_variant_request } from "../src/kicanvas/project";
import themes from "../src/kicanvas/themes";
import { LayerNames } from "../src/viewers/schematic/layers";
import { SchematicViewer } from "../src/viewers/schematic/viewer";

const FIXTURES = "/kicad-parser/tests/fixtures/design-variants";

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
    // `.json` is served as JSON; `.kicad_pro` is rewritten into a module whose
    // default export is the parsed object or its text.
    const response = await fetch(`${FIXTURES}/${path}`);
    const raw = await response.text();
    try {
        return JSON.parse(raw);
    } catch {
        const content = await asset(path);
        return typeof content === "string" ? JSON.parse(content) : content;
    }
}

type Expected = {
    identity: {
        occurrences: Record<
            string,
            { reference: string; symbolUuid: string; unit: number }
        >;
    };
    catalog: Array<{
        name: string;
        description: string | null;
        sources: string[];
    }>;
    default: { components: Record<string, Record<string, unknown>> };
    variants: Array<{
        name: string;
        components: Record<string, Record<string, unknown>>;
    }>;
};

const ORACLE_FILES = [
    "variants_oracle.kicad_pro",
    "variants_oracle.kicad_sch",
    "wireless.kicad_sch",
    "antenna.kicad_sch",
    "channel.kicad_sch",
    "variants_oracle.kicad_pcb",
];

/** Build a project on the main thread, as the VAR-04 resolver tests do. */
async function load_fixture(
    directory: string,
    files: string[],
): Promise<Project> {
    const sch_parser = new SchematicParser();
    const board_parser = new BoardParser();
    const project = new Project();
    const documents: Array<[string, KicadSch | KicadPCB]> = [];
    for (const filename of files) {
        if (filename.endsWith(".kicad_pro")) {
            project._project_name = filename.replace(/\.kicad_pro$/, "");
            project.settings = ProjectSettings.load(
                await json_of(`${directory}/${filename}`),
            );
            continue;
        }
        if (filename.endsWith(".kicad_pcb")) {
            documents.push([
                filename,
                new KicadPCB(
                    filename,
                    board_parser.parse(
                        await text(`${directory}/${filename}`),
                    ) as never,
                ),
            ]);
            continue;
        }
        const document = new KicadSch(
            filename,
            sch_parser.parse(await text(`${directory}/${filename}`)),
        );
        document.project = project;
        documents.push([filename, document]);
    }
    project._files_by_name = new Map(documents);
    project._sch = documents
        .filter(([, document]) => document instanceof KicadSch)
        .map(([, document]) => document as KicadSch);
    project._pcb = documents
        .filter(([, document]) => document instanceof KicadPCB)
        .map(([, document]) => document as KicadPCB);
    project._determine_schematic_hierarchy();
    project._recompute_bom(!!project._root_schematic_page);
    return project;
}

function expected_catalog(expected: Expected) {
    return expected.catalog.map(({ name, description }) => ({
        name,
        description,
    }));
}

suite("project variant catalog — oracle fixture", () => {
    let project: Project;
    let expected: Expected;

    suiteSetup(async () => {
        project = await load_fixture("oracle", ORACLE_FILES);
        expected = (await json_of("expected/oracle.json")) as Expected;
    });

    test("matches the fixture catalog name-for-name and description-for-description", () => {
        expect(project.variant_catalog()).to.deep.equal(
            expected_catalog(expected),
        );
    });

    test("descriptions come only from project and board-header sources", () => {
        expect(project.variant_description("Lite")).to.equal(
            "Cost-reduced build",
        );
        expect(project.variant_description("Pro")).to.equal(undefined);
        expect(project.variant_description("PcbOnly")).to.equal(undefined);
        expect(project.variant_description("Nope")).to.equal(undefined);
    });

    test("the default selection is null and set_active_variant is idempotent", () => {
        expect(project.active_variant).to.equal(null);
        expect(project.set_active_variant("Lite")).to.equal(true);
        expect(project.active_variant).to.equal("Lite");
        expect(project.set_active_variant("Lite")).to.equal(false);
        expect(project.set_active_variant("")).to.equal(true);
        expect(project.active_variant).to.equal(null);
        expect(project.set_active_variant("< Default >")).to.equal(false);
    });
});

suite("project variant catalog — case folding and revisions", () => {
    test("case_fold keeps schematic spellings distinct and folds board names", async () => {
        const project = await load_fixture("case_fold", [
            "casefold.kicad_pro",
            "casefold.kicad_sch",
            "casefold.kicad_pcb",
        ]);
        const expected = (await json_of("expected/case_fold.json")) as Expected;
        expect(project.variant_catalog()).to.deep.equal(
            expected_catalog(expected),
        );
    });

    test("oracle_rev2 renames and removes names without dropping records", async () => {
        const project = await load_fixture("oracle_rev2", [
            "variants_oracle.kicad_pro",
            "variants_oracle.kicad_sch",
            "wireless.kicad_sch",
            "antenna.kicad_sch",
            "channel.kicad_sch",
            "variants_oracle.kicad_pcb",
        ]);
        const expected = (await json_of(
            "expected/oracle_rev2.json",
        )) as Expected;
        expect(project.variant_catalog()).to.deep.equal(
            expected_catalog(expected),
        );
        expect(
            project.variant_description("Pro2"),
            "the renamed project entry has no description",
        ).to.equal(undefined);
    });

    test("no_variants yields an empty catalog", async () => {
        const project = await load_fixture("no_variants", [
            "plain.kicad_pro",
            "plain.kicad_sch",
            "plain.kicad_pcb",
        ]);
        expect(project.variant_catalog()).to.deep.equal([]);
    });
});

suite("project BOM follows the selected variant", () => {
    let project: Project;

    suiteSetup(async () => {
        project = await load_fixture("oracle", ORACLE_FILES);
    });

    const bom_entry = (reference: string) =>
        project.bom_items.find((item) =>
            item.Reference.split(",\n").includes(reference),
        );

    test("default BOM carries the base DNP state", () => {
        expect(bom_entry("R1")?.DNP).to.equal(false);
        expect(bom_entry("R2")?.DNP).to.equal(true);
        expect(bom_entry("R3")).to.not.equal(undefined);
        expect(
            bom_entry("R9"),
            "a schematic-only reference still has a footprint field",
        ).to.not.equal(undefined);
    });

    test("Lite recomputes DNP, exclusion and effective fields", () => {
        project.set_active_variant("Lite");
        expect(bom_entry("R1")?.DNP).to.equal(true);
        expect(bom_entry("R2")?.DNP).to.equal(false);
        expect(bom_entry("R3"), "excluded from BOM under Lite").to.equal(
            undefined,
        );
        const q1 = bom_entry("Q1")!;
        expect(q1.Name).to.equal("BCX56");
        expect(q1.Footprint).to.equal("Package_TO_SOT_SMD:SOT-89-3");
        expect(bom_entry("C1")?.Name).to.equal("100nF");
        expect(bom_entry("R9")?.DNP).to.equal(false);
    });

    test("returning to default restores the base BOM", () => {
        project.set_active_variant(null);
        expect(bom_entry("R1")?.DNP).to.equal(false);
        expect(bom_entry("R2")?.DNP).to.equal(true);
        expect(bom_entry("R3")).to.not.equal(undefined);
        expect(bom_entry("Q1")?.Footprint).to.equal(
            "Package_TO_SOT_SMD:SOT-23",
        );
    });
});

suite("schematic viewer variant rendering", () => {
    let project: Project;
    let cv: HTMLCanvasElement;
    let viewer: SchematicViewer;

    const marks_items = () =>
        viewer.layers.by_name(LayerNames.marks)!.items as Array<{
            uuid?: string;
            sheetname?: string;
        }>;

    const marked_uuids = () =>
        new Set(marks_items().map((item) => item.uuid ?? ""));

    const root_context = () =>
        project.root_schematic_page!.schematic_context as
            | SchematicInstanceContext
            | undefined;

    suiteSetup(async () => {
        project = await load_fixture("oracle", ORACLE_FILES);
        cv = document.createElement("canvas");
        cv.width = 900;
        cv.height = 700;
        document.body.append(cv);
        viewer = new SchematicViewer(cv, false, themes.default.schematic);
        await viewer.setup();
        viewer.set_instance_context(root_context()!);
        await viewer.load(project.root_schematic_page!.document);
    });

    suiteTeardown(() => {
        viewer.dispose();
        cv.remove();
    });

    test("default marks only the base-DNP symbol", () => {
        viewer.set_variant(null);
        const marked = marked_uuids();
        expect(marked.has("bdaa41e8-4b3e-516d-b481-b6b06f958325")).to.equal(
            true,
            "R2 is base DNP",
        );
        expect(marked.has("caa639b3-c965-5f5f-8579-1b1030520a32")).to.equal(
            false,
            "R1 is populated by default",
        );
    });

    test("Lite marks the variant-DNP units and sheets", () => {
        expect(viewer.set_variant("Lite")).to.equal(true);
        expect(viewer.get_variant()).to.equal("Lite");
        const marked = marked_uuids();
        expect(marked.has("caa639b3-c965-5f5f-8579-1b1030520a32")).to.equal(
            true,
            "R1 gains DNP under Lite",
        );
        expect(marked.has("bdaa41e8-4b3e-516d-b481-b6b06f958325")).to.equal(
            false,
            "R2's Lite record clears its DNP",
        );
        expect(marked.has("3e98b5e2-e4d0-5512-91f4-b35191971034")).to.equal(
            true,
            "U1 unit A",
        );
        expect(marked.has("1be1d8dc-a710-5986-ba18-62d6bc021e6b")).to.equal(
            true,
            "U1 unit B",
        );
        expect(
            marks_items().some((item) => item.sheetname === "Wireless"),
            "the Wireless sheet record folds onto its page",
        ).to.equal(true);
        expect(
            marks_items().some((item) => item.sheetname === "CH_A"),
            "CH_A has no DNP record",
        ).to.equal(false);
    });

    test("Pro marks only unit A of the conflicting multi-unit symbol", () => {
        viewer.set_variant("Pro");
        const marked = marked_uuids();
        expect(marked.has("3e98b5e2-e4d0-5512-91f4-b35191971034")).to.equal(
            true,
            "U1 unit A has a Pro record",
        );
        expect(marked.has("1be1d8dc-a710-5986-ba18-62d6bc021e6b")).to.equal(
            false,
            "U1 unit B has none",
        );
        expect(marked.has("caa639b3-c965-5f5f-8579-1b1030520a32")).to.equal(
            false,
            "R1 is populated under Pro",
        );
    });

    test("scene cache identity includes the variant, and switching back restores default", () => {
        const scene_key = () =>
            (viewer as unknown as { scene_cache_context: unknown })
                .scene_cache_context;
        viewer.set_variant("Lite");
        const lite_key = scene_key();
        expect(String(lite_key)).to.contain("Lite");
        viewer.set_variant(null);
        expect(scene_key()).to.not.equal(lite_key);
        const marked = marked_uuids();
        expect(marked.has("bdaa41e8-4b3e-516d-b481-b6b06f958325")).to.equal(
            true,
            "R2's base DNP returns",
        );
        expect(marked.has("caa639b3-c965-5f5f-8579-1b1030520a32")).to.equal(
            false,
        );
    });

    test("a page switch carries the selected variant into the new context", async () => {
        viewer.set_variant("Lite");
        const wireless_page = project.pages.find(
            (page) => page.name === "Wireless",
        )!;
        viewer.set_instance_context(
            wireless_page.schematic_context as SchematicInstanceContext,
        );
        await viewer.load(wireless_page.document);
        expect(
            marked_uuids().has("a5cfa1a3-dfa6-506d-9fc0-fdb3dcd9a7e5"),
            "U2 is DNP via the Wireless sheet fold under Lite",
        ).to.equal(true);
    });
});

suite("variant request resolution — public API contract", () => {
    let project: Project;

    suiteSetup(async () => {
        project = await load_fixture("oracle", ORACLE_FILES);
    });

    test("before loading, the request is kept and the current selection is untouched", () => {
        const resolution = resolve_variant_request(project, "Lite", false);
        expect(resolution).to.deep.equal({
            effective: null,
            requested: "Lite",
            known: true,
        });
    });

    test("a known name resolves to itself once loaded", () => {
        const resolution = resolve_variant_request(project, "Lite", true);
        expect(resolution).to.deep.equal({
            effective: "Lite",
            requested: "Lite",
            known: true,
        });
    });

    test("an unknown name selects the default and is cleared", () => {
        const resolution = resolve_variant_request(project, "Nope", true);
        expect(resolution).to.deep.equal({
            effective: null,
            requested: null,
            known: false,
        });
    });

    test("default requests normalize to null", () => {
        for (const name of [null, "", "< Default >"]) {
            expect(resolve_variant_request(project, name, true)).to.deep.equal({
                effective: null,
                requested: null,
                known: true,
            });
        }
    });

    test("applying the resolved selection drives the project and the catalog", () => {
        const resolution = resolve_variant_request(project, "Lite", true);
        expect(project.set_active_variant(resolution.effective)).to.equal(true);
        expect(project.active_variant).to.equal("Lite");
        expect(
            resolve_variant_request(project, "Nope", true).effective,
        ).to.equal(null);
        project.set_active_variant(null);
    });
});

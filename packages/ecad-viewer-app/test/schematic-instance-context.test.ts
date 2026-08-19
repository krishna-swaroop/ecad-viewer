import { expect } from "@esm-bundle/chai";
import { SchematicParser } from "kicad-parser";

import { NullRenderer } from "../src/graphics/null-renderer";
import { DrawingSheet } from "../src/kicad";
import { KicadSch, SchematicInstanceContext } from "../src/kicad/schematic";
import { SchematicBomVisitor } from "../src/kicad/schematic_bom_visitor";
import { normalize_schematic_selection } from "../src/ecad-viewer/host-adapter";
import { Project } from "../src/kicanvas/project";
import kicad_default_theme from "../src/kicanvas/themes/kicad-default";
import { StrokeFont } from "../src/kicad/text";
import { LayerNames, LayerSet } from "../src/viewers/schematic/layers";
import { SchematicPainter } from "../src/viewers/schematic/painter";
import { apply_schematic_render_defaults } from "../src/viewers/schematic/render-state";
import { SchematicViewer } from "../src/viewers/schematic/viewer";

const SYMBOL_UUID = "00000000-0000-0000-0000-0000000000aa";
const INSTANCE_A = "/root/sheet-a";
const INSTANCE_B = "/root/sheet-b";

const REUSED_CHILD = `
(kicad_sch
  (version 20250114)
  (generator "eeschema")
  (uuid "00000000-0000-0000-0000-000000000001")
  (lib_symbols
    (symbol "Device:DUAL"
      (pin_numbers (hide yes))
      (pin_names (offset 0.254) (hide yes))
      (exclude_from_sim no) (in_bom yes) (on_board yes)
      (symbol "DUAL_1_1"
        (rectangle (start -1.27 -1.27) (end 1.27 1.27)
          (stroke (width 0.254) (type default)) (fill (type none)))
        (pin input line (at -5.08 0 0) (length 3.81)
          (name "A" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27)))))
      )
      (symbol "DUAL_2_1"
        (rectangle (start -2.54 -2.54) (end 2.54 2.54)
          (stroke (width 0.254) (type default)) (fill (type none)))
        (pin output line (at 5.08 0 180) (length 3.81)
          (name "B" (effects (font (size 1.27 1.27))))
          (number "2" (effects (font (size 1.27 1.27)))))
      )
    )
  )
  (symbol
    (lib_id "Device:DUAL") (at 100 100 0)
    (unit 1) (body_style 1)
    (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no)
    (uuid "${SYMBOL_UUID}")
    (property "Reference" "U7" (at 102 96 0)
      (effects (font (size 1.27 1.27))))
    (property "Value" "AUTHORED" (at 102 98 0)
      (effects (font (size 1.27 1.27))))
    (property "Footprint" "Pkg:Authored" (at 102 100 0)
      (effects (font (size 1.27 1.27)) (hide yes)))
    (property "Alias" "\${REFERENCE}-\${VALUE}-\${UNIT}" (at 102 102 0)
      (effects (font (size 1.27 1.27))))
    (pin "1" (uuid "00000000-0000-0000-0000-000000000011"))
    (pin "2" (uuid "00000000-0000-0000-0000-000000000012"))
    (instances
      (project "reuse"
        (path "${INSTANCE_A}" (reference "U51") (unit 1)
          (value "VALUE-A") (footprint "Pkg:A"))
        (path "${INSTANCE_B}" (reference "U38") (unit 2)
          (value "VALUE-B") (footprint "Pkg:B"))
      )
    )
  )
)
`;

function load_child(): KicadSch {
    return new KicadSch(
        "Subsheets/reused.kicad_sch",
        new SchematicParser().parse(REUSED_CHILD),
    );
}

function empty_schematic(filename: string, uuid: string): KicadSch {
    return new KicadSch(filename, { uuid } as never);
}

function root_schematic(requested_child: string): KicadSch {
    return new KicadSch("Root.kicad_sch", {
        uuid: "root",
        sheet_instances: [{ path: "/", page: "1" }],
        sheets: [
            {
                at: { position: { x: 10, y: 10 } },
                size: { x: 20, y: 10 },
                stroke: { width: 0.15, type: "default" },
                fill: { type: "none" },
                uuid: "child-sheet",
                properties: [
                    {
                        name: "Sheetname",
                        text: "Child",
                        at: { position: { x: 10, y: 10 } },
                    },
                    {
                        name: "Sheetfile",
                        text: requested_child,
                        at: { position: { x: 10, y: 12 } },
                    },
                ],
                instances: {
                    projects: [
                        {
                            paths: [{ path: "/root", page: "2" }],
                        },
                    ],
                },
            },
        ],
    } as never);
}

function project_with_files(files: Array<[string, KicadSch]>): Project {
    const project = new Project();
    project._project_name = "Root";
    project._files_by_name = new Map(files);
    project._sch = files.map(([, document]) => document);
    return project;
}

suite("schematic instance context", () => {
    test("resolves every instance field without mutating the source symbol", () => {
        const child = load_child();
        const symbol = child.symbols.get(SYMBOL_UUID)!;
        const context_a = new SchematicInstanceContext(child, INSTANCE_A);
        const context_b = new SchematicInstanceContext(child, INSTANCE_B);

        expect(context_a.reference(symbol)).to.equal("U51");
        expect(context_b.reference(symbol)).to.equal("U38");
        expect(context_a.value(symbol)).to.equal("VALUE-A");
        expect(context_b.value(symbol)).to.equal("VALUE-B");
        expect(context_a.footprint(symbol)).to.equal("Pkg:A");
        expect(context_b.footprint(symbol)).to.equal("Pkg:B");
        expect(context_a.unit(symbol)).to.equal(1);
        expect(context_b.unit(symbol)).to.equal(2);
        expect(
            context_a.unit_pins(symbol).map((pin) => pin.number),
        ).to.deep.equal(["1"]);
        expect(
            context_b.unit_pins(symbol).map((pin) => pin.number),
        ).to.deep.equal(["2"]);
        expect(
            context_a.shown_property_text(symbol.properties.get("Alias")!),
        ).to.equal("U51-VALUE-A-A");
        expect(context_b.resolve_text_var(`${SYMBOL_UUID}:REFERENCE`)).to.equal(
            "U38",
        );
        expect(context_a.find_symbol("U51")).to.equal(symbol);
        expect(context_a.find_symbol("U38")).to.equal(null);
        expect(context_b.find_symbol("U38")).to.equal(symbol);

        expect(symbol.reference).to.equal("U7");
        expect(symbol.value).to.equal("AUTHORED");
        expect(symbol.footprint).to.equal("Pkg:Authored");
        expect(symbol.unit).to.equal(1);
    });

    test("paints each page's reference instead of the authored default", () => {
        const child = load_child();
        const symbol = child.symbols.get(SYMBOL_UUID)!;
        const font = StrokeFont.default();
        const original_draw = font.draw;

        const painted = (sheet_path: string) => {
            const texts: string[] = [];
            font.draw = function (renderer, text, position, attributes) {
                texts.push(text);
                return original_draw.call(
                    this,
                    renderer,
                    text,
                    position,
                    attributes,
                );
            };
            try {
                const theme = kicad_default_theme.schematic;
                const renderer = new NullRenderer();
                apply_schematic_render_defaults(renderer, theme);
                const layers = new LayerSet(theme);
                const painter = new SchematicPainter(
                    renderer,
                    layers,
                    theme,
                    new SchematicInstanceContext(child, sheet_path),
                );
                const layer = layers.by_name(LayerNames.symbol_field)!;
                layer.items.push(symbol);
                painter.paint_layer(layer);
                return texts;
            } finally {
                font.draw = original_draw;
            }
        };

        expect(painted(INSTANCE_A)).to.include("U51A");
        expect(painted(INSTANCE_B)).to.include("U38B");
    });

    test("indexes BOM and semantic selections by exact page instance", () => {
        const child = load_child();
        const symbol = child.symbols.get(SYMBOL_UUID)!;
        const context_a = new SchematicInstanceContext(
            child,
            INSTANCE_A,
            `${child.filename}:${INSTANCE_A}`,
        );
        const context_b = new SchematicInstanceContext(
            child,
            INSTANCE_B,
            `${child.filename}:${INSTANCE_B}`,
        );
        const visitor = new SchematicBomVisitor();
        visitor.visit_instance(context_a);
        visitor.visit_instance(context_b);

        expect(visitor.designator_refs.get("U51")![0]!.project_path).to.equal(
            context_a.project_path,
        );
        expect(visitor.designator_refs.get("U38")![0]!.sheet_path).to.equal(
            INSTANCE_B,
        );
        expect(visitor.bom_list.map((item) => item.Reference)).to.deep.equal([
            "U51",
            "U38",
        ]);

        const selection = normalize_schematic_selection(
            symbol,
            child,
            context_b,
        );
        expect(selection?.reference).to.equal("U38");
        expect(selection?.page).to.equal(context_b.project_path);
    });

    test("keeps retained scenes separate while switching a reused document", async () => {
        const child = load_child();
        const context_a = new SchematicInstanceContext(child, INSTANCE_A);
        const context_b = new SchematicInstanceContext(child, INSTANCE_B);
        const canvas = document.createElement("canvas");
        canvas.width = 800;
        canvas.height = 600;
        document.body.append(canvas);
        const viewer = new SchematicViewer(
            canvas,
            false,
            kicad_default_theme.schematic,
        );

        try {
            await viewer.setup();
            viewer.set_instance_context(context_a);
            await viewer.load(child);
            const painted_a = viewer.painter;

            viewer.set_instance_context(context_b);
            await viewer.load(child);
            expect(viewer.painter).not.to.equal(painted_a);
            expect(viewer.painter.instance_context?.sheet_path).to.equal(
                INSTANCE_B,
            );

            viewer.enable_presentation_cache();
            const scene_b = viewer.layers;

            viewer.set_instance_context(context_a);
            viewer.set_drawing_sheet(DrawingSheet.default());
            viewer.paint();
            const scene_a = viewer.layers;
            expect(scene_a).not.to.equal(scene_b);
            expect(viewer.presentation_cache_size).to.equal(2);

            viewer.set_instance_context(context_b);
            await viewer.load_plain_document(child);
            expect(viewer.layers).to.equal(scene_b);
            expect(
                viewer.instance_context?.reference(
                    child.symbols.get(SYMBOL_UUID)!,
                ),
            ).to.equal("U38");
            expect(viewer.presentation_cache_size).to.equal(2);
        } finally {
            viewer.dispose();
            canvas.remove();
        }
    });
});

suite("case-insensitive schematic hierarchy resolution", () => {
    test("includes and activates a uniquely case-mismatched child", () => {
        const root = root_schematic("Subsheets/EBP_LPBM_Main_X_Red.kicad_sch");
        const actual = "Subsheets/EBP_lPBM_Main_X_Red.kicad_sch";
        const child = empty_schematic(actual, "child");
        const project = project_with_files([
            [root.filename, root],
            [actual, child],
        ]);

        expect(project._determine_schematic_hierarchy()).to.equal(true);
        expect(project.pages).to.have.length(2);
        expect(project.pages[1]!.filename).to.equal(actual);
        expect(project.activate_child_sch("child-sheet")).to.equal(true);
        expect(project.active_sch_name).to.equal(
            project.pages[1]!.project_path,
        );
    });

    test("rejects an ambiguous case-collision", () => {
        const root = root_schematic("Subsheets/Child.kicad_sch");
        const lower = "Subsheets/child.kicad_sch";
        const upper = "Subsheets/CHILD.kicad_sch";
        const project = project_with_files([
            [root.filename, root],
            [lower, empty_schematic(lower, "lower")],
            [upper, empty_schematic(upper, "upper")],
        ]);

        expect(project._determine_schematic_hierarchy()).to.equal(true);
        expect(project.pages).to.have.length(1);
        expect(
            project.resolve_schematic_filename(
                root.filename,
                "Subsheets/Child.kicad_sch",
            ),
        ).to.equal(undefined);
    });

    test("keeps exact-case priority beside a case-collision", () => {
        const root = root_schematic("Subsheets/child.kicad_sch");
        const exact = "Subsheets/child.kicad_sch";
        const collision = "Subsheets/CHILD.kicad_sch";
        const project = project_with_files([
            [root.filename, root],
            [exact, empty_schematic(exact, "exact")],
            [collision, empty_schematic(collision, "collision")],
        ]);

        expect(project._determine_schematic_hierarchy()).to.equal(true);
        expect(project.pages).to.have.length(2);
        expect(project.pages[1]!.filename).to.equal(exact);
    });
});

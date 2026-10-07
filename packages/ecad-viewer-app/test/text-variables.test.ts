import { expect } from "@esm-bundle/chai";
import { BoardParser, SchematicParser } from "kicad-parser";

import { DrawingSheet, KicadPCB, KicadSch } from "../src/kicad";
import { Footprint, FpText, GrText } from "../src/kicad/board";
import { SchematicInstanceContext, Text } from "../src/kicad/schematic";
import { expand_text_vars } from "../src/kicad/common";
import { Project } from "../src/kicanvas/project";

/**
 * Text variables are defined once in `.kicad_pro` and used everywhere: on a
 * sheet, on silkscreen, and -- most commonly -- indirectly, through a title
 * block whose fields are themselves variables. All three drew the variable's
 * name instead of its value.
 */

const PROJECT_SETTINGS = {
    meta: { filename: "fixture.kicad_pro", version: 1 },
    text_variables: {
        VERSION: "1.4.0",
        RELEASE_DATE: "2026-08-27",
        SELF: "${SELF}",
    },
};

// A title block that reads its values from project variables, exactly as KiCad
// writes one when the fields are filled in with `${...}`.
const BOARD = `
(kicad_pcb
  (version 20240108)
  (generator "pcbnew")
  (paper "A4")
  (title_block
    (title "Fixture")
    (date "\${RELEASE_DATE}")
    (rev "\${VERSION}")
  )
  (property "VERSION" "1.4.0")
  (property "RELEASE_DATE" "2026-08-27")
)
`;

const SCHEMATIC = `
(kicad_sch
  (version 20231120)
  (generator "eeschema")
  (uuid "00000000-0000-0000-0000-000000000001")
  (paper "A4")
  (title_block
    (title "Fixture")
    (date "\${RELEASE_DATE}")
    (rev "\${VERSION}")
  )
)
`;

// Silkscreen is the third place #194 reported, and the only one whose
// resolution runs through a footprint. Deliberately carries no mirrored
// `(property ...)` entries: a value found here can only have come from the
// project, which is what makes the footprint's fallback to its parent board
// the thing under test rather than an incidental copy on the board.
const SILKSCREEN_BOARD = `
(kicad_pcb
  (version 20240108)
  (generator "pcbnew")
  (paper "A4")
  (gr_text "Rev \${VERSION}"
    (at 100 100 0)
    (layer "F.SilkS")
    (uuid "00000000-0000-0000-0000-0000000000f1")
    (effects (font (size 1 1) (thickness 0.15))))
  (footprint "Fixture:Label"
    (layer "F.Cu")
    (uuid "00000000-0000-0000-0000-0000000000f2")
    (at 50 50 0)
    (property "Reference" "J1" (at 0 -2 0) (layer "F.SilkS")
      (uuid "00000000-0000-0000-0000-0000000000f3")
      (effects (font (size 1 1) (thickness 0.15))))
    (fp_text user "Built \${VERSION}"
      (at 0 2 0)
      (layer "F.SilkS")
      (uuid "00000000-0000-0000-0000-0000000000f4")
      (effects (font (size 1 1) (thickness 0.15))))
    (fp_text user "\${REFERENCE}"
      (at 0 4 0)
      (layer "F.SilkS")
      (uuid "00000000-0000-0000-0000-0000000000f5")
      (effects (font (size 1 1) (thickness 0.15))))
  )
)
`;

function project_with_settings(): Project {
    const project = new Project();
    project.settings = Object.assign(project.settings, PROJECT_SETTINGS);
    return project;
}

function board_in_project(): KicadPCB {
    const board = new KicadPCB(
        "fixture.kicad_pcb",
        new BoardParser().parse(BOARD) as never,
    );
    board.project = project_with_settings();
    return board;
}

function silkscreen_board_in_project(): KicadPCB {
    const board = new KicadPCB(
        "silk.kicad_pcb",
        new BoardParser().parse(SILKSCREEN_BOARD) as never,
    );
    board.project = project_with_settings();
    return board;
}

function board_footprint(): Footprint {
    const footprint = silkscreen_board_in_project().footprints[0];
    expect(footprint, "footprint on the board").to.exist;
    return footprint!;
}

/** The footprint's silkscreen text whose authored value starts with `prefix`. */
function footprint_text(footprint: Footprint, prefix: string): FpText {
    // fp_text lives in its own collection; `drawings` carries geometry only.
    const text = footprint.fp_texts.find((item) =>
        item.text.startsWith(prefix),
    );
    expect(text, `fp_text starting with ${prefix}`).to.exist;
    return text!;
}

function schematic_in_project(): KicadSch {
    const schematic = new KicadSch(
        "fixture.kicad_sch",
        new SchematicParser().parse(SCHEMATIC) as never,
    );
    schematic.project = project_with_settings();
    return schematic;
}

// The painter never reads a KicadSch directly; it goes through a
// SchematicInstanceContext so a reused child sheet shows the right annotated
// reference. This fixture carries a project variable in the two places that
// context resolves: a plain text item on the sheet, and a symbol property.
const SHEET_WITH_VARS = `
(kicad_sch
  (version 20231120)
  (generator "eeschema")
  (uuid "00000000-0000-0000-0000-000000000002")
  (paper "A4")
  (title_block (title "Fixture") (rev "\${VERSION}"))
  (lib_symbols
    (symbol "Device:R"
      (property "Reference" "R" (at 0 0 0))
      (property "Value" "R" (at 0 0 0))
    )
  )
  (text "Build \${VERSION}" (at 10 10 0))
  (symbol
    (lib_id "Device:R")
    (at 20 20 0)
    (unit 1)
    (uuid "00000000-0000-0000-0000-0000000000aa")
    (property "Reference" "R1" (at 20 18 0))
    (property "Datasheet" "docs/\${VERSION}.pdf" (at 20 22 0))
    (instances
      (project "fixture"
        (path "/00000000-0000-0000-0000-000000000002"
          (reference "R1") (unit 1))))
  )
)
`;

function sheet_in_project(): KicadSch {
    const schematic = new KicadSch(
        "sheet.kicad_sch",
        new SchematicParser().parse(SHEET_WITH_VARS) as never,
    );
    schematic.project = project_with_settings();
    return schematic;
}

function context_for(document: KicadSch): SchematicInstanceContext {
    return new SchematicInstanceContext(document, `/${document.uuid}`);
}

suite("project text variables", () => {
    test("resolves a project variable used on a board", () => {
        expect(board_in_project().resolve_text_var("VERSION")).to.equal(
            "1.4.0",
        );
    });

    test("resolves a project variable used on a schematic", () => {
        // A schematic has no mirrored properties to fall back on, so this can
        // only come from the project.
        expect(schematic_in_project().resolve_text_var("VERSION")).to.equal(
            "1.4.0",
        );
    });

    test("leaves an undefined variable alone", () => {
        expect(board_in_project().resolve_text_var("NOT_DEFINED")).to.equal(
            undefined,
        );
        expect(
            expand_text_vars("v${NOT_DEFINED}", board_in_project()),
        ).to.equal("v${NOT_DEFINED}");
    });

    test("still resolves without a project loaded", () => {
        const board = new KicadPCB(
            "fixture.kicad_pcb",
            new BoardParser().parse(BOARD) as never,
        );
        // No project: the board's own copy of the variables answers instead.
        expect(board.resolve_text_var("VERSION")).to.equal("1.4.0");
    });
});

suite("board (property ...) entries", () => {
    test("keeps the whole value", () => {
        // These parsed to a single character of the value: `"1.4.0"` became
        // `"4"`, so a board resolved its variables to nonsense.
        const board = new KicadPCB(
            "fixture.kicad_pcb",
            new BoardParser().parse(BOARD) as never,
        );
        expect(board.properties.get("VERSION")?.value).to.equal("1.4.0");
        expect(board.properties.get("VERSION")?.name).to.equal("VERSION");
        expect(board.properties.get("RELEASE_DATE")?.value).to.equal(
            "2026-08-27",
        );
    });
});

suite("expansion through a title block", () => {
    test("expands a title block field that is itself a variable", () => {
        // The drawing sheet asks for REVISION, the title block answers
        // "${VERSION}", and a single pass left that on screen.
        const sheet = DrawingSheet.default();
        sheet.document = board_in_project();
        expect(expand_text_vars("Rev: ${REVISION}", sheet)).to.equal(
            "Rev: 1.4.0",
        );
        expect(expand_text_vars("Date: ${ISSUE_DATE}", sheet)).to.equal(
            "Date: 2026-08-27",
        );
    });

    test("expands the same indirection on a schematic sheet", () => {
        const sheet = DrawingSheet.default();
        sheet.document = schematic_in_project();
        expect(expand_text_vars("Rev: ${REVISION}", sheet)).to.equal(
            "Rev: 1.4.0",
        );
    });

    test("expands several variables in one string", () => {
        const sheet = DrawingSheet.default();
        sheet.document = board_in_project();
        expect(
            expand_text_vars("${VERSION} (${RELEASE_DATE})", sheet),
        ).to.equal("1.4.0 (2026-08-27)");
    });

    test("terminates on a variable that refers to itself", () => {
        // Without a depth limit this recursion would not end.
        expect(expand_text_vars("${SELF}", board_in_project())).to.equal(
            "${SELF}",
        );
    });
});
/**
 * Issue #194 follow-up. The document-level fix resolved variables on a board
 * and through a title block, but the schematic painter reads its text through
 * SchematicInstanceContext, whose own resolver stopped at the title block and
 * never asked the project. A sheet drawn through a context therefore still
 * showed `${VERSION}` verbatim.
 */
suite("text variables through a schematic instance context", () => {
    test("resolves a project variable used in a sheet text item", () => {
        const document = sheet_in_project();
        const context = context_for(document);
        const text = document.drawings.find(
            (drawing): drawing is Text => drawing instanceof Text,
        )!;
        expect(context.shown_text(text)).to.equal("Build 1.4.0");
    });

    test("resolves a project variable used in a symbol property", () => {
        const document = sheet_in_project();
        const context = context_for(document);
        const symbol = document.symbols.values().next().value!;
        const property = symbol.properties.get("Datasheet")!;
        expect(context.shown_property_text(property)).to.equal(
            "docs/1.4.0.pdf",
        );
    });

    test("resolves a project variable asked for by name", () => {
        expect(
            context_for(sheet_in_project()).resolve_text_var("VERSION"),
        ).to.equal("1.4.0");
    });

    test("keeps the instance context's own answers ahead of the project", () => {
        // FILENAME is the context's to answer; the project fallback must not
        // shadow it.
        const context = context_for(sheet_in_project());
        expect(context.resolve_text_var("FILENAME")).to.equal(
            "sheet.kicad_sch",
        );
    });

    test("expands a title block field that is itself a project variable", () => {
        // resolve_text_var is a single lookup; expand_text_vars drives the
        // recursion. REVISION answers "${VERSION}", which only the project
        // can finish.
        expect(
            expand_text_vars(
                "Rev: ${REVISION}",
                context_for(sheet_in_project()),
            ),
        ).to.equal("Rev: 1.4.0");
    });

    test("leaves an undefined variable alone", () => {
        expect(
            context_for(sheet_in_project()).resolve_text_var("NOT_DEFINED"),
        ).to.equal(undefined);
    });
});

suite("text variables on silkscreen", () => {
    // The third of #194's three reports, and the one whose resolution does not
    // reach the board directly: a footprint answers first and only falls
    // through to its parent for names it does not own. That fallback is what
    // puts a project variable on silkscreen, and nothing covered it.

    test("resolves a project variable in board-level silkscreen text", () => {
        const board = silkscreen_board_in_project();
        const silk = board.drawings.find(
            (drawing) => drawing instanceof GrText,
        ) as GrText;
        expect(silk, "gr_text on the board").to.exist;
        expect(silk.shown_text).to.equal("Rev 1.4.0");
    });

    test("resolves a project variable in footprint silkscreen text", () => {
        // Footprint -> board -> project. The board carries no copy of this
        // value, so reaching it proves the whole chain rather than a
        // coincidental property on the way.
        const footprint = board_footprint();
        const label = footprint_text(footprint, "Built");
        expect(label.shown_text).to.equal("Built 1.4.0");
    });

    test("a footprint's own fields still win over the project", () => {
        // The fallback must be a fallback: a name the footprint owns is
        // answered by the footprint, never handed upwards.
        const footprint = board_footprint();
        const designator = footprint_text(footprint, "${REFERENCE}");
        expect(designator.shown_text).to.equal("J1");
    });

    test("an unknown variable is left alone rather than blanked", () => {
        const board = silkscreen_board_in_project();
        const footprint = board.footprints[0]!;
        expect(footprint.resolve_text_var("NOT_DEFINED")).to.equal(undefined);
        expect(expand_text_vars("${NOT_DEFINED}", footprint)).to.equal(
            "${NOT_DEFINED}",
        );
    });
});

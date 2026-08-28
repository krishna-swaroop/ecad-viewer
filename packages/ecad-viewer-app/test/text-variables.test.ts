import { expect } from "@esm-bundle/chai";
import { BoardParser, SchematicParser } from "kicad-parser";

import { DrawingSheet, KicadPCB, KicadSch } from "../src/kicad";
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

function schematic_in_project(): KicadSch {
    const schematic = new KicadSch(
        "fixture.kicad_sch",
        new SchematicParser().parse(SCHEMATIC) as never,
    );
    schematic.project = project_with_settings();
    return schematic;
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

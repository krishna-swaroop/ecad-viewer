import { expect } from "@esm-bundle/chai";
import { SchematicParser } from "kicad-parser";

import { KicadSch } from "../src/kicad/schematic";
import kicad_default_theme from "../src/kicanvas/themes/kicad-default";
import { measure_symbol_bboxes } from "../src/viewers/schematic/painters/symbol";

const theme = kicad_default_theme.schematic;

/**
 * One library symbol with two De Morgan body styles, placed twice.
 *
 * KiCad renamed the body-style token: `convert` is the legacy spelling and
 * `body_style` is what a current KiCad writes. Issue #94 was that the parser
 * read only `convert`, so `data.convert` came back undefined for every modern
 * file and `SchematicSymbol` fell back to style 1 — every placement rendered
 * its style 1 body no matter what the file said.
 *
 * Nothing on disk caught this: every symbol across `data/projects` carries
 * `(body_style 1)`, so the wrong answer and the right answer coincided. Hence
 * a fixture rather than a sample file.
 *
 * The two styles are deliberately far apart in size, and their pins sit at
 * different offsets, so "which body got drawn" and "which pin definition got
 * resolved" are both answerable from geometry alone.
 */
const FIXTURE = `
(kicad_sch
  (version 20250114)
  (generator "eeschema")
  (uuid "00000000-0000-0000-0000-000000000001")
  (lib_symbols
    (symbol "Device:DEMORGAN"
      (pin_numbers (hide yes))
      (pin_names (offset 0.254) (hide yes))
      (exclude_from_sim no) (in_bom yes) (on_board yes)
      (symbol "DEMORGAN_1_1"
        (polyline
          (pts (xy -1.27 1.27) (xy 1.27 1.27) (xy 1.27 -1.27) (xy -1.27 -1.27) (xy -1.27 1.27))
          (stroke (width 0.254) (type default))
          (fill (type none))
        )
        (pin input line (at -5.08 0 0) (length 3.81)
          (name "A" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27))))
        )
      )
      (symbol "DEMORGAN_1_2"
        (polyline
          (pts (xy -5.08 5.08) (xy 5.08 5.08) (xy 5.08 -5.08) (xy -5.08 -5.08) (xy -5.08 5.08))
          (stroke (width 0.254) (type default))
          (fill (type none))
        )
        (pin input line (at -10.16 0 0) (length 5.08)
          (name "A" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27))))
        )
      )
    )
  )
  (symbol
    (lib_id "Device:DEMORGAN")
    (at 100 100 0)
    (unit 1) (body_style 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no)
    (uuid "00000000-0000-0000-0000-0000000000a1")
    (property "Reference" "U1" (at 102 98 0) (effects (font (size 1.27 1.27))))
    (property "Value" "DEMORGAN" (at 102 102 0) (effects (font (size 1.27 1.27))))
    (pin "1" (uuid "00000000-0000-0000-0000-0000000000p1"))
  )
  (symbol
    (lib_id "Device:DEMORGAN")
    (at 140 100 0)
    (unit 1) (body_style 2) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no)
    (uuid "00000000-0000-0000-0000-0000000000a2")
    (property "Reference" "U2" (at 142 98 0) (effects (font (size 1.27 1.27))))
    (property "Value" "DEMORGAN" (at 142 102 0) (effects (font (size 1.27 1.27))))
    (pin "1" (uuid "00000000-0000-0000-0000-0000000000p2"))
  )
)
`;

/** The same design written by an older KiCad, which spelled the token `convert`. */
const LEGACY_FIXTURE = FIXTURE.replace(/\(body_style (\d)\)/g, "(convert $1)");

function load(source: string): KicadSch {
    return new KicadSch(
        "body-style.kicad_sch",
        new SchematicParser().parse(source),
    );
}

function symbol_by_reference(sch: KicadSch, reference: string) {
    for (const symbol of sch.symbols.values()) {
        if (symbol.get_property_text("Reference") == reference) {
            return symbol;
        }
    }
    throw new Error(`no symbol ${reference} in the fixture`);
}

suite("schematic De Morgan body styles", () => {
    test("reads the modern (body_style N) token", () => {
        const sch = load(FIXTURE);

        expect(symbol_by_reference(sch, "U1").convert).to.equal(1);
        expect(symbol_by_reference(sch, "U2").convert).to.equal(2);
    });

    test("still reads the legacy (convert N) token", () => {
        const sch = load(LEGACY_FIXTURE);

        expect(symbol_by_reference(sch, "U1").convert).to.equal(1);
        expect(symbol_by_reference(sch, "U2").convert).to.equal(2);
    });

    test("paints the alternate body for a style 2 placement", () => {
        const sch = load(FIXTURE);

        const style_1 = measure_symbol_bboxes(
            theme,
            symbol_by_reference(sch, "U1"),
        ).body;
        const style_2 = measure_symbol_bboxes(
            theme,
            symbol_by_reference(sch, "U2"),
        ).body;

        // The two subsymbols are 2.54mm and 10.16mm across, and the measured
        // box carries the 0.254mm stroke, half of it beyond each edge. Before
        // the fix both placements measured 3.048: both drew the style 1 body.
        expect(style_1.w).to.be.closeTo(3.048, 0.05);
        expect(style_2.w).to.be.closeTo(10.668, 0.05);
        expect(style_2.h).to.be.closeTo(10.668, 0.05);

        // Each body stays centred on its own placement.
        expect(style_1.center.x).to.be.closeTo(100, 0.5);
        expect(style_2.center.x).to.be.closeTo(140, 0.5);
    });

    test("resolves pins against the placed body style", () => {
        const sch = load(FIXTURE);

        // `PinInstance.definition` looks the pin up with the owning symbol's
        // body style, so a wrong style silently returns the wrong pin geometry
        // — the second half of issue #94, and invisible in a bbox that only
        // measures the body.
        const style_1 = symbol_by_reference(sch, "U1").pins[0]!.definition;
        const style_2 = symbol_by_reference(sch, "U2").pins[0]!.definition;

        expect(style_1.parent.style).to.equal(1);
        expect(style_2.parent.style).to.equal(2);

        expect(style_1.at.position.x).to.be.closeTo(-5.08, 0.001);
        expect(style_2.at.position.x).to.be.closeTo(-10.16, 0.001);
        expect(style_1.length).to.be.closeTo(3.81, 0.001);
        expect(style_2.length).to.be.closeTo(5.08, 0.001);
    });
});

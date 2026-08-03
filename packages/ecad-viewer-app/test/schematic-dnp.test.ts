import { expect } from "@esm-bundle/chai";
import { SchematicParser } from "kicad-parser";

import { BBox } from "../src/base/math";
import { NullRenderer } from "../src/graphics/null-renderer";
import { KicadSch } from "../src/kicad/schematic";
import kicad_default_theme from "../src/kicanvas/themes/kicad-default";
import { dnp_marker_bbox } from "../src/viewers/schematic/dnp";
import { LayerNames, LayerSet } from "../src/viewers/schematic/layers";
import { SchematicPainter } from "../src/viewers/schematic/painter";
import { measure_symbol_bboxes } from "../src/viewers/schematic/painters/symbol";

const theme = kicad_default_theme.schematic;

/**
 * Two passives placed side by side, both marked DNP, plus one that is not.
 *
 * `RZERO` is the shape of KiCad's stock `Device:R_Small_US`: every graphic
 * declares `(stroke (width 0))`, meaning "use the document default". `CWIDE` is
 * the shape of `Device:C_Small`, which carries explicit stroke widths. Issue #86
 * was that only the second kind ever got a DNP cross.
 */
const FIXTURE = `
(kicad_sch
  (version 20250114)
  (generator "eeschema")
  (uuid "00000000-0000-0000-0000-000000000001")
  (lib_symbols
    (symbol "Device:RZERO"
      (pin_numbers (hide yes))
      (pin_names (offset 0.254) (hide yes))
      (exclude_from_sim no) (in_bom yes) (on_board yes)
      (symbol "RZERO_1_1"
        (polyline
          (pts (xy 0 1.524) (xy 1.016 1.143) (xy 0 0.762) (xy -1.016 0.381) (xy 0 0))
          (stroke (width 0) (type default))
          (fill (type none))
        )
        (polyline
          (pts (xy 0 0) (xy 1.016 -0.381) (xy 0 -0.762) (xy -1.016 -1.143) (xy 0 -1.524))
          (stroke (width 0) (type default))
          (fill (type none))
        )
        (pin passive line (at 0 2.54 270) (length 1.016)
          (name "" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27))))
        )
        (pin passive line (at 0 -2.54 90) (length 1.016)
          (name "" (effects (font (size 1.27 1.27))))
          (number "2" (effects (font (size 1.27 1.27))))
        )
      )
    )
    (symbol "Device:CWIDE"
      (pin_numbers (hide yes))
      (pin_names (offset 0.254) (hide yes))
      (exclude_from_sim no) (in_bom yes) (on_board yes)
      (symbol "CWIDE_0_1"
        (polyline
          (pts (xy -1.524 0.508) (xy 1.524 0.508))
          (stroke (width 0.3048) (type default))
          (fill (type none))
        )
        (polyline
          (pts (xy -1.524 -0.508) (xy 1.524 -0.508))
          (stroke (width 0.3302) (type default))
          (fill (type none))
        )
      )
      (symbol "CWIDE_1_1"
        (pin passive line (at 0 2.54 270) (length 2.032)
          (name "" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27))))
        )
        (pin passive line (at 0 -2.54 90) (length 2.032)
          (name "" (effects (font (size 1.27 1.27))))
          (number "2" (effects (font (size 1.27 1.27))))
        )
      )
    )
  )
  (symbol
    (lib_id "Device:RZERO")
    (at 100 100 0)
    (unit 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp yes)
    (uuid "00000000-0000-0000-0000-0000000000r1")
    (property "Reference" "R1" (at 102 98 0) (effects (font (size 1.27 1.27))))
    (property "Value" "10k" (at 102 102 0) (effects (font (size 1.27 1.27))))
    (pin "1" (uuid "00000000-0000-0000-0000-0000000000p1"))
    (pin "2" (uuid "00000000-0000-0000-0000-0000000000p2"))
  )
  (symbol
    (lib_id "Device:CWIDE")
    (at 120 100 0)
    (unit 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp yes)
    (uuid "00000000-0000-0000-0000-0000000000c1")
    (property "Reference" "C1" (at 122 98 0) (effects (font (size 1.27 1.27))))
    (property "Value" "100n" (at 122 102 0) (effects (font (size 1.27 1.27))))
    (pin "1" (uuid "00000000-0000-0000-0000-0000000000p3"))
    (pin "2" (uuid "00000000-0000-0000-0000-0000000000p4"))
  )
  (symbol
    (lib_id "Device:RZERO")
    (at 140 100 0)
    (unit 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no)
    (uuid "00000000-0000-0000-0000-0000000000r2")
    (property "Reference" "R2" (at 142 98 0) (effects (font (size 1.27 1.27))))
    (property "Value" "1k" (at 142 102 0) (effects (font (size 1.27 1.27))))
    (pin "1" (uuid "00000000-0000-0000-0000-0000000000p5"))
    (pin "2" (uuid "00000000-0000-0000-0000-0000000000p6"))
  )
)
`;

function load(): KicadSch {
    return new KicadSch("dnp.kicad_sch", new SchematicParser().parse(FIXTURE));
}

function symbol_by_reference(sch: KicadSch, reference: string) {
    for (const symbol of sch.symbols.values()) {
        if (symbol.get_property_text("Reference") == reference) {
            return symbol;
        }
    }
    throw new Error(`no symbol ${reference} in the fixture`);
}

/** Paint one layer of the whole document and hand back what got drawn. */
function paint_layer(sch: KicadSch, layer_name: LayerNames) {
    const gfx = new NullRenderer();
    const layers = new LayerSet(theme);
    const painter = new SchematicPainter(gfx, layers, theme);

    painter.paint(sch);

    return layers.by_name(layer_name)!;
}

suite("schematic DNP markers", () => {
    test("measures a symbol whose graphics all use the default stroke width", () => {
        // The regression from issue #86: with the measuring renderer left at a
        // zero default stroke width these polylines were skipped outright and
        // the symbol measured as an empty box at the origin.
        const { body, body_and_pins } = measure_symbol_bboxes(
            theme,
            symbol_by_reference(load(), "R1"),
        );

        expect(body.valid).to.be.true;
        expect(body.w).to.be.greaterThan(1);
        expect(body.h).to.be.greaterThan(1);
        // Centred on the placement, not stranded at the sheet origin.
        expect(body.center.x).to.be.closeTo(100, 0.5);
        expect(body.center.y).to.be.closeTo(100, 0.5);

        // Pins stick out past the body top and bottom.
        expect(body_and_pins.h).to.be.greaterThan(body.h);
    });

    test("measures a symbol that declares explicit stroke widths", () => {
        const { body, body_and_pins } = measure_symbol_bboxes(
            theme,
            symbol_by_reference(load(), "C1"),
        );

        expect(body.valid).to.be.true;
        expect(body.center.x).to.be.closeTo(120, 0.5);
        expect(body_and_pins.h).to.be.greaterThan(body.h);
    });

    test("grows the marker box past the body the way KiCad does", () => {
        const body = new BBox(0, 0, 10, 4);
        const body_and_pins = new BBox(0, -3, 10, 10);

        const marker = dnp_marker_bbox(body, body_and_pins);

        // margin_x = max(0, 0) = 0, margin_y = max(3, 3) = 3
        // margin_x = max(0 * 0.6, 3 * 0.3) = 0.9
        // margin_y = max(3 * 0.6, 0.9 * 0.3) = 1.8
        expect(marker.x).to.be.closeTo(-0.9, 1e-9);
        expect(marker.y).to.be.closeTo(-1.8, 1e-9);
        expect(marker.w).to.be.closeTo(11.8, 1e-9);
        expect(marker.h).to.be.closeTo(7.6, 1e-9);
    });

    test("degenerate input never produces a cross at the origin", () => {
        const empty = new BBox(0, 0, 0, 0);
        expect(dnp_marker_bbox(empty, empty).valid).to.be.false;
    });

    test("only DNP items claim the marks layer", () => {
        const sch = load();
        const painter = new SchematicPainter(
            new NullRenderer(),
            new LayerSet(theme),
            theme,
        );

        const layers_for = (item: unknown) => painter.layers_for(item);

        expect(layers_for(symbol_by_reference(sch, "R1"))).to.include(
            LayerNames.marks,
        );
        expect(layers_for(symbol_by_reference(sch, "C1"))).to.include(
            LayerNames.marks,
        );
        expect(layers_for(symbol_by_reference(sch, "R2"))).to.not.include(
            LayerNames.marks,
        );
    });

    test("paints a cross over every DNP item and nothing else", () => {
        const sch = load();
        const marks = paint_layer(sch, LayerNames.marks);

        // Two DNP symbols, two diagonals each.
        const shapes = (marks.graphics as unknown as { shapes: unknown[] })
            .shapes;
        expect(shapes.length).to.equal(4);

        const boxes = [...marks.bboxes.entries()];
        expect(boxes.length).to.equal(2);

        for (const [item, bbox] of boxes) {
            expect(bbox.valid, `${item} has an empty marker`).to.be.true;
            expect(bbox.w).to.be.greaterThan(1);
            expect(bbox.h).to.be.greaterThan(1);
        }

        const r1 = marks.bboxes.get(symbol_by_reference(sch, "R1"))!;
        expect(r1.center.x).to.be.closeTo(100, 0.5);
        expect(r1.center.y).to.be.closeTo(100, 0.5);
    });
});

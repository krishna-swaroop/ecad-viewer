import { expect } from "@esm-bundle/chai";
import { BoardParser, SchematicParser } from "kicad-parser";

import { KicadPCB, KicadSch } from "../src/kicad";
import { PadPainter } from "../src/viewers/board/pad-painter";
import { LayerNames } from "../src/viewers/board/layers";

/**
 * Rendering fixes taken from upstream Huaqiu-Electronics/ecad-viewer.
 *
 * They are behavioural changes to what lands on which layer and to how big
 * a thing is measured, neither of which the suite covered.
 */

// No `(layers ...)` list, so the board falls back to DEFAULT_LAYERS.
const BOARD_WITHOUT_LAYERS = `
(kicad_pcb
  (version 20240108)
  (generator "pcbnew")
  (paper "A4")
  (footprint "R_0402"
    (layer "F.Cu")
    (at 10 10)
    (pad "1" smd roundrect (at 0 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask"))
  )
)
`;

function board(): KicadPCB {
    return new KicadPCB(
        "fixture.kicad_pcb",
        new BoardParser().parse(BOARD_WITHOUT_LAYERS) as never,
    );
}

suite("default layers for a board that declares none", () => {
    test("covers the non-copper layers KiCad footprints actually use", () => {
        // Only copper, silk, mask, fab and edge cuts used to be defaulted, so
        // anything on paste, adhesive, courtyard or a user layer had no layer
        // to be drawn on at all.
        const names = board().layers.map((layer) => layer.canonical_name);
        for (const expected of [
            LayerNames.f_paste,
            LayerNames.b_paste,
            LayerNames.f_adhes,
            LayerNames.b_adhes,
            LayerNames.f_crtyd,
            LayerNames.b_crtyd,
            LayerNames.margin,
            LayerNames.dwgs_user,
            LayerNames.cmts_user,
            LayerNames.eco1_user,
            LayerNames.eco2_user,
        ]) {
            expect(names, `missing ${expected}`).to.contain(expected);
        }
    });

    test("keeps the layers it already defaulted", () => {
        const names = board().layers.map((layer) => layer.canonical_name);
        for (const expected of [
            LayerNames.f_cu,
            LayerNames.b_cu,
            LayerNames.f_silks,
            LayerNames.b_silks,
            LayerNames.f_mask,
            LayerNames.b_mask,
            LayerNames.f_fab,
            LayerNames.b_fab,
            LayerNames.edge_cuts,
        ]) {
            expect(names, `missing ${expected}`).to.contain(expected);
        }
    });
});

suite("pad layer routing", () => {
    // `layers_for` reads nothing off the painter itself.
    const layers_for = (pad: unknown) =>
        PadPainter.prototype.layers_for.call({} as PadPainter, pad as never);

    test("a pad's non-copper apertures stay on their own layer", () => {
        // These fell through to a copper virtual layer, so a pad's mask and
        // paste apertures were drawn as if they were copper.
        const pad = {
            layers: [LayerNames.f_mask, LayerNames.f_paste],
            type: "smd",
        };
        const layers = layers_for(pad);
        expect(layers).to.contain(LayerNames.f_mask);
        expect(layers).to.contain(LayerNames.f_paste);
    });

    test("silkscreen and fabrication apertures stay on their own layer", () => {
        const pad = {
            layers: [LayerNames.f_silks, LayerNames.b_fab],
            type: "smd",
        };
        const layers = layers_for(pad);
        expect(layers).to.contain(LayerNames.f_silks);
        expect(layers).to.contain(LayerNames.b_fab);
    });

    test("copper still goes to the pad's copper virtual layer", () => {
        const layers = layers_for({ layers: [LayerNames.f_cu], type: "smd" });
        expect(layers.some((l) => l.includes(LayerNames.f_cu))).to.equal(true);
        expect(layers).to.not.contain(LayerNames.f_cu);
    });

    test("the wildcard spellings still expand to both sides", () => {
        const layers = layers_for({
            layers: ["*.Mask", "*.Paste"],
            type: "smd",
        });
        expect(layers).to.contain(LayerNames.f_mask);
        expect(layers).to.contain(LayerNames.b_mask);
        expect(layers).to.contain(LayerNames.f_paste);
        expect(layers).to.contain(LayerNames.b_paste);
    });
});

// A symbol whose single pin sticks 3.81mm out to the left of a 2.54mm-wide
// body, so a bbox that ignores pins is visibly narrower than one that does not.
const SCHEMATIC_WITH_A_PIN = `
(kicad_sch
  (version 20250114)
  (generator "eeschema")
  (uuid "00000000-0000-0000-0000-000000000010")
  (lib_symbols
    (symbol "Device:ONE"
      (pin_numbers (hide yes))
      (pin_names (offset 0.254) (hide yes))
      (exclude_from_sim no) (in_bom yes) (on_board yes)
      (symbol "ONE_1_1"
        (rectangle (start -1.27 -1.27) (end 1.27 1.27)
          (stroke (width 0.254) (type default)) (fill (type none)))
        (pin input line (at -5.08 0 0) (length 3.81)
          (name "A" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27)))))
      )
    )
  )
  (symbol
    (lib_id "Device:ONE") (at 100 100 0)
    (unit 1) (body_style 1)
    (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no)
    (uuid "00000000-0000-0000-0000-0000000000bb")
    (property "Reference" "U1" (at 102 96 0) (effects (font (size 1.27 1.27))))
    (property "Value" "ONE" (at 102 98 0) (effects (font (size 1.27 1.27))))
    (pin "1" (uuid "00000000-0000-0000-0000-000000000011"))
  )
)
`;

suite("symbol bounding box", () => {
    test("includes the pins that stick out of the body", () => {
        // Pins extend past the symbol body, so a bbox built from the body
        // alone made zoom-to-fit and clipping cut them off.
        const schematic = new KicadSch(
            "fixture.kicad_sch",
            new SchematicParser().parse(SCHEMATIC_WITH_A_PIN) as never,
        );
        const symbol = [...schematic.symbols.values()][0]!;
        expect(symbol, "fixture parsed no symbol").to.not.equal(undefined);

        const full = symbol.bbox;
        expect(full.valid).to.equal(true);

        // The pin is 3.81mm long and starts 5.08mm left of the symbol origin,
        // so the box has to reach x = 100 - 5.08. Without the pins it
        // collapsed to a 1mm box sitting on the Reference text at x = 102 --
        // the symbol's own geometry was not in its bounding box at all, which
        // is what made zoom-to-fit and clipping cut symbols off.
        expect(full.x).to.be.at.most(95);
        expect(full.w).to.be.greaterThan(8);
    });
});

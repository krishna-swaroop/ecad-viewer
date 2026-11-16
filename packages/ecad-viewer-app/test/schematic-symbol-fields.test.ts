import { expect } from "@esm-bundle/chai";
import { SchematicParser } from "kicad-parser";

import { NullRenderer } from "../src/graphics/null-renderer";
import { KicadSch } from "../src/kicad/schematic";
import { StrokeFont } from "../src/kicad/text";
import kicad_default_theme from "../src/kicanvas/themes/kicad-default";
import { LayerNames, LayerSet } from "../src/viewers/schematic/layers";
import { SchematicPainter } from "../src/viewers/schematic/painter";
import { apply_schematic_render_defaults } from "../src/viewers/schematic/render-state";

const SYMBOL_UUID = "00000000-0000-0000-0000-0000000000bb";

// An Altium import: the part number sits in a hidden Value and the value
// KiCad shows lives in a visible user field.
const IMPORTED = `
(kicad_sch
  (version 20260306)
  (generator "eeschema")
  (uuid "00000000-0000-0000-0000-000000000002")
  (lib_symbols
    (symbol "Device:R"
      (exclude_from_sim no) (in_bom yes) (on_board yes)
      (symbol "R_1_1"
        (rectangle (start -1.016 -2.54) (end 1.016 2.54)
          (stroke (width 0.254) (type default)) (fill (type none)))
      )
    )
  )
  (symbol
    (lib_id "Device:R") (at 100 100 0)
    (unit 1) (body_style 1)
    (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no)
    (uuid "${SYMBOL_UUID}")
    (property "Reference" "R98" (at 102 96 0)
      (show_name no) (do_not_autoplace no)
      (effects (font (size 1.27 1.27))))
    (property "Value" "RC0805FR-0747RL" (at 102 98 0)
      (hide yes) (show_name no) (do_not_autoplace no)
      (effects (font (size 1.27 1.27))))
    (property "Footprint" "Pkg:R_0805" (at 102 100 0)
      (effects (font (size 1.27 1.27)) (hide yes)))
    (property "ALTIUM_VALUE" "47" (at 102 102 0)
      (show_name no) (do_not_autoplace no)
      (effects (font (size 1.27 1.27))))
  )
)
`;

function painted_texts(): string[] {
    const schematic = new KicadSch(
        "imported.kicad_sch",
        new SchematicParser().parse(IMPORTED),
    );
    const symbol = schematic.symbols.get(SYMBOL_UUID)!;
    const font = StrokeFont.default();
    const original_draw = font.draw;
    const texts: string[] = [];
    font.draw = function (renderer, text, position, attributes) {
        texts.push(text);
        return original_draw.call(this, renderer, text, position, attributes);
    };
    try {
        const theme = kicad_default_theme.schematic;
        const renderer = new NullRenderer();
        apply_schematic_render_defaults(renderer, theme);
        const layers = new LayerSet(theme);
        const painter = new SchematicPainter(renderer, layers, theme);
        const layer = layers.by_name(LayerNames.symbol_field)!;
        layer.items.push(symbol);
        painter.paint_layer(layer);
        return texts;
    } finally {
        font.draw = original_draw;
    }
}

suite("schematic symbol fields", () => {
    test("draws every visible field, as KiCad does", () => {
        const texts = painted_texts();

        expect(texts).to.include("R98");
        expect(texts).to.include("47");
    });

    test("keeps hidden fields hidden", () => {
        const texts = painted_texts();

        expect(texts).not.to.include("RC0805FR-0747RL");
        expect(texts).not.to.include("Pkg:R_0805");
    });
});

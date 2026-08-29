import { expect } from "@esm-bundle/chai";
import { SchematicParser } from "kicad-parser";

import { Matrix3, Vec2 } from "../src/base/math";
import { KicadSch, PinInstance } from "../src/kicad/schematic";
import {
    get_symbol_transform,
    symbol_transform_matrix,
    try_symbol_transform_matrix,
} from "../src/kicad/symbol-transform";
import kicad_default_theme from "../src/kicanvas/themes/kicad-default";
import { LayerNames } from "../src/viewers/schematic/layers";
import { SchematicViewer } from "../src/viewers/schematic/viewer";

/**
 * One symbol transform, agreeing with what is painted.
 *
 * A library symbol is authored Y up and a schematic is drawn Y down. The model
 * used to build its own translate/rotate/mirror that omitted that flip, so
 * every model-space bbox was reflected about the placement origin relative to
 * the geometry on screen. Nothing caught it, because the parts the tests used
 * were symmetric about Y and the two answers happened to coincide.
 *
 * The part here is deliberately asymmetric -- pin 1 is 3.81 above the origin
 * and pin 2 is 1.27 below -- so a reflection moves a pin somewhere no pin is,
 * and it is placed at every rotation KiCad can store plus both mirrors.
 */

const UPRIGHT = "00000000-0000-0000-0000-0000000000a0";
const ROT_90 = "00000000-0000-0000-0000-0000000000a1";
const ROT_180 = "00000000-0000-0000-0000-0000000000a2";
const ROT_270 = "00000000-0000-0000-0000-0000000000a3";
const MIRROR_X = "00000000-0000-0000-0000-0000000000a4";
const MIRROR_Y = "00000000-0000-0000-0000-0000000000a5";

const PLACEMENTS: [string, string][] = [
    [UPRIGHT, "upright"],
    [ROT_90, "rotated 90"],
    [ROT_180, "rotated 180"],
    [ROT_270, "rotated 270"],
    [MIRROR_X, "mirrored about x"],
    [MIRROR_Y, "mirrored about y"],
];

const SCH = `
(kicad_sch
  (version 20250114)
  (generator "eeschema")
  (uuid "00000000-0000-0000-0000-000000000001")
  (lib_symbols
    (symbol "Device:Lopsided"
      (symbol "Lopsided_0_1"
        (rectangle (start -1.016 -1.27) (end 1.016 2.54)
          (stroke (width 0.254) (type default)) (fill (type none))))
      (symbol "Lopsided_1_1"
        (pin passive line (at 0 3.81 270) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27)))))
        (pin passive line (at 0 -1.27 90) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "2" (effects (font (size 1.27 1.27))))))))
  (symbol (lib_id "Device:Lopsided") (at 100 100 0) (unit 1)
    (uuid "${UPRIGHT}")
    (property "Reference" "R1" (at 103 99 0) (effects (font (size 1.27 1.27))))
    (pin "1" (uuid "00000000-0000-0000-0000-000000000011"))
    (pin "2" (uuid "00000000-0000-0000-0000-000000000012")))
  (symbol (lib_id "Device:Lopsided") (at 120 100 90) (unit 1)
    (uuid "${ROT_90}")
    (property "Reference" "R2" (at 123 99 0) (effects (font (size 1.27 1.27))))
    (pin "1" (uuid "00000000-0000-0000-0000-000000000021"))
    (pin "2" (uuid "00000000-0000-0000-0000-000000000022")))
  (symbol (lib_id "Device:Lopsided") (at 140 100 180) (unit 1)
    (uuid "${ROT_180}")
    (property "Reference" "R3" (at 143 99 0) (effects (font (size 1.27 1.27))))
    (pin "1" (uuid "00000000-0000-0000-0000-000000000031"))
    (pin "2" (uuid "00000000-0000-0000-0000-000000000032")))
  (symbol (lib_id "Device:Lopsided") (at 160 100 270) (unit 1)
    (uuid "${ROT_270}")
    (property "Reference" "R4" (at 163 99 0) (effects (font (size 1.27 1.27))))
    (pin "1" (uuid "00000000-0000-0000-0000-000000000041"))
    (pin "2" (uuid "00000000-0000-0000-0000-000000000042")))
  (symbol (lib_id "Device:Lopsided") (at 180 100 0) (mirror x) (unit 1)
    (uuid "${MIRROR_X}")
    (property "Reference" "R5" (at 183 99 0) (effects (font (size 1.27 1.27))))
    (pin "1" (uuid "00000000-0000-0000-0000-000000000051"))
    (pin "2" (uuid "00000000-0000-0000-0000-000000000052")))
  (symbol (lib_id "Device:Lopsided") (at 200 100 0) (mirror y) (unit 1)
    (uuid "${MIRROR_Y}")
    (property "Reference" "R6" (at 203 99 0) (effects (font (size 1.27 1.27))))
    (pin "1" (uuid "00000000-0000-0000-0000-000000000061"))
    (pin "2" (uuid "00000000-0000-0000-0000-000000000062")))
)
`;

suite("a placed symbol's transform", () => {
    let viewer: SchematicViewer;
    let sch: KicadSch;
    let canvas: HTMLCanvasElement;

    setup(async () => {
        sch = new KicadSch("t.kicad_sch", new SchematicParser().parse(SCH));
        canvas = document.createElement("canvas");
        canvas.style.width = "1200px";
        canvas.style.height = "600px";
        document.body.append(canvas);
        viewer = new SchematicViewer(
            canvas,
            true,
            kicad_default_theme.schematic,
        );
        await viewer.setup();
        await viewer.load(sch);
    });

    teardown(() => {
        viewer.dispose();
        canvas.remove();
    });

    const symbol_of = (uuid: string) => sch.symbols.get(uuid)!;
    const pin_of = (uuid: string, number: string) =>
        [...symbol_of(uuid).unit_pins].find((p) => p.number === number)!;
    const painted = (pin: PinInstance) =>
        viewer.layers.by_name(LayerNames.symbol_pin)!.bboxes.get(pin)!;

    test("the model's matrix is the one the painter applies", () => {
        // The painter draws body geometry under translation(position) times
        // the orientation matrix. Any other composition puts the model's
        // boxes somewhere the reader is not looking.
        for (const [uuid, label] of PLACEMENTS) {
            const symbol = symbol_of(uuid);
            const expected = Matrix3.translation(
                symbol.at.position.x,
                symbol.at.position.y,
            ).multiply(get_symbol_transform(symbol).matrix);

            for (const [i, value] of symbol_transform_matrix(
                symbol,
            ).elements.entries()) {
                expect(value, `${label} element ${i}`).to.be.closeTo(
                    expected.elements[i]!,
                    1e-9,
                );
            }
        }
    });

    test("a pin's model bbox lands on the pin as drawn", () => {
        // This is the assertion the old transform failed: with the Y flip
        // missing, pin 1's model box sat where nothing is drawn, and on a
        // Y-symmetric part it sat on pin 2.
        for (const [uuid, label] of PLACEMENTS) {
            for (const number of ["1", "2"]) {
                const pin = pin_of(uuid, number);
                const drawn = painted(pin);
                expect(
                    pin.bbox.center.x,
                    `${label} pin ${number} x`,
                ).to.be.closeTo(drawn.center.x, 0.05);
                expect(
                    pin.bbox.center.y,
                    `${label} pin ${number} y`,
                ).to.be.closeTo(drawn.center.y, 0.05);
            }
        }
    });

    test("a pin's model bbox picks back as that same pin", () => {
        for (const [uuid, label] of PLACEMENTS) {
            for (const number of ["1", "2"]) {
                const pin = pin_of(uuid, number);
                expect(
                    viewer.find_item(pin.bbox.center).item,
                    `${label} pin ${number}`,
                ).to.equal(pin);
            }
        }
    });

    test("a symbol's bbox covers what it draws", () => {
        // SchematicSymbol.bbox drives zoom-to-item. A reflected box is the
        // right size and the wrong place, so containment is the check.
        for (const [uuid, label] of PLACEMENTS) {
            const bbox = symbol_of(uuid).bbox;
            for (const number of ["1", "2"]) {
                const drawn = painted(pin_of(uuid, number));
                expect(
                    bbox.contains_point(drawn.center),
                    `${label} contains pin ${number}`,
                ).to.equal(true);
            }
        }
    });

    test("an out-of-spec rotation degrades instead of throwing", () => {
        // A hand-edited file can carry a rotation KiCad never writes. A bbox
        // is asked for while painting; throwing there takes down the document.
        const bad = { at: { position: new Vec2(10, 20), rotation: 45 } };
        expect(() => symbol_transform_matrix(bad)).to.throw();
        const fallback = try_symbol_transform_matrix(bad);
        expect(fallback.elements[6]).to.equal(10);
        expect(fallback.elements[7]).to.equal(20);
    });
});

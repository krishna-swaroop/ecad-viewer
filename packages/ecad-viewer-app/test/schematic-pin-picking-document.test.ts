import { expect } from "@esm-bundle/chai";
import { SchematicParser } from "kicad-parser";

import { Vec2 } from "../src/base/math";
import { normalize_schematic_selection } from "../src/ecad-viewer/host-adapter";
import {
    DefaultValues,
    KicadSch,
    PinInstance,
    SchematicSymbol,
    Wire,
} from "../src/kicad/schematic";
import kicad_default_theme from "../src/kicanvas/themes/kicad-default";
import { LayerNames } from "../src/viewers/schematic/layers";
import { SchematicViewer } from "../src/viewers/schematic/viewer";

/**
 * Picking a pin in a whole schematic, rather than a one-symbol preview.
 *
 * The pin grab margin is set on a layer every schematic paints, so it changes
 * what a click selects in the semantic visualizer and the comparison views,
 * not only in a library preview. What has to keep holding: a wire still wins
 * over a pin it lands on, a symbol is still selectable, and a placement's
 * rotation or mirroring moves its pins' targets with it.
 */

const R1 = "00000000-0000-0000-0000-0000000000aa";
const R2 = "00000000-0000-0000-0000-0000000000bb";
const R3 = "00000000-0000-0000-0000-0000000000cc";

// R1 sits under a wire that runs down into its pin 1; R2 is rotated 90 degrees
// and R3 is mirrored, so their pins are transformed away from the authored
// library positions.
const SCH = `
(kicad_sch
  (version 20250114)
  (generator "eeschema")
  (uuid "00000000-0000-0000-0000-000000000001")
  (lib_symbols
    (symbol "Device:R"
      (symbol "R_0_1"
        (rectangle (start -1.016 -2.54) (end 1.016 2.54)
          (stroke (width 0.254) (type default)) (fill (type none))))
      (symbol "R_1_1"
        (pin passive line (at 0 3.81 270) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27)))))
        (pin passive line (at 0 -3.81 90) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "2" (effects (font (size 1.27 1.27))))))))
  (wire (pts (xy 100 88.9) (xy 100 96.52))
    (stroke (width 0) (type default))
    (uuid "00000000-0000-0000-0000-0000000000d1"))
  (symbol (lib_id "Device:R") (at 100 100 0) (unit 1)
    (uuid "${R1}")
    (property "Reference" "R1" (at 103 99 0) (effects (font (size 1.27 1.27))))
    (pin "1" (uuid "00000000-0000-0000-0000-000000000011"))
    (pin "2" (uuid "00000000-0000-0000-0000-000000000012")))
  (symbol (lib_id "Device:R") (at 120 100 90) (unit 1)
    (uuid "${R2}")
    (property "Reference" "R2" (at 123 99 0) (effects (font (size 1.27 1.27))))
    (pin "1" (uuid "00000000-0000-0000-0000-000000000021"))
    (pin "2" (uuid "00000000-0000-0000-0000-000000000022")))
  (symbol (lib_id "Device:R") (at 140 100 0) (mirror y) (unit 1)
    (uuid "${R3}")
    (property "Reference" "R3" (at 143 99 0) (effects (font (size 1.27 1.27))))
    (pin "1" (uuid "00000000-0000-0000-0000-000000000031"))
    (pin "2" (uuid "00000000-0000-0000-0000-000000000032")))
)
`;

const MARGIN = DefaultValues.target_pin_radius;

suite("picking a pin in a schematic", () => {
    let viewer: SchematicViewer;
    let sch: KicadSch;
    let canvas: HTMLCanvasElement;

    setup(async () => {
        sch = new KicadSch("t.kicad_sch", new SchematicParser().parse(SCH));
        canvas = document.createElement("canvas");
        canvas.style.width = "800px";
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

    const pin_of = (uuid: string, number: string) =>
        [...sch.symbols.get(uuid)!.unit_pins].find((p) => p.number === number)!;

    const painted = (pin: PinInstance) =>
        viewer.layers.by_name(LayerNames.symbol_pin)!.bboxes.get(pin)!;

    const pick = (x: number, y: number) =>
        viewer.find_item(new Vec2(x, y)).item;

    test("a placement's rotation carries its pins' targets with it", () => {
        // The authored pins run vertically. R2 is placed at 90 degrees, so a
        // correctly transformed target is wider than it is tall, and the grab
        // margin has to follow the painted geometry rather than the library's.
        const upright = painted(pin_of(R1, "1"));
        const rotated = painted(pin_of(R2, "1"));
        expect(upright.h).to.be.greaterThan(upright.w);
        expect(rotated.w).to.be.greaterThan(rotated.h);

        for (const [uuid, number] of [
            [R1, "1"],
            [R1, "2"],
            [R2, "1"],
            [R2, "2"],
            [R3, "1"],
            [R3, "2"],
        ] as const) {
            const pin = pin_of(uuid, number);
            const box = painted(pin);
            // Off the stroke by most of the margin, along the stem's short
            // axis -- a miss without the margin, whichever way the pin points.
            const off =
                box.w < box.h
                    ? new Vec2(
                          box.center.x + box.w / 2 + MARGIN * 0.75,
                          box.center.y,
                      )
                    : new Vec2(
                          box.center.x,
                          box.center.y + box.h / 2 + MARGIN * 0.75,
                      );
            expect(
                viewer.find_item(off).item,
                `${uuid} pin ${number}`,
            ).to.equal(pin);
        }
    });

    test("a wire crossing a pin's grab margin still selects the wire", () => {
        // The wire ends on pin 1 of R1, so its last stretch lies inside that
        // pin's margin. Wires are searched before pins, and net selection in
        // the host depends on that staying true.
        const box = painted(pin_of(R1, "1"));
        const just_above = box.y - MARGIN * 0.5;
        expect(pick(box.center.x, just_above)).to.be.instanceOf(Wire);

        // ... and further up the wire, clear of the pin entirely.
        expect(pick(box.center.x, box.y - 4)).to.be.instanceOf(Wire);
    });

    test("the symbol body away from its pins still selects the symbol", () => {
        const symbol = sch.symbols.get(R1)!;
        expect(pick(101, 100)).to.equal(symbol);
        expect(pick(120, 100)).to.equal(sch.symbols.get(R2)!);
        expect(pick(140, 100)).to.equal(sch.symbols.get(R3)!);
    });

    test("the margin claims a thin band where a pin meets the body", () => {
        // This is the one selection the margin moves: a click just past the
        // end of the drawn stem, still inside the symbol's box, now reports
        // the pin instead of the symbol. That matches KiCad, where the pin
        // owns that region, and it is what makes a pin worth aiming at.
        const pin = pin_of(R1, "1");
        const box = painted(pin);
        const body = viewer.layers
            .by_name(LayerNames.interactive)!
            .bboxes.get(sch.symbols.get(R1)!)!;

        const just_below_stem = box.y + box.h + MARGIN * 0.5;
        expect(just_below_stem).to.be.greaterThan(body.y);
        expect(pick(box.center.x, just_below_stem)).to.equal(pin);

        // The band is only as deep as the margin; past it the body wins again.
        expect(pick(box.center.x, box.y + box.h + MARGIN * 2)).to.equal(
            sch.symbols.get(R1)!,
        );
    });

    test("a picked pin reaches the host as a pin selection", () => {
        const pin = pin_of(R2, "2");
        const box = painted(pin);
        const hit = pick(
            box.center.x,
            box.center.y + box.h / 2 + MARGIN * 0.75,
        );
        expect(hit).to.equal(pin);

        const detail = normalize_schematic_selection(
            hit,
            sch,
            viewer.instance_context,
        );
        expect(detail?.itemType).to.equal("pin");
        expect(detail?.pin).to.equal("2");
        expect(detail?.reference).to.equal("R2");
    });

    test("empty space selects nothing", () => {
        expect(pick(160, 130)).to.equal(null);
    });

    test("symbols and pins are distinct picks", () => {
        const symbol = sch.symbols.get(R1)!;
        expect(symbol).to.be.instanceOf(SchematicSymbol);
        expect(pin_of(R1, "1")).to.be.instanceOf(PinInstance);
    });
});

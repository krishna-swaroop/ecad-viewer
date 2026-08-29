import { expect } from "@esm-bundle/chai";

import { parseSymbolLibrary, renderSymbol } from "../../ecad-renderer/src";
import { BBox, Vec2 } from "../src/base/math";
import { DefaultValues, PinInstance } from "../src/kicad/schematic";
import { Pad } from "../src/kicad/board";
import { LayerNames } from "../src/viewers/schematic/layers";

/**
 * Picking a symbol pin.
 *
 * A pin's painted geometry is a single stroked line, so the bounding box the
 * paint pass records for it is only as wide as that stroke -- under four
 * screen pixels on a fitted library preview. Hit-testing straight against it
 * meant a pin was selectable only on its exact centreline, and a near miss
 * selected nothing at all, because the pin sticks out beyond the symbol body
 * that would otherwise have caught the click.
 *
 * Cross-probing a pin to its pad is the reason any of this exists, so these
 * cover the grab margin that makes a pin a realistic click target, and the
 * identity a host needs to match a pin against a pad.
 */

const SYMBOL_LIB = `
(kicad_symbol_lib
  (version 20231120)
  (generator "kicad_symbol_editor")
  (symbol "R_Small"
    (property "Reference" "R" (at 0.762 0.508 0))
    (property "Value" "R_Small" (at 0.762 -1.016 0))
    (symbol "R_Small_0_1"
      (rectangle (start -0.762 1.778) (end 0.762 -1.778))
    )
    (symbol "R_Small_1_1"
      (pin passive line (at 0 2.54 270) (length 0.762)
        (name "A" (effects (font (size 1.27 1.27))))
        (number "1" (effects (font (size 1.27 1.27)))))
      (pin passive line (at 0 -2.54 90) (length 0.762)
        (name "B" (effects (font (size 1.27 1.27))))
        (number "2" (effects (font (size 1.27 1.27)))))
    )
  )
)
`;

function sized_container(): HTMLElement {
    const container = document.createElement("div");
    container.style.width = "400px";
    container.style.height = "300px";
    document.body.append(container);
    const canvas = document.createElement("canvas");
    canvas.style.width = "400px";
    canvas.style.height = "300px";
    container.append(canvas);
    return container;
}

interface ProbeViewer {
    layers: {
        by_name(name: string): {
            bbox: { x: number; y: number; w: number; h: number };
            bboxes: Map<unknown, { center: Vec2; w: number; h: number }>;
        } | null;
        bbox: { x: number; y: number; w: number; h: number };
    };
    document: { symbols: Map<string, { unit_pins: PinInstance[] }> };
    find_item(pos: Vec2): { item: unknown };
    probe_bounds(index: string): BBox[];
}

async function render_resistor(cleanup: Array<() => void>) {
    const container = sized_container();
    const [resistor] = parseSymbolLibrary(SYMBOL_LIB);
    const result = await renderSymbol(resistor!, {
        canvas: container.firstElementChild as HTMLCanvasElement,
        interactive: true,
    });
    cleanup.push(() => {
        result.dispose();
        container.remove();
    });
    const viewer = result.viewer as unknown as ProbeViewer;
    const placed = [...viewer.document.symbols.values()][0]!;
    return { viewer, placed };
}

suite("picking a symbol pin", () => {
    const cleanup: Array<() => void> = [];
    teardown(() => {
        while (cleanup.length) cleanup.pop()!();
    });

    test("a click on the pin's centreline finds the pin", async () => {
        const { viewer, placed } = await render_resistor(cleanup);
        const pin = placed.unit_pins.find((p) => p.number === "1")!;
        const painted = viewer.layers
            .by_name(LayerNames.symbol_pin)!
            .bboxes.get(pin)!;

        const hit = viewer.find_item(painted.center);
        expect(hit.item).to.equal(pin);
    });

    test("a click a grab margin off the pin still finds it", async () => {
        // The painted box is one stroke wide, so without a margin every
        // offset here misses the pin -- and misses the symbol too, because
        // the pin hangs outside the body.
        const { viewer, placed } = await render_resistor(cleanup);
        const pin = placed.unit_pins.find((p) => p.number === "1")!;
        const painted = viewer.layers
            .by_name(LayerNames.symbol_pin)!
            .bboxes.get(pin)!;

        // Just inside the margin on each side of the stroke, and just past
        // the stem's free end.
        const dx = painted.w / 2 + DefaultValues.target_pin_radius * 0.75;
        const dy = painted.h / 2 + DefaultValues.target_pin_radius * 0.75;
        for (const [ox, oy] of [
            [dx, 0],
            [-dx, 0],
            [0, dy],
            [0, -dy],
        ] as const) {
            const at = new Vec2(painted.center.x + ox, painted.center.y + oy);
            expect(viewer.find_item(at).item, `offset ${ox},${oy}`).to.equal(
                pin,
            );
        }
    });

    test("the margin does not reach arbitrarily far from the pin", async () => {
        // A grab margin that swallowed the whole neighbourhood would make
        // every click near a symbol select a pin.
        const { viewer, placed } = await render_resistor(cleanup);
        const pin = placed.unit_pins.find((p) => p.number === "1")!;
        const painted = viewer.layers
            .by_name(LayerNames.symbol_pin)!
            .bboxes.get(pin)!;

        const far = painted.w / 2 + DefaultValues.target_pin_radius * 4;
        const at = new Vec2(painted.center.x + far, painted.center.y);
        expect(viewer.find_item(at).item).to.not.equal(pin);
    });

    test("each pin picks out as itself", async () => {
        const { viewer, placed } = await render_resistor(cleanup);
        const layer = viewer.layers.by_name(LayerNames.symbol_pin)!;
        for (const pin of placed.unit_pins) {
            const painted = layer.bboxes.get(pin)!;
            expect(
                viewer.find_item(painted.center).item,
                `pin ${pin.number}`,
            ).to.equal(pin);
        }
        expect(placed.unit_pins.map((p) => p.number)).to.deep.equal(["1", "2"]);
    });

    test("a pin's probe highlight lands on the pin that was picked", async () => {
        // The model's own pin bbox is reflected about the placement origin
        // relative to the painted one, which on this part swaps the two pins.
        // A highlight drawn there marks the wrong pin, or empty space.
        const { viewer, placed } = await render_resistor(cleanup);
        const layer = viewer.layers.by_name(LayerNames.symbol_pin)!;
        for (const pin of placed.unit_pins) {
            const painted = layer.bboxes.get(pin)!;
            const bounds = viewer.probe_bounds(pin.index);
            expect(bounds.length, `pin ${pin.number}`).to.equal(1);
            expect(bounds[0]!.center.x, `pin ${pin.number} x`).to.be.closeTo(
                painted.center.x,
                1e-6,
            );
            expect(bounds[0]!.center.y, `pin ${pin.number} y`).to.be.closeTo(
                painted.center.y,
                1e-6,
            );
            expect(
                viewer.find_item(bounds[0]!.center).item,
                `pin ${pin.number} picks back`,
            ).to.equal(pin);
        }
    });

    test("the symbol body is still selectable", async () => {
        // Pins are searched before the symbol, so an over-wide pin margin
        // would take clicks that belong to the body.
        const { viewer } = await render_resistor(cleanup);
        const hit = viewer.find_item(new Vec2(0, 0));
        expect(hit.item).to.not.equal(null);
        expect(hit.item).to.not.be.instanceOf(PinInstance);
    });

    test("the grab margin is not painted into the fitted view", async () => {
        // The margin is a picking allowance, not geometry. Folding it into
        // the layer's bbox would pull zoom-to-fit out on every preview.
        const { viewer, placed } = await render_resistor(cleanup);
        const layer = viewer.layers.by_name(LayerNames.symbol_pin)!;
        const stroke_widths = placed.unit_pins.map(
            (pin) => layer.bboxes.get(pin)!.w,
        );
        for (const w of stroke_widths) {
            expect(w).to.be.lessThan(DefaultValues.target_pin_radius);
        }
        expect(layer.bbox.w).to.be.lessThan(DefaultValues.target_pin_radius);
    });
});

suite("matching a pin to a pad", () => {
    test("a pin's cross index is the pad it probes to, and vice versa", () => {
        // Pad already carries the mirrored pair. PinInstance is what the
        // schematic hit-test hands back, so it needs the same two keys for a
        // host to match one against the other without knowing either type.
        const pin = Object.create(PinInstance.prototype) as PinInstance;
        (pin as { number: string }).number = "7";
        const pad = Object.create(Pad.prototype) as Pad;
        (pad as { number: string }).number = "7";

        expect(pin.index).to.equal("symbol_pin_7");
        expect(pin.cross_index).to.equal("pad_7");
        expect(pad.index).to.equal("pad_7");
        expect(pad.cross_index).to.equal("symbol_pin_7");
        expect(pin.cross_index).to.equal(pad.index);
        expect(pad.cross_index).to.equal(pin.index);
    });
});

import { expect } from "@esm-bundle/chai";

import { parseSymbolLibrary, renderSymbol } from "../../ecad-renderer/src";
import { Vec2 } from "../src/base/math";
import { PinInstance } from "../src/kicad/schematic";
import { LayerNames } from "../src/viewers/schematic/layers";

/**
 * Rebuilding the hover overlay.
 *
 * `on_hover` runs once per animation frame for as long as the pointer is
 * moving. Rebuilding the overlay layer there means re-recording the highlight
 * and re-drawing the whole display list, so a pointer crossing a large sheet
 * replayed every symbol, wire and pin at ~60fps while nothing about the view
 * had changed. The board viewer has always skipped that when the item under
 * the cursor is unchanged; these cover the same guard on schematics.
 *
 * The assertions are on the identity of the overlay's RenderLayer, because
 * that object is replaced exactly when the highlight is rebuilt.
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

interface HoverViewer {
    layers: {
        by_name(name: string): {
            bboxes: Map<unknown, { center: Vec2; w: number; h: number }>;
        } | null;
        overlay: { graphics?: unknown };
    };
    document: { symbols: Map<string, { unit_pins: PinInstance[] }> };
    on_hover(pos: Vec2): void;
    find_item(pos: Vec2): { item: unknown };
}

async function render_resistor(cleanup: Array<() => void>) {
    const container = document.createElement("div");
    container.style.width = "400px";
    container.style.height = "300px";
    document.body.append(container);
    const canvas = document.createElement("canvas");
    canvas.style.width = "400px";
    canvas.style.height = "300px";
    container.append(canvas);

    const [resistor] = parseSymbolLibrary(SYMBOL_LIB);
    const result = await renderSymbol(resistor!, {
        canvas,
        selectable: true,
    });
    cleanup.push(() => {
        result.dispose();
        container.remove();
    });
    const viewer = result.viewer as unknown as HoverViewer;
    const placed = [...viewer.document.symbols.values()][0]!;
    return { viewer, placed };
}

suite("hover overlay rebuilds", () => {
    const cleanup: Array<() => void> = [];
    teardown(() => {
        while (cleanup.length) cleanup.pop()!();
    });

    test("hovering a pin builds the highlight", async () => {
        const { viewer, placed } = await render_resistor(cleanup);
        const pin = placed.unit_pins.find((p) => p.number === "1")!;
        const painted = viewer.layers
            .by_name(LayerNames.symbol_pin)!
            .bboxes.get(pin)!;

        viewer.on_hover(painted.center);
        expect(viewer.layers.overlay.graphics).to.not.equal(undefined);
    });

    test("moving within the same pin does not rebuild it", async () => {
        const { viewer, placed } = await render_resistor(cleanup);
        const pin = placed.unit_pins.find((p) => p.number === "1")!;
        const painted = viewer.layers
            .by_name(LayerNames.symbol_pin)!
            .bboxes.get(pin)!;

        viewer.on_hover(painted.center);
        const built = viewer.layers.overlay.graphics;
        expect(built).to.not.equal(undefined);

        // A few sub-pixel steps, all still resolving to the same pin. This is
        // what a pointer crossing one item actually produces.
        for (const dy of [0.01, 0.02, 0.03, -0.01]) {
            const at = new Vec2(painted.center.x, painted.center.y + dy);
            expect(
                viewer.find_item(at).item,
                `still pin 1 at dy=${dy}`,
            ).to.equal(pin);
            viewer.on_hover(at);
            expect(
                viewer.layers.overlay.graphics,
                `overlay rebuilt at dy=${dy}`,
            ).to.equal(built);
        }
    });

    test("moving onto a different pin does rebuild it", async () => {
        const { viewer, placed } = await render_resistor(cleanup);
        const layer = viewer.layers.by_name(LayerNames.symbol_pin)!;
        const one = placed.unit_pins.find((p) => p.number === "1")!;
        const two = placed.unit_pins.find((p) => p.number === "2")!;

        viewer.on_hover(layer.bboxes.get(one)!.center);
        const first = viewer.layers.overlay.graphics;

        viewer.on_hover(layer.bboxes.get(two)!.center);
        expect(viewer.layers.overlay.graphics).to.not.equal(first);
    });

    test("moving off every item clears the highlight", async () => {
        const { viewer, placed } = await render_resistor(cleanup);
        const pin = placed.unit_pins.find((p) => p.number === "1")!;
        const painted = viewer.layers
            .by_name(LayerNames.symbol_pin)!
            .bboxes.get(pin)!;

        viewer.on_hover(painted.center);
        expect(viewer.layers.overlay.graphics).to.not.equal(undefined);

        // Far outside the symbol, and outside any grab margin.
        const away = new Vec2(painted.center.x + 500, painted.center.y + 500);
        expect(viewer.find_item(away).item).to.equal(null);
        viewer.on_hover(away);
        expect(viewer.layers.overlay.graphics).to.equal(undefined);
    });
});

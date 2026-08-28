import { expect } from "@esm-bundle/chai";
import {
    parseFootprint,
    parseSymbolLibrary,
    renderFootprint,
    renderSymbol,
} from "../../ecad-renderer/src";
import { LayerNames } from "../src/viewers/schematic/layers";

/**
 * The renderer draws a library symbol or footprint POD on its own, reusing the
 * schematic and board painters. These tests cover the two things that are easy
 * to get silently wrong: the pin instances a symbol placement needs, and the
 * worksheet frame that must not be drawn around a standalone asset.
 */

const SYMBOL_LIB = `
(kicad_symbol_lib
  (version 20231120)
  (generator "kicad_symbol_editor")
  (symbol "R_Small"
    (pin_numbers hide)
    (pin_names (offset 0.254) hide)
    (in_bom yes)
    (on_board yes)
    (property "Reference" "R" (at 0.762 0.508 0))
    (property "Value" "R_Small" (at 0.762 -1.016 0))
    (symbol "R_Small_0_1"
      (rectangle (start -0.762 1.778) (end 0.762 -1.778))
    )
    (symbol "R_Small_1_1"
      (pin passive line (at 0 2.54 270) (length 0.762)
        (name "~" (effects (font (size 1.27 1.27))))
        (number "1" (effects (font (size 1.27 1.27)))))
      (pin passive line (at 0 -2.54 90) (length 0.762)
        (name "~" (effects (font (size 1.27 1.27))))
        (number "2" (effects (font (size 1.27 1.27)))))
    )
  )
  (symbol "C_Small"
    (property "Reference" "C" (at 0.762 0.508 0))
    (symbol "C_Small_0_1"
      (rectangle (start -1.0 0.5) (end 1.0 -0.5))
    )
  )
)
`;

const FOOTPRINT = `
(footprint "R_0603"
  (version 20240108)
  (generator "pcbnew")
  (layer "F.Cu")
  (attr smd)
  (fp_text reference "REF**" (at 0 -1.43) (layer "F.SilkS")
    (effects (font (size 0.8 0.8) (thickness 0.12))))
  (fp_line (start -1.48 -0.73) (end 1.48 -0.73)
    (stroke (width 0.05) (type solid)) (layer "F.CrtYd"))
  (pad "1" smd roundrect (at -0.7875 0) (size 0.875 0.95)
    (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25))
  (pad "2" smd roundrect (at 0.7875 0) (size 0.875 0.95)
    (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25))
)
`;

/**
 * A canvas with no layout size gives the viewport a zero-sized camera, and
 * every bbox assertion below would read zero regardless of what was painted.
 */
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

suite("parsing a library file", () => {
    // These go through the renderer's own exports rather than the parser
    // classes: that is the surface a host actually consumes, and it is
    // what the built bundle exposes.
    test("reads every symbol in a .kicad_sym", () => {
        const symbols = parseSymbolLibrary(SYMBOL_LIB);
        expect(symbols.length).to.equal(2);
        expect(symbols.map((s) => s.name)).to.deep.equal([
            "R_Small",
            "C_Small",
        ]);
    });

    test("keeps a symbol's per-unit children and their pins", () => {
        const [resistor] = parseSymbolLibrary(SYMBOL_LIB);
        const unit = resistor!.children?.find((c) => c.name.endsWith("_1_1"));
        expect(unit?.pins?.map((p) => p.number?.text)).to.deep.equal([
            "1",
            "2",
        ]);
    });

    test("reads a standalone .kicad_mod", () => {
        const footprint = parseFootprint(FOOTPRINT);
        expect(footprint.library_link).to.equal("R_0603");
        expect(footprint.pads?.map((p) => p.number)).to.deep.equal(["1", "2"]);
    });
});

suite("rendering a library asset", () => {
    const cleanup: Array<() => void> = [];
    teardown(() => {
        while (cleanup.length) cleanup.pop()!();
    });

    test("renders a symbol and paints its pins", async () => {
        const container = sized_container();
        const [resistor] = parseSymbolLibrary(SYMBOL_LIB);
        const result = await renderSymbol(resistor!, {
            canvas: container.firstElementChild as HTMLCanvasElement,
        });
        cleanup.push(() => {
            result.dispose();
            container.remove();
        });

        // The trap this guards: a placement carries pin *instances*, and the
        // painter resolves each one's graphics through lib_symbol.pin_by_number.
        // Build the placement without them and the body still draws, so only a
        // pin-layer assertion catches it.
        const viewer = result.viewer as {
            layers: { by_name(name: string): { bbox: { w: number } } | null };
        };
        const pins = viewer.layers.by_name(LayerNames.symbol_pin);
        expect(pins, "symbol pin layer").to.not.equal(null);
        expect(pins!.bbox.w).to.be.greaterThan(0);
    });

    test("renders a footprint", async () => {
        const container = sized_container();
        const result = await renderFootprint(parseFootprint(FOOTPRINT), {
            canvas: container.firstElementChild as HTMLCanvasElement,
        });
        cleanup.push(() => {
            result.dispose();
            container.remove();
        });
        expect(result.canvas.width).to.be.greaterThan(0);
    });

    test("draws no worksheet frame around a standalone asset", async () => {
        const container = sized_container();
        const [resistor] = parseSymbolLibrary(SYMBOL_LIB);
        const result = await renderSymbol(resistor!, {
            canvas: container.firstElementChild as HTMLCanvasElement,
        });
        cleanup.push(() => {
            result.dispose();
            container.remove();
        });

        // An A4 frame is far larger than a resistor, so if it were painted the
        // sheet layer would carry it and zoom-to-fit would pull out to the page.
        const viewer = result.viewer as {
            show_drawing_sheet: boolean;
            layers: { by_name(name: string): { bbox: { w: number } } | null };
        };
        expect(viewer.show_drawing_sheet).to.equal(false);
        const sheet = viewer.layers.by_name(LayerNames.drawing_sheet);
        expect(sheet?.bbox.w ?? 0).to.equal(0);
    });
});

import { expect } from "@esm-bundle/chai";
import {
    parseFootprint,
    parseSymbolLibrary,
    renderFootprint,
    renderSymbol,
} from "../../ecad-renderer/src";
import { LayerNames } from "../src/viewers/schematic/layers";
import type { ProbeEvent } from "../../ecad-renderer/src/types";

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

const DUAL_UNIT_LIB = `
(kicad_symbol_lib
  (version 20231120)
  (generator "kicad_symbol_editor")
  (symbol "Opamp_Dual"
    (property "Reference" "U" (at 0 0 0))
    (symbol "Opamp_Dual_1_1"
      (rectangle (start -2.54 2.54) (end 2.54 -2.54))
      (pin input line (at -5.08 2.54 0) (length 2.54)
        (name "A" (effects (font (size 1.27 1.27))))
        (number "1" (effects (font (size 1.27 1.27)))))
    )
    (symbol "Opamp_Dual_2_1"
      (rectangle (start -2.54 2.54) (end 2.54 -2.54))
      (pin input line (at -5.08 2.54 0) (length 2.54)
        (name "B" (effects (font (size 1.27 1.27))))
        (number "5" (effects (font (size 1.27 1.27)))))
      (pin input line (at -5.08 -2.54 0) (length 2.54)
        (name "C" (effects (font (size 1.27 1.27))))
        (number "6" (effects (font (size 1.27 1.27)))))
    )
  )
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

    test("renders the requested unit of a multi-unit symbol", async () => {
        // Unit 1 owns one pin and unit 2 owns two. Rendering unit 2 while
        // collecting unit 1's pins would draw the wrong part of the package,
        // which is exactly what the per-unit preview tabs exist to show.
        const [opamp] = parseSymbolLibrary(DUAL_UNIT_LIB);
        const counts: number[] = [];
        for (const unit of [1, 2]) {
            const container = sized_container();
            const result = await renderSymbol(opamp!, {
                canvas: container.firstElementChild as HTMLCanvasElement,
                unit,
            });
            cleanup.push(() => {
                result.dispose();
                container.remove();
            });
            const viewer = result.viewer as {
                document: { symbols: Map<string, { unit_pins: unknown[] }> };
            };
            const placed = [...viewer.document.symbols.values()][0]!;
            counts.push(placed.unit_pins.length);
        }
        expect(counts).to.deep.equal([1, 2]);
    });

    test("defaults to unit 1 and ignores a nonsense unit", async () => {
        const [opamp] = parseSymbolLibrary(DUAL_UNIT_LIB);
        for (const unit of [undefined, 0, -3]) {
            const container = sized_container();
            const result = await renderSymbol(opamp!, {
                canvas: container.firstElementChild as HTMLCanvasElement,
                unit,
            });
            cleanup.push(() => {
                result.dispose();
                container.remove();
            });
            const viewer = result.viewer as {
                document: { symbols: Map<string, { unit_pins: unknown[] }> };
            };
            const placed = [...viewer.document.symbols.values()][0]!;
            expect(placed.unit_pins.length, `unit ${unit}`).to.equal(1);
        }
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

    test("a render is static unless each gesture is asked for", async () => {
        // There is deliberately no single "interactive" switch: an embedded
        // preview lives in a scrolling column and must leave the wheel alone,
        // while an expanded one takes it. A host that names one gesture gets
        // that gesture and nothing else.
        const [resistor] = parseSymbolLibrary(SYMBOL_LIB);
        const cases = [
            {
                options: {},
                expected: {
                    selectable: false,
                    navigation: {
                        wheel: "disabled",
                        pinch: false,
                        touchPan: false,
                        drag: false,
                    },
                },
            },
            {
                options: { selectable: true },
                expected: {
                    selectable: true,
                    navigation: {
                        wheel: "disabled",
                        pinch: false,
                        touchPan: false,
                        drag: false,
                    },
                },
            },
            {
                options: {
                    selectable: true,
                    navigation: { wheel: "modifier" as const, drag: true },
                },
                expected: {
                    selectable: true,
                    navigation: {
                        wheel: "modifier",
                        pinch: false,
                        touchPan: false,
                        drag: true,
                    },
                },
            },
        ];

        for (const entry of cases) {
            const container = sized_container();
            const result = await renderSymbol(resistor!, {
                canvas: container.firstElementChild as HTMLCanvasElement,
                ...entry.options,
            });
            cleanup.push(() => {
                result.dispose();
                container.remove();
            });
            const viewer = result.viewer as unknown as {
                interaction: {
                    selectable: boolean;
                    navigation: {
                        wheel: string;
                        pinch: boolean;
                        touchPan: boolean;
                        drag: boolean;
                    };
                };
            };
            expect(viewer.interaction).to.deep.equal(entry.expected);
        }
    });

    test("exposes camera controls and structured pin probe events", async () => {
        const container = sized_container();
        const [resistor] = parseSymbolLibrary(SYMBOL_LIB);
        const probes: ProbeEvent[] = [];
        const result = await renderSymbol(resistor!, {
            canvas: container.firstElementChild as HTMLCanvasElement,
            selectable: true,
            navigation: {
                wheel: "modifier",
                pinch: false,
                touchPan: false,
            },
            onProbe: (probe) => probes.push(probe),
        });
        cleanup.push(() => {
            result.dispose();
            container.remove();
        });

        const viewer = result.viewer as {
            viewport: { camera: { zoom: number } };
            document: {
                symbols: Map<
                    string,
                    {
                        unit_pins: Array<{
                            number: string;
                            index: string;
                            cross_index: string;
                            bbox: { center: unknown };
                        }>;
                    }
                >;
            };
            on_hover(position: unknown): void;
            on_click(position: unknown): void;
        };
        const pin = [...viewer.document.symbols.values()][0]!.unit_pins[0]!;
        const initial_zoom = viewer.viewport.camera.zoom;
        result.controller.zoomBy(2);
        expect(viewer.viewport.camera.zoom).to.be.greaterThan(initial_zoom);
        result.controller.zoomBy(Number.POSITIVE_INFINITY);
        expect(viewer.viewport.camera.zoom).to.be.lessThanOrEqual(190);
        result.controller.zoomBy(1e9);
        expect(viewer.viewport.camera.zoom).to.equal(190);
        result.controller.zoomBy(1e-9);
        expect(viewer.viewport.camera.zoom).to.equal(0.5);
        result.controller.resetView();

        viewer.on_hover(pin.bbox.center);
        viewer.on_click(pin.bbox.center);
        result.canvas.dispatchEvent(new MouseEvent("mouseleave"));

        expect(probes.map((probe) => probe.phase)).to.deep.equal([
            "hover",
            "activate",
            "leave",
        ]);
        const hovered = probes[0] as Exclude<ProbeEvent, { phase: "clear" }>;
        expect(hovered.source).to.equal("pin");
        expect(hovered.index).to.equal(`symbol_pin_${hovered.number}`);
        expect(hovered.crossIndex).to.equal(`pad_${hovered.number}`);
        expect(
            result.controller.setProbeHighlight(hovered.index, "hover"),
        ).to.equal(1);
        result.controller.clearProbeHighlight();
    });

    test("probes standalone pads and highlights every duplicate number", async () => {
        const container = sized_container();
        const probes: ProbeEvent[] = [];
        const duplicate = FOOTPRINT.replace('(pad "2"', '(pad "1"');
        const result = await renderFootprint(parseFootprint(duplicate), {
            canvas: container.firstElementChild as HTMLCanvasElement,
            selectable: true,
            onProbe: (probe) => probes.push(probe),
        });
        cleanup.push(() => {
            result.dispose();
            container.remove();
        });

        const viewer = result.viewer as {
            board: {
                footprints: Array<{
                    pads: Array<{ bbox: { center: unknown } }>;
                }>;
            };
            on_hover(position: unknown): void;
            on_click(position: unknown): void;
        };
        const pad = viewer.board.footprints[0]!.pads[0]!;
        viewer.on_hover(pad.bbox.center);
        viewer.on_click(pad.bbox.center);

        expect(probes[0]).to.include({
            phase: "hover",
            source: "pad",
            number: "1",
            index: "pad_1",
            crossIndex: "symbol_pin_1",
        });
        expect(
            result.controller.setProbeHighlight("pad_1", "latched"),
        ).to.equal(2);
    });

    test("does not replay a queued pin hover after mouseleave", async () => {
        const container = sized_container();
        const [resistor] = parseSymbolLibrary(SYMBOL_LIB);
        const probes: ProbeEvent[] = [];
        const result = await renderSymbol(resistor!, {
            canvas: container.firstElementChild as HTMLCanvasElement,
            selectable: true,
            onProbe: (probe) => probes.push(probe),
        });
        cleanup.push(() => {
            result.dispose();
            container.remove();
        });

        const viewer = result.viewer as {
            viewport: {
                camera: {
                    world_to_screen(position: unknown): {
                        x: number;
                        y: number;
                    };
                };
            };
            document: {
                symbols: Map<
                    string,
                    { unit_pins: Array<{ bbox: { center: unknown } }> }
                >;
            };
        };
        const pin = [...viewer.document.symbols.values()][0]!.unit_pins[0]!;
        const screen = viewer.viewport.camera.world_to_screen(pin.bbox.center);
        const rect = result.canvas.getBoundingClientRect();
        result.canvas.dispatchEvent(
            new MouseEvent("mousemove", {
                clientX: rect.left + screen.x,
                clientY: rect.top + screen.y,
            }),
        );
        result.canvas.dispatchEvent(new MouseEvent("mouseleave"));
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
        );

        expect(probes).to.deep.equal([]);
    });

    test("rejects empty pad numbers as probe sources", async () => {
        const container = sized_container();
        const probes: ProbeEvent[] = [];
        const empty_number = FOOTPRINT.replace('(pad "1"', '(pad ""');
        const result = await renderFootprint(parseFootprint(empty_number), {
            canvas: container.firstElementChild as HTMLCanvasElement,
            selectable: true,
            onProbe: (probe) => probes.push(probe),
        });
        cleanup.push(() => {
            result.dispose();
            container.remove();
        });

        const viewer = result.viewer as {
            board: {
                footprints: Array<{
                    pads: Array<{ bbox: { center: unknown } }>;
                }>;
            };
            on_hover(position: unknown): void;
            on_click(position: unknown): void;
        };
        const pad = viewer.board.footprints[0]!.pads[0]!;
        viewer.on_hover(pad.bbox.center);
        viewer.on_click(pad.bbox.center);

        expect(probes).to.deep.equal([{ phase: "clear" }]);
    });
});

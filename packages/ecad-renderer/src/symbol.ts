import type { schematicProto } from "kicad-parser";

import { renderSchematic } from "./render";
import type { RenderOptions, RenderResult } from "./types";

/**
 * KiCad keeps a symbol's body graphics and pins on per-unit child symbols named
 * `..._{unit}_{style}`; the root symbol rarely owns pins itself. Walk the root
 * and its descendants for every pin that applies to the requested unit -- the
 * common pins (unit 0) plus that unit's own.
 */
function collect_unit_pins(
    symbol: schematicProto.I_LibSymbol,
    wanted_unit: number,
): schematicProto.I_Pin[] {
    const result: schematicProto.I_Pin[] = [];

    function unit_style_of(name: string): { unit: number; style: number } {
        const match = /(\d+)_(\d+)$/.exec(name);
        if (match) return { unit: Number(match[1]), style: Number(match[2]) };
        return { unit: 0, style: 0 };
    }

    function visit(sym: schematicProto.I_LibSymbol, is_root: boolean) {
        // Unit 0 is common to every unit, style 0 to every style; the
        // requested unit and style 1 match the instance below.
        const { unit, style } = is_root
            ? { unit: 0, style: 0 }
            : unit_style_of(sym.name);
        if (
            (unit === 0 || unit === wanted_unit) &&
            (style === 0 || style === 1)
        ) {
            for (const pin of sym.pins ?? []) result.push(pin);
        }
        for (const child of sym.children ?? []) visit(child, false);
    }

    visit(symbol, true);
    return result;
}

/**
 * Render one library symbol through the existing schematic painter.
 *
 * `I_LibSymbol` is the parser's POD for library content, but the painter draws
 * a placed `SchematicSymbol`. So the smallest such placement is built at the
 * origin with the supplied symbol as its library source: an adapter, not a
 * second model.
 *
 * The pin instances matter. The painter walks `unit_pins` and resolves each
 * one's graphical definition through `lib_symbol.pin_by_number`, so a placement
 * with no pin instances draws the body alone and fits to it -- which reads as a
 * symbol whose pins have vanished.
 */
export function renderSymbol(
    symbol: schematicProto.I_LibSymbol,
    options: RenderOptions = {},
): Promise<RenderResult> {
    // A unit below 1 is not a KiCad unit; treat it as the default rather than
    // silently rendering a symbol with no unit-specific graphics at all.
    const unit = Math.max(1, Math.trunc(options.unit ?? 1));
    const pins: schematicProto.I_PinInstance[] = collect_unit_pins(
        symbol,
        unit,
    ).map((pin, index) => ({
        number: pin.number?.text ?? String(index + 1),
        uuid: `ecad-renderer-pin-${index}-${pin.number?.text ?? index}`,
        alternate: "",
    }));

    return renderSchematic(
        {
            version: 20231120,
            uuid: "ecad-renderer-symbol",
            generator_version: "ecad-renderer",
            lib_symbols: [symbol],
            symbols: [
                {
                    uuid: "ecad-renderer-symbol-instance",
                    lib_id: symbol.name,
                    at: { position: { x: 0, y: 0 }, rotation: 0 },
                    unit,
                    convert: 1,
                    in_bom: symbol.in_bom ?? false,
                    on_board: symbol.on_board ?? false,
                    dnp: false,
                    fields_autoplaced: false,
                    properties: symbol.properties ?? [],
                    pins,
                    exclude_from_sim: symbol.exclude_from_sim ?? false,
                    instances: { projects: [] },
                },
            ],
            wires: [],
            buses: [],
            bus_entries: [],
            bus_aliases: [],
            junctions: [],
            net_labels: [],
            global_labels: [],
            hierarchical_labels: [],
            no_connects: [],
            drawings: [],
            images: [],
            tables: [],
            sheets: [],
        } as unknown as schematicProto.I_KicadSch,
        options,
    );
}

import type { BBox } from "../../base/math";
import type { KicadSch } from "../../kicad/schematic";
import type {
    EcadOverlayPrimitive,
    EcadOverlayScene,
} from "../base/overlay-scene";

/**
 * One highlighted net, as the host knows it: the items it owns on each sheet
 * instance. The viewer has no netlist of its own, so membership comes from the
 * host (Prism's semantic index lists a net's wires, labels, junctions, sheet
 * entries and pins per sheet instance).
 */
export type SchematicNetMembers = {
    name: string;
    /** CSS colour of the overlay; a bright default when absent. */
    color?: string;
    pages: Array<{ sheetPath: string; uuids: string[] }>;
};

export const NET_HIGHLIGHT_CHANNEL = "schematic-net-highlight";

/** Document layers are drawn at this opacity under a net highlight. */
export const NET_HIGHLIGHT_DIM = 0.3;

const DEFAULT_COLORS = ["#ffb020", "#22d3ee", "#f472b6", "#a3e635", "#c084fc"];

/** The colour of the n-th highlighted net, unless the host gave one. */
export function net_color(net: SchematicNetMembers, index: number): string {
    return net.color ?? DEFAULT_COLORS[index % DEFAULT_COLORS.length]!;
}

/** The uuids each net owns on one sheet instance. */
export function members_on_page(
    nets: readonly SchematicNetMembers[],
    sheet_path: string,
): Array<{ net: SchematicNetMembers; index: number; uuids: Set<string> }> {
    const found = [];
    for (const [index, net] of nets.entries()) {
        const uuids = new Set<string>();
        for (const page of net.pages) {
            if (page.sheetPath !== sheet_path) continue;
            for (const uuid of page.uuids) uuids.add(uuid);
        }
        if (uuids.size) found.push({ net, index, uuids });
    }
    return found;
}

/**
 * The overlay that paints each net's members on the open sheet: wires as
 * thick strokes over a soft glow, junctions as dots, and everything else
 * (labels, sheet entries, pins) as a filled outline of its painted bounds.
 */
export function net_highlight_scene(
    nets: readonly SchematicNetMembers[],
    sheet_path: string,
    document: KicadSch,
    item_bbox: (uuid: string) => BBox | undefined,
): EcadOverlayScene {
    const primitives: EcadOverlayPrimitive[] = [];
    const origin = { kind: "world" as const, x: 0, y: 0 };
    for (const { net, index, uuids } of members_on_page(nets, sheet_path)) {
        const color = net_color(net, index);
        const seen = new Set<string>();
        for (const wire of document.wires) {
            if (!uuids.has(wire.uuid) || wire.pts.length < 2) continue;
            seen.add(wire.uuid);
            const points = wire.pts.map(
                (pt) => [pt.x, pt.y] as [number, number],
            );
            primitives.push(
                {
                    id: `glow:${wire.uuid}`,
                    kind: "polyline",
                    anchor: origin,
                    points,
                    stroke: color,
                    strokeWidth: 1.2,
                    opacity: 0.25,
                },
                {
                    id: `wire:${wire.uuid}`,
                    kind: "polyline",
                    anchor: origin,
                    points,
                    stroke: color,
                    strokeWidth: 0.35,
                },
            );
        }
        for (const junction of document.junctions) {
            if (!uuids.has(junction.uuid)) continue;
            seen.add(junction.uuid);
            const at = junction.at.position;
            primitives.push({
                id: `junction:${junction.uuid}`,
                kind: "marker",
                anchor: { kind: "world", x: at.x, y: at.y },
                radius: 0.6,
                fill: color,
            });
        }
        for (const uuid of uuids) {
            if (seen.has(uuid)) continue;
            const bounds = item_bbox(uuid);
            if (!bounds) continue;
            primitives.push({
                id: `item:${uuid}`,
                kind: "bbox",
                anchor: {
                    kind: "bbox",
                    bounds: [bounds.x, bounds.y, bounds.w, bounds.h],
                },
                padding: 0.25,
                stroke: color,
                fill: color,
                strokeWidth: 0.25,
                opacity: 0.45,
            });
        }
    }
    return {
        channelId: NET_HIGHLIGHT_CHANNEL,
        context: "SCH",
        placement: "foreground",
        visible: primitives.length > 0,
        primitives,
    };
}

import type { BBox } from "../../base/math";
import { NetLabel, type KicadSch } from "../../kicad/schematic";
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
    /** 1 when a net was just highlighted, easing to 0: a brighter, wider glow. */
    flash = 0,
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
                    strokeWidth: 1.2 + 2.4 * flash,
                    opacity: 0.25 + 0.4 * flash,
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
        // Local labels of one name join on their own sheet: a dashed line
        // from each to the next, so a net carried by labels reads as one.
        const locals = new Map<string, BBox[]>();
        for (const label of document.labels) {
            if (!(label instanceof NetLabel) || !label.uuid) continue;
            if (!uuids.has(label.uuid)) continue;
            const box = item_bbox(label.uuid);
            if (!box) continue;
            const group = locals.get(label.text) ?? [];
            group.push(box);
            locals.set(label.text, group);
        }
        for (const [name, boxes] of locals) {
            boxes.sort((a, b) => a.x - b.x || a.y - b.y);
            for (let i = 1; i < boxes.length; i++) {
                const a = boxes[i - 1]!.center;
                const b = boxes[i]!.center;
                primitives.push({
                    id: `local:${name}:${i}`,
                    kind: "polyline",
                    anchor: origin,
                    points: [
                        [a.x, a.y],
                        [b.x, b.y],
                    ],
                    stroke: color,
                    strokeWidth: 0.3,
                    dash: [1.5, 1],
                    opacity: 0.9,
                });
            }
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

export const LOCAL_TRACE_CHANNEL = "schematic-local-trace";

/**
 * The open sheet's local labels named `name`, joined in a chain: each label
 * outlined with a glow, and a dashed line from each to the next.
 */
export function local_trace_scene(
    name: string,
    document: KicadSch,
    item_bbox: (uuid: string) => BBox | undefined,
    color = DEFAULT_COLORS[0]!,
): EcadOverlayScene {
    const boxes: BBox[] = [];
    for (const label of document.labels) {
        if (!(label instanceof NetLabel) || label.text !== name || !label.uuid)
            continue;
        const box = item_bbox(label.uuid);
        if (box) boxes.push(box);
    }
    boxes.sort((a, b) => a.x - b.x || a.y - b.y);
    const primitives: EcadOverlayPrimitive[] = [];
    const origin = { kind: "world" as const, x: 0, y: 0 };
    boxes.forEach((box, i) => {
        primitives.push({
            id: `label:${i}`,
            kind: "bbox",
            anchor: { kind: "bbox", bounds: [box.x, box.y, box.w, box.h] },
            padding: 0.4,
            stroke: color,
            fill: color,
            strokeWidth: 0.3,
            opacity: 0.45,
        });
        if (!i) return;
        const a = boxes[i - 1]!.center;
        const b = box.center;
        const points: Array<[number, number]> = [
            [a.x, a.y],
            [b.x, b.y],
        ];
        primitives.push(
            {
                id: `glow:${i}`,
                kind: "polyline",
                anchor: origin,
                points,
                stroke: color,
                strokeWidth: 1.4,
                opacity: 0.2,
            },
            {
                id: `line:${i}`,
                kind: "polyline",
                anchor: origin,
                points,
                stroke: color,
                strokeWidth: 0.35,
                dash: [1.5, 1],
            },
        );
    });
    return {
        channelId: LOCAL_TRACE_CHANNEL,
        context: "SCH",
        placement: "foreground",
        visible: primitives.length > 0,
        primitives,
    };
}

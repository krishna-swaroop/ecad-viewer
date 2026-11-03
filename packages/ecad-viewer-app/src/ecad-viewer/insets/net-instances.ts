/*
    Where a schematic label leads: the other places its net shows up.

    A global label leads to every global label of the same name on every
    sheet instance. A hierarchical label leads up, to the entry on the sheet
    symbol that instantiates its page; an entry leads down, to the matching
    hierarchical label inside each page it instantiates. A local label leads
    to the labels of the same name on its own page.

    Names only: the viewer has no netlist. A host with one can refine this.
*/

import { Vec2 } from "../../base/math";
import {
    GlobalLabel,
    HierarchicalLabel,
    NetLabel,
    type KicadSch,
} from "../../kicad/schematic";

export interface NetInstancePage {
    key: string;
    name: string;
    document: KicadSch;
    /** The page this one was instantiated from, and by which sheet symbol. */
    parent_key?: string;
    sheet_uuid?: string;
    /** The instance path (`/root/sheet`), as hosts name sheets in net members. */
    sheet_path?: string;
}

export type NetInstanceKind = "global" | "hierarchical" | "sheet-pin" | "local";

export interface NetInstance {
    page: string;
    uuid: string;
    name: string;
    kind: NetInstanceKind;
}

/** What the label `uuid` on page `page_key` is, if it is one. */
export function net_instance_at(
    pages: readonly NetInstancePage[],
    page_key: string,
    uuid: string,
): NetInstance | null {
    const page = pages.find((candidate) => candidate.key === page_key);
    if (!page) return null;
    for (const label of page.document.labels) {
        if (label.uuid !== uuid) continue;
        const kind: NetInstanceKind | null =
            label instanceof GlobalLabel
                ? "global"
                : label instanceof HierarchicalLabel
                  ? "hierarchical"
                  : label instanceof NetLabel
                    ? "local"
                    : null;
        return kind ? { page: page_key, uuid, name: label.text, kind } : null;
    }
    for (const sheet of page.document.sheets) {
        for (const pin of sheet.pins) {
            if (pin.uuid === uuid)
                return {
                    page: page_key,
                    uuid,
                    name: pin.name,
                    kind: "sheet-pin",
                };
        }
    }
    return null;
}

/** The other instances `from` connects to, nearest hop only. */
export function net_instances(
    pages: readonly NetInstancePage[],
    from: NetInstance,
): NetInstance[] {
    const found: NetInstance[] = [];
    const page = pages.find((candidate) => candidate.key === from.page);
    if (!page) return found;
    const labels = (
        candidate: NetInstancePage,
        type: typeof GlobalLabel | typeof HierarchicalLabel | typeof NetLabel,
    ) =>
        candidate.document.labels.filter(
            (label) => label instanceof type && label.text === from.name,
        );

    if (from.kind === "global") {
        for (const candidate of pages)
            for (const label of labels(candidate, GlobalLabel))
                if (
                    label.uuid &&
                    !(candidate.key === from.page && label.uuid === from.uuid)
                )
                    found.push({
                        page: candidate.key,
                        uuid: label.uuid,
                        name: label.text,
                        kind: "global",
                    });
    } else if (from.kind === "hierarchical") {
        const parent = pages.find(
            (candidate) => candidate.key === page.parent_key,
        );
        const sheet = parent?.document.sheets.find(
            (candidate) => candidate.uuid === page.sheet_uuid,
        );
        for (const pin of sheet?.pins ?? [])
            if (pin.name === from.name && pin.uuid)
                found.push({
                    page: parent!.key,
                    uuid: pin.uuid,
                    name: pin.name,
                    kind: "sheet-pin",
                });
    } else if (from.kind === "sheet-pin") {
        const sheet = page.document.sheets.find((candidate) =>
            candidate.pins.some((pin) => pin.uuid === from.uuid),
        );
        for (const child of pages) {
            if (
                child.parent_key !== page.key ||
                child.sheet_uuid !== sheet?.uuid
            )
                continue;
            for (const label of labels(child, HierarchicalLabel))
                if (label.uuid)
                    found.push({
                        page: child.key,
                        uuid: label.uuid,
                        name: label.text,
                        kind: "hierarchical",
                    });
        }
    } else {
        for (const label of labels(page, NetLabel))
            if (label.uuid && label.uuid !== from.uuid)
                found.push({
                    page: page.key,
                    uuid: label.uuid,
                    name: label.text,
                    kind: "local",
                });
    }
    return found;
}

/** A label's whole reach across sheets: every instance and the hops between. */
export interface NetClosure {
    instances: NetInstance[];
    /** Each hop, from the side nearer the starting label to the farther. */
    links: Array<[NetInstance, NetInstance]>;
    /** Hops from the starting label, by `page#uuid`. */
    depth: Map<string, number>;
}

export const instance_key = (it: NetInstance) => `${it.page}#${it.uuid}`;

/**
 * Follow `from` across sheets until nothing new turns up: global labels by
 * name, sheet entries down and hierarchical labels up. Every link points
 * away from `from`. Global labels of one name fan out from the first of
 * them reached, so a click on one shows a line to each of the others.
 */
export function net_closure(
    pages: readonly NetInstancePage[],
    from: NetInstance,
): NetClosure {
    const key = instance_key;
    const found = new Map<string, NetInstance>([[key(from), from]]);
    const depth = new Map<string, number>([[key(from), 0]]);
    const links: Array<[NetInstance, NetInstance]> = [];
    const linked = new Set<string>();
    const queue = [from];
    while (queue.length) {
        const at = queue.shift()!;
        // The same sheet's wires carry the net to other labels and entries;
        // that hop is not drawn and does not count as a step away.
        for (const other of wired_instances(pages, at)) {
            if (found.has(key(other))) continue;
            found.set(key(other), other);
            depth.set(key(other), depth.get(key(at))!);
            queue.unshift(other);
        }
        if (at.kind === "local") continue;
        for (const other of net_instances(pages, at)) {
            const id = [key(at), key(other)].sort().join("|");
            if (found.has(key(other))) continue;
            found.set(key(other), other);
            depth.set(key(other), depth.get(key(at))! + 1);
            queue.push(other);
            if (!linked.has(id)) {
                linked.add(id);
                links.push([at, other]);
            }
        }
    }
    return { instances: [...found.values()], links, depth };
}

const EPS = 0.01;

const on_segment = (p: Vec2, a: Vec2, b: Vec2) => {
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (Math.abs(cross) > EPS * Math.max(1, a.sub(b).magnitude)) return false;
    return (
        p.x >= Math.min(a.x, b.x) - EPS &&
        p.x <= Math.max(a.x, b.x) + EPS &&
        p.y >= Math.min(a.y, b.y) - EPS &&
        p.y <= Math.max(a.y, b.y) + EPS
    );
};

/**
 * The labels and sheet entries on `at`'s own sheet that wires join it to:
 * wires touching end to end, or an end on another's run, form one net.
 */
export function wired_instances(
    pages: readonly NetInstancePage[],
    at: NetInstance,
): NetInstance[] {
    const page = pages.find((candidate) => candidate.key === at.page);
    if (!page) return [];
    const doc = page.document;
    const points: Array<{ instance: NetInstance; at: Vec2 }> = [];
    for (const label of doc.labels) {
        if (!label.uuid) continue;
        const found = net_instance_at(pages, page.key, label.uuid);
        if (found) points.push({ instance: found, at: label.at.position });
    }
    for (const sheet of doc.sheets)
        for (const pin of sheet.pins)
            if (pin.uuid)
                points.push({
                    instance: {
                        page: page.key,
                        uuid: pin.uuid,
                        name: pin.name,
                        kind: "sheet-pin",
                    },
                    at: pin.at.position,
                });
    const start = points.find((point) => point.instance.uuid === at.uuid);
    if (!start) return [];
    const segments = doc.wires.flatMap((wire) =>
        wire.pts.slice(1).map((end, i) => [wire.pts[i]!, end] as const),
    );
    const touches = (p: Vec2, [a, b]: readonly [Vec2, Vec2]) =>
        on_segment(p, a, b);
    const reached = new Set<number>();
    const queue: number[] = [];
    segments.forEach((segment, i) => {
        if (touches(start.at, segment)) {
            reached.add(i);
            queue.push(i);
        }
    });
    while (queue.length) {
        const [a, b] = segments[queue.shift()!]!;
        segments.forEach((segment, i) => {
            if (reached.has(i)) return;
            const [c, d] = segment;
            if (
                touches(c, [a, b]) ||
                touches(d, [a, b]) ||
                touches(a, segment) ||
                touches(b, segment)
            ) {
                reached.add(i);
                queue.push(i);
            }
        });
    }
    return points
        .filter(
            (point) =>
                point.instance.uuid !== at.uuid &&
                [...reached].some((i) => touches(point.at, segments[i]!)),
        )
        .map((point) => point.instance);
}

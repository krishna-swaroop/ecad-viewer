/*
    Where a schematic label leads: the other places its net shows up.

    A global label leads to every global label of the same name on every
    sheet instance. A hierarchical label leads up, to the entry on the sheet
    symbol that instantiates its page; an entry leads down, to the matching
    hierarchical label inside each page it instantiates. A local label leads
    to the labels of the same name on its own page.

    Names only: the viewer has no netlist. A host with one can refine this.
*/

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

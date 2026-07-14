import {
    Footprint,
    LineSegment,
    Pad,
    Via,
    Zone,
    type KicadPCB,
} from "../kicad/board";
import {
    GlobalLabel,
    HierarchicalLabel,
    Junction,
    Label,
    NoConnect,
    PinInstance,
    SchematicSheet,
    SchematicSheetPin,
    SchematicSymbol,
    Wire,
    type KicadSch,
} from "../kicad/schematic";
import type { EcadBlob } from "../kicanvas/services/vfs";
import type { EcadOverlayScene } from "../viewers/base/overlay-scene";

export type EcadHostContext = "SCH" | "PCB" | "3D" | "BOM";

export type EcadSemanticSelectionDetail = {
    sourceContext: "SCH" | "PCB";
    itemType: string;
    uuid?: string;
    reference?: string;
    pin?: string;
    net?: string;
    netCode?: number;
    sheet?: string;
    page?: string;
    layer?: string;
    /** World-space center point of the selected item, when resolvable. */
    x?: number;
    y?: number;
    /** World-space bounding box [x, y, w, h] of the selected item. */
    bounds?: [number, number, number, number];
};

export type EcadSourceUpdate = {
    revisionKey: string;
    sources: EcadBlob[];
};

export type EcadCrossProbeRequest = {
    sourceContext: EcadHostContext;
    targetContext?: EcadHostContext;
    mode: "hover" | "select" | "focus";
    kind: "designator" | "net" | "crossIndex" | "uuid";
    value: string;
    sheet?: string;
    page?: string;
    designator?: string;
    net?: string;
    netCode?: number;
    crossIndex?: string;
    uuid?: string;
    pin?: string;
};

export type EcadOverlaySceneInput = Omit<EcadOverlayScene, "channelId"> & {
    channelId?: string;
};

export class EcadSemanticSelectionEvent extends CustomEvent<EcadSemanticSelectionDetail> {
    static readonly type = "ecad-viewer:selection";

    constructor(detail: EcadSemanticSelectionDetail) {
        super(EcadSemanticSelectionEvent.type, {
            detail,
            bubbles: true,
            composed: true,
        });
    }
}

const source_uuid = (item: object): string | undefined => {
    if ("uuid" in item && typeof item.uuid === "string" && item.uuid) {
        return item.uuid;
    }
    if ("tstamp" in item && typeof item.tstamp === "string" && item.tstamp) {
        return item.tstamp;
    }
    return undefined;
};

export function normalize_schematic_selection(
    item: unknown,
    schematic: KicadSch,
): EcadSemanticSelectionDetail | null {
    if (!item || typeof item !== "object") return null;
    const base = {
        sourceContext: "SCH" as const,
        uuid: source_uuid(item),
        sheet: schematic.filename,
        page: schematic.filename,
    };
    if (item instanceof SchematicSymbol) {
        return { ...base, itemType: "symbol", reference: item.reference };
    }
    if (item instanceof PinInstance) {
        return {
            ...base,
            itemType: "pin",
            reference: item.parent.reference,
            pin: item.number,
        };
    }
    if (item instanceof Wire) return { ...base, itemType: "wire" };
    if (item instanceof GlobalLabel) {
        return { ...base, itemType: "global-label", net: item.text };
    }
    if (item instanceof HierarchicalLabel) {
        return { ...base, itemType: "hierarchical-label", net: item.text };
    }
    if (item instanceof Label) {
        return { ...base, itemType: "label", net: item.text };
    }
    if (item instanceof Junction) return { ...base, itemType: "junction" };
    if (item instanceof NoConnect) return { ...base, itemType: "no-connect" };
    if (item instanceof SchematicSheetPin) {
        return { ...base, itemType: "sheet-pin", net: item.name };
    }
    if (item instanceof SchematicSheet) {
        return { ...base, itemType: "sheet", page: item.sheetfile };
    }
    return { ...base, itemType: item.constructor.name || "schematic-item" };
}

export function normalize_board_selection(
    item: unknown,
    board: KicadPCB,
): EcadSemanticSelectionDetail | null {
    if (!item || typeof item !== "object") return null;
    const uuid = source_uuid(item);
    if (
        "net" in item &&
        typeof item.net === "string" &&
        item.net.trim()
    ) {
        return {
            sourceContext: "PCB",
            itemType: "net",
            net: item.net,
            netCode:
                "number" in item && typeof item.number === "number"
                    ? item.number
                    : undefined,
            page: board.filename,
        };
    }
    if (item instanceof Footprint) {
        return {
            sourceContext: "PCB",
            itemType: "footprint",
            uuid,
            reference: item.reference,
            layer: item.layer,
            page: board.filename,
        };
    }
    if (item instanceof Pad) {
        return {
            sourceContext: "PCB",
            itemType: "pad",
            uuid,
            reference: item.parent.reference,
            pin: item.number,
            net: item.net?.name,
            netCode: item.net?.number,
            layer: item.layers.join(","),
            page: board.filename,
        };
    }
    if (item instanceof LineSegment || item instanceof Via) {
        return {
            sourceContext: "PCB",
            itemType: item instanceof Via ? "via" : "track",
            uuid,
            net: board.getNetName(item.net),
            netCode: item.net,
            layer: item instanceof Via ? item.layers.join(",") : item.layer,
            page: board.filename,
        };
    }
    if (item instanceof Zone) {
        return {
            sourceContext: "PCB",
            itemType: "zone",
            uuid,
            net: item.net_name || board.getNetName(item.net),
            netCode: item.net,
            layer: item.layers.join(","),
            page: board.filename,
        };
    }
    return {
        sourceContext: "PCB",
        itemType:
            "typeId" in item && typeof item.typeId === "string"
                ? item.typeId
                : item.constructor.name || "pcb-item",
        uuid,
        page: board.filename,
    };
}

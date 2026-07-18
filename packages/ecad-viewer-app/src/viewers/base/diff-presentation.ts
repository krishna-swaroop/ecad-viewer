import { Color } from "../../base/color";
import type {
    EcadDocumentDiffIndex,
    EcadIndexedChange,
} from "../../ecad-viewer/document-diff";
import type { PaintableDocument } from "./painter";

export type EcadDiffPaintStatus =
    | "unchanged"
    | "added"
    | "removed"
    | "modified"
    | "conflict";

export type EcadDiffResolutionDiagnostic = {
    changeId: string;
    sourceId?: string;
    side: "reference" | "comparison";
    reason: "missing-source-id" | "item-not-found";
};

export type EcadDiffPresentation = {
    signature: string;
    statusByItem: ReadonlyMap<object, EcadDiffPaintStatus>;
    removedItems: readonly object[];
    diagnostics: readonly EcadDiffResolutionDiagnostic[];
};

type SourceIndex = Map<string, object[]>;

const STATUS_COLORS: Record<
    Exclude<EcadDiffPaintStatus, "unchanged">,
    Color
> = {
    added: Color.from_css("#33994d"),
    removed: Color.from_css("#cc3333"),
    modified: Color.from_css("#d9a619"),
    conflict: Color.from_css("#a633b3"),
};

const NEUTRAL = Color.from_css("#737373");

export function source_id_of(item: unknown): string | undefined {
    if (!item || typeof item !== "object") return undefined;
    if ("uuid" in item && typeof item.uuid === "string" && item.uuid) {
        return item.uuid;
    }
    if ("tstamp" in item && typeof item.tstamp === "string" && item.tstamp) {
        return item.tstamp;
    }
    return undefined;
}

function add_index(map: SourceIndex, id: string, item: object): void {
    const values = map.get(id) ?? [];
    values.push(item);
    map.set(id, values);
}

/**
 * Index top-level paint items and nested item containers. Footprints expose
 * pads/graphics through items(); schematic symbols expose children through
 * the painter and inherit their parent's status when not directly indexed.
 */
export function index_paint_items(document: PaintableDocument): SourceIndex {
    const index: SourceIndex = new Map();
    const visited = new Set<object>();

    const visit = (item: unknown) => {
        if (!item || typeof item !== "object" || visited.has(item)) return;
        visited.add(item);
        const id = source_id_of(item);
        if (id) add_index(index, id, item);

        if (
            "items" in item &&
            typeof (item as { items?: unknown }).items === "function"
        ) {
            for (const child of (
                item as { items(): Iterable<unknown> }
            ).items()) {
                visit(child);
            }
        }
    };

    for (const item of document.items()) visit(item);
    return index;
}

function status_for(change: EcadIndexedChange): EcadDiffPaintStatus {
    return change.category;
}

function first_item(
    index: SourceIndex,
    source_id?: string,
): object | undefined {
    return source_id ? index.get(source_id)?.[0] : undefined;
}

/**
 * Resolve native diff identities against both parsed revisions once. The
 * comparison document remains authoritative; reference items are retained
 * only for removals whose parent is not itself removed.
 */
export function build_diff_presentation(
    diff: EcadDocumentDiffIndex,
    reference: PaintableDocument,
    comparison: PaintableDocument,
): EcadDiffPresentation {
    const reference_index = index_paint_items(reference);
    const comparison_index = index_paint_items(comparison);
    const status_by_item = new Map<object, EcadDiffPaintStatus>();
    const removed_items: object[] = [];
    const diagnostics: EcadDiffResolutionDiagnostic[] = [];
    const removed_change_ids = new Set(
        diff.changes
            .filter((entry) => entry.category === "removed")
            .map((entry) => entry.id),
    );

    for (const entry of diff.changes) {
        const side = entry.category === "removed" ? "reference" : "comparison";
        if (!entry.sourceId) {
            diagnostics.push({
                changeId: entry.id,
                side,
                reason: "missing-source-id",
            });
            continue;
        }
        const item =
            side === "reference"
                ? first_item(reference_index, entry.sourceId)
                : first_item(comparison_index, entry.sourceId);
        if (!item) {
            diagnostics.push({
                changeId: entry.id,
                sourceId: entry.sourceId,
                side,
                reason: "item-not-found",
            });
            continue;
        }

        status_by_item.set(item, status_for(entry));
        if (
            entry.category === "removed" &&
            (!entry.parentId || !removed_change_ids.has(entry.parentId))
        ) {
            removed_items.push(item);
        }
    }

    const signature = JSON.stringify({
        path: diff.document.path,
        docType: diff.document.docType,
        changes: diff.changes.map((entry) => [
            entry.id,
            entry.category,
            entry.sourceId,
        ]),
    });

    return {
        signature,
        statusByItem: status_by_item,
        removedItems: removed_items,
        diagnostics,
    };
}

/**
 * KiCad-style paint transform: normal document colors become a fixed neutral
 * context; changed native items use the category palette while preserving the
 * primitive's original alpha.
 */
export function apply_diff_color(
    color: Color,
    status: EcadDiffPaintStatus,
): Color {
    const target = status === "unchanged" ? NEUTRAL : STATUS_COLORS[status];
    return target.with_alpha(target.a * color.a);
}

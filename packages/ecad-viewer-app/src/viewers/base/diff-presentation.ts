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
    itemsBySourceId: ReadonlyMap<string, readonly object[]>;
    itemsBySideAndSourceId: ReadonlyMap<string, readonly object[]>;
    referenceItems: readonly object[];
    diagnostics: readonly EcadDiffResolutionDiagnostic[];
};

type SourceIndex = Map<string, object[]>;

type PaintItemIndex = {
    bySourceId: SourceIndex;
    rootByItem: ReadonlyMap<object, object>;
};

const STATUS_COLORS: Record<
    Exclude<EcadDiffPaintStatus, "unchanged">,
    Color
> = {
    added: Color.from_css("#2BE481"),
    removed: Color.from_css("#FF4D67"),
    modified: Color.from_css("#FFC928"),
    conflict: Color.from_css("#D76BFF"),
};

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
function build_paint_item_index(document: PaintableDocument): PaintItemIndex {
    const index: SourceIndex = new Map();
    const visited = new Set<object>();
    const root_by_item = new Map<object, object>();

    const visit = (item: unknown, root: object) => {
        if (!item || typeof item !== "object" || visited.has(item)) return;
        visited.add(item);
        root_by_item.set(item, root);
        const id = source_id_of(item);
        if (id) add_index(index, id, item);

        if (
            "items" in item &&
            typeof (item as { items?: unknown }).items === "function"
        ) {
            for (const child of (
                item as { items(): Iterable<unknown> }
            ).items()) {
                visit(child, root);
            }
        }
    };

    for (const item of document.items()) {
        if (!item || typeof item !== "object") continue;
        visit(item, item);
    }
    return {
        bySourceId: index,
        rootByItem: root_by_item,
    };
}

export function index_paint_items(document: PaintableDocument): SourceIndex {
    return build_paint_item_index(document).bySourceId;
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
    const reference_item_index = build_paint_item_index(reference);
    const comparison_item_index = build_paint_item_index(comparison);
    const reference_index = reference_item_index.bySourceId;
    const comparison_index = comparison_item_index.bySourceId;
    const status_by_item = new Map<object, EcadDiffPaintStatus>();
    const items_by_source_id = new Map<string, readonly object[]>();
    const items_by_side_and_source_id = new Map<string, readonly object[]>();
    const reference_items: object[] = [];
    const retained_reference_items = new Set<object>();
    const diagnostics: EcadDiffResolutionDiagnostic[] = [];
    const reference_change_ids = new Set(
        diff.changes
            .filter((entry) => entry.sourceSide === "reference")
            .map((entry) => entry.id),
    );

    for (const entry of diff.changes) {
        const side = entry.sourceSide;
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

        let presentation_item = item;
        if (
            entry.sourceSide === "reference" &&
            (entry.change.retainReference ||
                !entry.parentId ||
                !reference_change_ids.has(entry.parentId))
        ) {
            const root = reference_item_index.rootByItem.get(item);
            // Some dependent items (notably schematic PinInstance) are
            // yielded by both their owning symbol and document.items(). The
            // first recursive visit records the actual independently
            // paintable owner; do not mistake the later document-level yield
            // for proof that the child can be painted on its own.
            const paint_item = root ?? item;
            // Nested library text, pins, and graphics depend on their owning
            // symbol's paint transform. Promote them to the top-level owner so
            // Composite paints a safe, visible whole-symbol halo instead of a
            // transform-less child that can blank the view.
            if (paint_item) {
                presentation_item = paint_item;
                if (!retained_reference_items.has(paint_item)) {
                    retained_reference_items.add(paint_item);
                    reference_items.push(paint_item);
                }
            }
        }
        status_by_item.set(item, status_for(entry));
        status_by_item.set(presentation_item, status_for(entry));
        items_by_source_id.set(entry.sourceId, [presentation_item]);
        items_by_side_and_source_id.set(
            `${entry.sourceSide}:${entry.sourceId}`,
            [presentation_item],
        );
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
        itemsBySourceId: items_by_source_id,
        itemsBySideAndSourceId: items_by_side_and_source_id,
        referenceItems: reference_items,
        diagnostics,
    };
}

/**
 * Comparison paint transform:
 * - unchanged: softly mute theme/layer hues toward the page while preserving
 *   enough original color to keep schematic and copper context readable;
 * - A/R/M/conflict: tint the original color toward the status palette so
 *   geometry stays readable while status stays vivid.
 */
export function apply_diff_color(
    color: Color,
    status: EcadDiffPaintStatus,
    background = Color.black,
): Color {
    if (status === "unchanged") {
        const partially_desaturated = color.mix(color.grayscale, 0.45);
        const muted = partially_desaturated.mix(background, 0.72);
        return muted.with_alpha(color.a * 0.76);
    }
    const status_color = STATUS_COLORS[status];
    // Bias toward status (~62%) while retaining some original layer identity.
    const tinted = color.mix(status_color, 0.25);
    return tinted.with_alpha(
        Math.min(1, Math.max(color.a, 0.72) * status_color.a),
    );
}

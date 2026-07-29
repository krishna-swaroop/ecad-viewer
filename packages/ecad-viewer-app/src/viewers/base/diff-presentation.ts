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

export type EcadDiffResolutionReason =
    /** The change carried no native source id, so nothing could be resolved. */
    | "missing-source-id"
    /** The source id resolved against neither parsed revision. */
    | "item-not-found"
    /** More than one paint item in the scene claims this source id. */
    | "source-id-ambiguous"
    /** Two changes resolve to the same side+source id; the first is discarded. */
    | "duplicate-change-target"
    /**
     * The item resolved but the painted scene yielded no bounds for it, so the
     * caller-supplied bbox survives. This is the case the older diagnostics
     * could not see: hydration abandons a target with a bare `continue`.
     */
    | "paint-bounds-not-found";

export type EcadDiffResolutionDiagnostic = {
    changeId: string;
    sourceId?: string;
    side: "reference" | "comparison";
    reason: EcadDiffResolutionReason;
    /** Paint items claiming this source id (ambiguity and bounds failures). */
    matchCount?: number;
    /** KiCad type name of the change, for grouping failures by object kind. */
    typeName?: string;
};

/**
 * Per-comparison resolution counters. Prism normally resolves painted bounds;
 * `targetsNonFocusable` records identities that could not produce a safe
 * camera target. Native callers may still use strict supplied bboxes.
 */
export type EcadDiffResolutionSummary = {
    changes: number;
    sourceResolved: number;
    ambiguousSourceIds: number;
    duplicateChangeTargets: number;
    targets: number;
    targetsWithPaintedBounds: number;
    targetsUsingProvidedBounds: number;
    targetsNonFocusable: number;
    visuals: number;
    visualsWithPaintedBounds: number;
    visualsUsingProvidedBounds: number;
    visualsNonFocusable: number;
};

/** Counters and diagnostics produced once the comparison scene has painted. */
export type EcadDiffBoundsResolution = {
    diagnostics: EcadDiffResolutionDiagnostic[];
    targets: number;
    targetsWithPaintedBounds: number;
    targetsUsingProvidedBounds: number;
    targetsNonFocusable: number;
    visuals: number;
    visualsWithPaintedBounds: number;
    visualsUsingProvidedBounds: number;
    visualsNonFocusable: number;
};

export function merge_bounds_resolution(
    summary: EcadDiffResolutionSummary,
    bounds: EcadDiffBoundsResolution,
): EcadDiffResolutionSummary {
    return {
        ...summary,
        targets: bounds.targets,
        targetsWithPaintedBounds: bounds.targetsWithPaintedBounds,
        targetsUsingProvidedBounds: bounds.targetsUsingProvidedBounds,
        targetsNonFocusable: bounds.targetsNonFocusable,
        visuals: bounds.visuals,
        visualsWithPaintedBounds: bounds.visualsWithPaintedBounds,
        visualsUsingProvidedBounds: bounds.visualsUsingProvidedBounds,
        visualsNonFocusable: bounds.visualsNonFocusable,
    };
}

export type EcadDiffPresentation = {
    signature: string;
    /**
     * Status colour is reserved for the active review selection. The native
     * status index remains available for identity resolution without tinting
     * every changed object in the retained composite scene.
     */
    colorizeChanges: boolean;
    statusByItem: ReadonlyMap<object, EcadDiffPaintStatus>;
    itemsBySourceId: ReadonlyMap<string, readonly object[]>;
    itemsBySideAndSourceId: ReadonlyMap<string, readonly object[]>;
    referenceItems: readonly object[];
    diagnostics: readonly EcadDiffResolutionDiagnostic[];
    /** Counters from identity resolution; bounds counters are added on paint. */
    resolution: EcadDiffResolutionSummary;
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

export function diff_status_color(
    status: Exclude<EcadDiffPaintStatus, "unchanged">,
): Color {
    return STATUS_COLORS[status];
}

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
 * pads/graphics through items(). Schematic symbols normally expose only the
 * pins for their active unit through items(), but the native file still owns
 * UUID-bearing pin instances for every unit. Those identities remain valid
 * diff targets when a library pin set changes, so walk the complete `pins`
 * collection too. Nested identities resolve to their top-level painted owner:
 * layer bbox maps are keyed by document items, not by children painted inside
 * a footprint or symbol transform.
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

        if ("pins" in item && Array.isArray(item.pins)) {
            for (const pin of item.pins) {
                visit(pin, root);
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

    let source_resolved = 0;
    let ambiguous_source_ids = 0;
    let duplicate_change_targets = 0;

    for (const entry of diff.changes) {
        const side = entry.sourceSide;
        if (!entry.sourceId) {
            diagnostics.push({
                changeId: entry.id,
                side,
                reason: "missing-source-id",
                typeName: entry.change.typeName,
            });
            continue;
        }
        const paint_item_index =
            side === "reference" ? reference_item_index : comparison_item_index;
        const index = paint_item_index.bySourceId;
        const matches = index.get(entry.sourceId) ?? [];
        const item = first_item(index, entry.sourceId);
        if (!item) {
            diagnostics.push({
                changeId: entry.id,
                sourceId: entry.sourceId,
                side,
                reason: "item-not-found",
                typeName: entry.change.typeName,
            });
            continue;
        }
        source_resolved += 1;
        // Taking `[0]` of a multi-match is a silent coin flip today. Count it
        // before deciding whether disambiguation belongs in the digest.
        if (matches.length > 1) {
            ambiguous_source_ids += 1;
            diagnostics.push({
                changeId: entry.id,
                sourceId: entry.sourceId,
                side,
                reason: "source-id-ambiguous",
                matchCount: matches.length,
                typeName: entry.change.typeName,
            });
        }
        // The index below is keyed by side+source id and assigned, not
        // appended: a second change on the same identity destroys the first
        // resolution outright. Behaviour is left as-is for this measurement
        // pass; only the frequency is recorded.
        if (items_by_side_and_source_id.has(`${side}:${entry.sourceId}`)) {
            duplicate_change_targets += 1;
            diagnostics.push({
                changeId: entry.id,
                sourceId: entry.sourceId,
                side,
                reason: "duplicate-change-target",
                typeName: entry.change.typeName,
            });
        }

        let presentation_item = paint_item_index.rootByItem.get(item) ?? item;
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
        colorizeChanges: false,
        statusByItem: status_by_item,
        itemsBySourceId: items_by_source_id,
        itemsBySideAndSourceId: items_by_side_and_source_id,
        referenceItems: reference_items,
        diagnostics,
        resolution: {
            changes: diff.changes.length,
            sourceResolved: source_resolved,
            ambiguousSourceIds: ambiguous_source_ids,
            duplicateChangeTargets: duplicate_change_targets,
            // Filled in by bounds hydration once the scene has painted.
            targets: 0,
            targetsWithPaintedBounds: 0,
            targetsUsingProvidedBounds: 0,
            targetsNonFocusable: 0,
            visuals: 0,
            visualsWithPaintedBounds: 0,
            visualsUsingProvidedBounds: 0,
            visualsNonFocusable: 0,
        },
    };
}

/**
 * Alternate retained scene used while one comparison target is selected.
 * Every native item is painted as subdued monochrome; the selected native
 * footprint/route is then replayed into the board selection layer in its
 * semantic status colour.
 */
export function build_diff_focus_presentation(
    presentation: EcadDiffPresentation,
): EcadDiffPresentation {
    return {
        ...presentation,
        signature: `${presentation.signature}:focus`,
        colorizeChanges: true,
        statusByItem: new Map(),
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
        const muted = color.grayscale.mix(background.grayscale, 0.72);
        return muted.with_alpha(color.a * 0.76);
    }
    const status_color = diff_status_color(status);
    // Bias toward status (~62%) while retaining some original layer identity.
    const tinted = color.mix(status_color, 0.25);
    return tinted.with_alpha(
        Math.min(1, Math.max(color.a, 0.72) * status_color.a),
    );
}

import type { EcadSourceUpdate } from "./host-adapter";
import { BBox } from "../base/math";
import {
    buildDocumentDiffIndex,
    parseKiCadDocumentDiff,
    parseKiCadProjectDiff,
    type EcadDiffCategory,
    type EcadDiffGroup,
    type EcadDocumentDiffIndex,
    type EcadIndexedChange,
    type KiCadDocumentDiff,
} from "./document-diff";

export type EcadDocumentComparisonRequest = {
    comparisonKey: string;
    reference: EcadSourceUpdate;
    comparison: EcadSourceUpdate;
    /**
     * Native KiCad DOCUMENT_DIFF / PROJECT_DIFF JSON. The value is validated
     * at the custom-element boundary even when TypeScript callers pre-type it.
     */
    diff: unknown;
    /** Required when a PROJECT_DIFF contains more than one matching document. */
    documentPath?: string;
    /** Prefer this hierarchical schematic project path when activating SCH. */
    activeSheetPath?: string;
};

export type EcadDocumentComparisonSelection =
    | { kind: "change"; id: string }
    | { kind: "group"; id: string };

export type EcadPreparedDiffTarget = {
    id: string;
    kind: "change" | "group";
    category: EcadDiffCategory;
    label: string;
    memberIds: string[];
    sourceIds: string[];
    bounds: [number, number, number, number];
    sourceSide: "reference" | "comparison";
    routing: boolean;
    overlayLines: Array<Array<[number, number]>>;
    visuals: Array<{
        sourceId: string;
        category: EcadDiffCategory;
        sourceSide: "reference" | "comparison";
        routing: boolean;
        bounds: [number, number, number, number];
        overlayLines: Array<Array<[number, number]>>;
    }>;
};

export type EcadDocumentComparisonPreparation = {
    comparisonKey: string;
    context: "SCH" | "PCB";
    document: KiCadDocumentDiff;
    targets: ReadonlyMap<string, EcadPreparedDiffTarget>;
    diagnostics: readonly {
        changeId: string;
        sourceId?: string;
        side: "reference" | "comparison";
        reason: "missing-source-id" | "item-not-found";
    }[];
    prepareMs: number;
    sourceCacheHit: boolean;
    /** True when the reference revision has no matching document file. */
    missingReference: boolean;
    /** True when the comparison revision has no matching document file. */
    missingComparison: boolean;
};

export type EcadDocumentComparisonSelectionResult = {
    status: "applied" | "missing" | "superseded";
    requestId: number;
    target?: EcadPreparedDiffTarget;
    clickToFrameMs: number;
    paintCount: number;
    parserCount: number;
};

export type EcadRevisionDiffVisualTarget = {
    sourceId: string;
    parentSourceId?: string | null;
    status: EcadDiffCategory;
    bounds?: [number, number, number, number];
    routing?: boolean;
};

export type EcadRevisionDiffTarget = {
    id: string;
    label?: string;
    visuals: EcadRevisionDiffVisualTarget[];
};

export type EcadRevisionDiffPresentationRequest = {
    context: "SCH" | "PCB";
    targets: EcadRevisionDiffTarget[];
};

export type EcadTransitionTraceDetail = {
    sequence: number;
    timestamp: string;
    event: string;
    status?: "start" | "ready" | "missing" | "superseded" | "error";
    generation?: number;
    revisionKey?: string | null;
    requestedPage?: string | null;
    resolvedPage?: {
        projectPath: string;
        sheetPath: string;
        filename: string;
        name?: string;
        page?: string;
    } | null;
    activePage?: string | null;
    detail?: Record<string, unknown>;
};

export class EcadTransitionTraceEvent extends CustomEvent<EcadTransitionTraceDetail> {
    static readonly type = "ecad-viewer:transition-trace";

    constructor(detail: EcadTransitionTraceDetail) {
        super(EcadTransitionTraceEvent.type, {
            detail,
            bubbles: true,
            composed: true,
        });
    }
}

export class EcadDocumentComparisonReadyEvent extends CustomEvent<EcadDocumentComparisonPreparation> {
    static readonly type = "ecad-viewer:document-comparison-ready";

    constructor(detail: EcadDocumentComparisonPreparation) {
        super(EcadDocumentComparisonReadyEvent.type, {
            detail,
            bubbles: true,
            composed: true,
        });
    }
}

export class EcadDocumentComparisonFrameEvent extends CustomEvent<EcadDocumentComparisonSelectionResult> {
    static readonly type = "ecad-viewer:document-comparison-frame";

    constructor(detail: EcadDocumentComparisonSelectionResult) {
        super(EcadDocumentComparisonFrameEvent.type, {
            detail,
            bubbles: true,
            composed: true,
        });
    }
}

function normalize_path(path: string): string {
    return path.replace(/\\/g, "/").replace(/^\.?\//, "");
}

function parse_documents(value: unknown): KiCadDocumentDiff[] {
    if (value && typeof value === "object" && "documents" in value) {
        return parseKiCadProjectDiff(value).documents;
    }
    return [parseKiCadDocumentDiff(value)];
}

export function selectComparisonDocument(
    value: unknown,
    requestedPath?: string,
): KiCadDocumentDiff {
    const documents = parse_documents(value);
    if (!documents.length) {
        throw new TypeError("PROJECT_DIFF.documents must not be empty");
    }
    if (!requestedPath) {
        if (documents.length > 1) {
            throw new TypeError(
                "documentPath is required for a multi-document PROJECT_DIFF",
            );
        }
        return documents[0]!;
    }

    const requested = normalize_path(requestedPath);
    const exact = documents.find(
        (document) => normalize_path(document.path) === requested,
    );
    if (exact) return exact;

    const suffixMatches = documents.filter((document) => {
        const candidate = normalize_path(document.path);
        return (
            candidate.endsWith(`/${requested}`) ||
            requested.endsWith(`/${candidate}`)
        );
    });
    if (suffixMatches.length === 1) return suffixMatches[0]!;
    throw new TypeError(
        `Could not uniquely resolve documentPath "${requestedPath}"`,
    );
}

function bounds_tuple(
    bounds: EcadIndexedChange["worldBounds"],
): [number, number, number, number] {
    return [bounds.x, bounds.y, bounds.w, bounds.h];
}

function visual_target(change: EcadIndexedChange) {
    return {
        sourceId: change.sourceId ?? "",
        category: change.category,
        sourceSide: change.sourceSide,
        routing: ["SCH_LINE", "PCB_TRACK", "PCB_ARC", "PCB_VIA"].includes(
            change.change.typeName,
        ),
        bounds: bounds_tuple(change.worldBounds),
        overlayLines: [] as Array<Array<[number, number]>>,
    };
}

function change_target(
    change: EcadIndexedChange,
    members: EcadIndexedChange[] = [change],
): EcadPreparedDiffTarget {
    const visuals = members
        .map(visual_target)
        .filter((entry) => entry.sourceId);
    const bounds = BBox.combine(members.map((entry) => entry.worldBounds));
    return {
        id: change.id,
        kind: "change",
        category: change.category,
        label: change.change.refdes
            ? `${change.change.typeName} [${change.change.refdes}]`
            : change.change.typeName,
        memberIds: members.map((entry) => entry.id),
        sourceIds: visuals.map((entry) => entry.sourceId),
        bounds: bounds_tuple(bounds),
        sourceSide: change.sourceSide,
        routing: visuals.some((entry) => entry.routing),
        overlayLines: [],
        visuals,
    };
}

function group_target(group: EcadDiffGroup): EcadPreparedDiffTarget {
    const visuals = group.members
        .map(visual_target)
        .filter((entry) => entry.sourceId);
    return {
        id: group.id,
        kind: "group",
        category: group.category,
        label: group.label,
        memberIds: group.members.map((member) => member.id),
        sourceIds: group.members.flatMap((member) =>
            member.sourceId ? [member.sourceId] : [],
        ),
        bounds: bounds_tuple(group.worldBounds),
        sourceSide: group.members[0]?.sourceSide ?? "comparison",
        routing: group.members.some((member) =>
            ["SCH_LINE", "PCB_TRACK", "PCB_ARC", "PCB_VIA"].includes(
                member.change.typeName,
            ),
        ),
        overlayLines: [],
        visuals,
    };
}

/**
 * Compile all click-path data once. Prefixing keys prevents a group and a
 * change with the same native ID from overwriting each other.
 */
export function buildDocumentComparisonTargets(
    index: EcadDocumentDiffIndex,
): ReadonlyMap<string, EcadPreparedDiffTarget> {
    const targets = new Map<string, EcadPreparedDiffTarget>();
    for (const change of index.changes.filter((entry) => !entry.parentId)) {
        const members = index.changes.filter(
            (entry) => entry === change || entry.rootId === change.id,
        );
        targets.set(`change:${change.id}`, change_target(change, members));
    }
    for (const group of index.groups) {
        targets.set(`group:${group.id}`, group_target(group));
    }
    return targets;
}

export function prepareComparisonDocument(
    value: unknown,
    requestedPath?: string,
): {
    document: KiCadDocumentDiff;
    index: EcadDocumentDiffIndex;
    targets: ReadonlyMap<string, EcadPreparedDiffTarget>;
    context: "SCH" | "PCB";
} {
    const document = selectComparisonDocument(value, requestedPath);
    const index = buildDocumentDiffIndex(document);
    return {
        document,
        index,
        targets: buildDocumentComparisonTargets(index),
        context: index.units === "pcb-iu" ? "PCB" : "SCH",
    };
}

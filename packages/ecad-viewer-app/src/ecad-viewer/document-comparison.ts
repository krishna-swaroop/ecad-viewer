import type { EcadSourceUpdate } from "./host-adapter";
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
};

export type EcadDocumentComparisonSelectionResult = {
    status: "applied" | "missing" | "superseded";
    requestId: number;
    target?: EcadPreparedDiffTarget;
    clickToFrameMs: number;
    paintCount: number;
    parserCount: number;
};

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

function change_target(change: EcadIndexedChange): EcadPreparedDiffTarget {
    return {
        id: change.id,
        kind: "change",
        category: change.category,
        label: change.change.refdes
            ? `${change.change.typeName} [${change.change.refdes}]`
            : change.change.typeName,
        memberIds: [change.id],
        sourceIds: change.sourceId ? [change.sourceId] : [],
        bounds: bounds_tuple(change.worldBounds),
    };
}

function group_target(group: EcadDiffGroup): EcadPreparedDiffTarget {
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
    for (const change of index.changes) {
        targets.set(`change:${change.id}`, change_target(change));
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

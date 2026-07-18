import type {
    EcadOverlayAnchor,
    EcadOverlayPrimitive,
    EcadOverlayScene,
} from "../viewers/base/overlay-scene";

export type EcadCommentContext = "SCH" | "PCB";

/**
 * Comment anchors deliberately expose only the identities Prism persists.
 * The generic graphics anchor/primitive model remains an implementation
 * detail so the host API cannot become a second review-rendering surface.
 */
export type EcadCommentAnchor =
    | { kind: "world"; x: number; y: number; page?: string }
    | { kind: "source-item"; uuid: string; page?: string };

export type EcadCommentOverlay = {
    id: string;
    anchor: EcadCommentAnchor;
    areaBounds?: [number, number, number, number];
    accessibilityLabel?: string;
    metadata?: unknown;
};

export type EcadCommentOverlaySet = {
    context: EcadCommentContext;
    comments: EcadCommentOverlay[];
};

export type EcadCommentOverlayHitDetail = {
    commentId: string;
    context: EcadCommentContext;
    x: number;
    y: number;
    bounds?: [number, number, number, number];
    page?: string;
    metadata?: unknown;
};

export class EcadCommentOverlayClickEvent extends CustomEvent<EcadCommentOverlayHitDetail> {
    static readonly type = "ecad-viewer:comment-overlay-click";

    constructor(detail: EcadCommentOverlayHitDetail) {
        super(EcadCommentOverlayClickEvent.type, {
            detail,
            bubbles: true,
            composed: true,
        });
    }
}

export const COMMENT_OVERLAY_CHANNELS: Record<EcadCommentContext, string> = {
    SCH: ":comments:SCH",
    PCB: ":comments:PCB",
};

const COMMENT_AREA_SUFFIX = ":area";

export function comment_id_from_primitive(primitive_id: string): string {
    return primitive_id.endsWith(COMMENT_AREA_SUFFIX)
        ? primitive_id.slice(0, -COMMENT_AREA_SUFFIX.length)
        : primitive_id;
}

/**
 * Translate the intentionally narrow public comment contract to the internal
 * retained overlay scene. Styling is viewer-owned so review graphics cannot
 * leak back into this API through caller-defined colors or primitives.
 */
export function comment_overlay_scene(
    request: EcadCommentOverlaySet,
): EcadOverlayScene {
    const primitives: EcadOverlayPrimitive[] = [];

    for (const comment of request.comments) {
        const anchor: EcadOverlayAnchor = comment.anchor;
        primitives.push({
            id: comment.id,
            kind: "marker",
            anchor,
            glyph: "comment",
            sizing: "screen",
            radius: 10,
            interactive: true,
            metadata: comment.metadata,
            accessibilityLabel: comment.accessibilityLabel,
        });

        if (comment.areaBounds) {
            primitives.push({
                id: `${comment.id}${COMMENT_AREA_SUFFIX}`,
                kind: "bbox",
                anchor: {
                    kind: "bbox",
                    bounds: comment.areaBounds,
                    page: comment.anchor.page,
                },
                dash: [2, 1.5],
                strokeWidth: 0.15,
                sizing: "world",
                interactive: true,
                metadata: comment.metadata,
                accessibilityLabel: comment.accessibilityLabel,
            });
        }
    }

    return {
        channelId: COMMENT_OVERLAY_CHANNELS[request.context],
        context: request.context,
        placement: "foreground",
        visible: true,
        primitives,
    };
}

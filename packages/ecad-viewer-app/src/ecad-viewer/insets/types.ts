/*
    Contracts between the inset session and the documents it shows.
*/

import type { BBox, Vec2 } from "../../base/math";
import type { InsetCamera } from "./camera";

export type InsetKind = "pcb" | "sch";

/** Which face of the target an inset shows; drives the header badge. */
/** `none`: the designator is not in that document (a header-only inset). */
export type InsetSide = "top" | "bottom" | "sch" | "none";

/** What a provider resolves a designator + pin/pad number to. */
export interface InsetTarget {
    kind: InsetKind;
    reference: string;
    /** Pin or pad number. */
    number: string;
    /** Short trailing label, e.g. the pin name or the sheet name. */
    detail?: string;
    side: InsetSide;
    /** World box the inset frames when it opens or is refit. */
    focus: BBox;
    /** World point the leader ends at: the matching pad or pin. */
    anchor: Vec2;
    /** World box of that pad or pin, outlined in the chain colour. */
    anchor_box?: BBox;
    /** Open mirrored (bottom-side footprint). */
    mirror: boolean;
}

/** A pin or pad under the pointer inside an inset. */
export interface InsetHit {
    reference: string;
    number: string;
    /** World box, for the hover outline. */
    box: BBox;
}

/**
 * One document kind's way of serving insets. The viewer that already holds
 * the document implements this; insets never copy the scene.
 */
export interface InsetProvider {
    readonly kind: InsetKind;
    resolve(reference: string, number: string): Promise<InsetTarget | null>;
    /** Draw `target`'s scene through `camera` into the inset's 2D canvas. */
    render(
        target: InsetTarget,
        camera: InsetCamera,
        canvas: HTMLCanvasElement,
    ): void;
    /**
     * The inset showing `target` closed, or a resolved target was discarded
     * (a newer hover won). Providers that hold resources per target free
     * them here.
     */
    release?(target: InsetTarget): void;
    /**
     * False while the document is still loading. A null resolve from an
     * unready provider means "not yet", not "not in this document".
     */
    ready?(): boolean;
    /** The pin or pad at a world point of `target`'s scene, if any. */
    hit_test?(target: InsetTarget, world: Vec2): InsetHit | null;
    /**
     * Call `listener` when the scene insets show changed (layer visibility,
     * highlights, selection, variant). Returns an unsubscribe function.
     */
    subscribe?(listener: () => void): () => void;
}

/**
 * Where a leader starts: a main viewer, or (for chained insets) a parent
 * inset. Returns viewport (client) coordinates, or null when the point is
 * not on screen.
 */
export interface InsetSource {
    world_to_client(point: Vec2): Vec2 | null;
}

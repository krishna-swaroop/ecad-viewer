/*
    Contracts between the inset session and the documents it shows.
*/

import type { BBox, Vec2 } from "../../base/math";
import type { InsetCamera } from "./camera";

export type InsetKind = "pcb" | "sch";

/** Which face of the target an inset shows; drives the header badge. */
export type InsetSide = "top" | "bottom" | "sch";

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
    /** Open mirrored (bottom-side footprint). */
    mirror: boolean;
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
}

/**
 * Where a leader starts: a main viewer, or (for chained insets) a parent
 * inset. Returns viewport (client) coordinates, or null when the point is
 * not on screen.
 */
export interface InsetSource {
    world_to_client(point: Vec2): Vec2 | null;
}

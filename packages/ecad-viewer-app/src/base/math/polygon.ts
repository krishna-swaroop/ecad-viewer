/*
    Plain polygon helpers for rings given as point lists. A ring is implicitly
    closed: the last point connects back to the first.
*/

import { Vec2 } from "./vec2";

/**
 * Signed area by the shoelace formula. Positive for a ring that winds
 * clockwise on screen (y down), which is counterclockwise in maths axes.
 */
export function polygon_signed_area(ring: readonly Vec2[]): number {
    let a = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        a += (ring[j]!.x - ring[i]!.x) * (ring[j]!.y + ring[i]!.y);
    }
    return a / 2;
}

/** Whether `p` lies inside the ring, by the even-odd rule. */
export function polygon_contains(ring: readonly Vec2[], p: Vec2): boolean {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i]!;
        const b = ring[j]!;
        if (
            a.y > p.y !== b.y > p.y &&
            p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
        ) {
            inside = !inside;
        }
    }
    return inside;
}

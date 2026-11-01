/**
 * Point-to-point measurement on the board: snap targets and the arithmetic.
 *
 * Snap points come from the board model, not from the painted scene. A pad
 * snaps to its anchor (the hole, for a through pad), which is the point
 * KiCad's own measure tool and its pad properties report. Priority is by
 * kind first and distance second, so a pad centre a few pixels away wins
 * over a track edge under the cursor.
 */
import { Vec2 } from "../../base/math";
import {
    ArcSegment,
    LineSegment,
    Pad,
    Via,
    type KicadPCB,
} from "../../kicad/board";

export type MeasureSnapKind = "pad" | "via" | "track-end" | "track" | "free";

/** Lower wins. */
const PRIORITY: Record<MeasureSnapKind, number> = {
    pad: 0,
    via: 1,
    "track-end": 2,
    track: 3,
    free: 4,
};

export type MeasureUnits = "mm" | "mil";

export const MM_PER_MIL = 0.0254;

export interface MeasureSnap {
    kind: MeasureSnapKind;
    /** Board millimetres. */
    x: number;
    y: number;
    /** "U1 · 25", "via", "track"; empty for a free point. */
    label: string;
    /** Net name, when the target has one. */
    net: string | null;
}

export interface Measurement {
    a: MeasureSnap;
    b: MeasureSnap;
    /** Board millimetres. */
    distance: number;
    /** Absolute horizontal and vertical extents, millimetres. */
    dx: number;
    dy: number;
    /** Angle of a→b above the board's horizontal, degrees, 0–90. */
    angle: number;
}

/** Anything the snap index can test for visibility. */
export type SnapItem = Pad | Via | LineSegment | ArcSegment;

interface PointTarget {
    kind: "pad" | "via" | "track-end";
    x: number;
    y: number;
    item: SnapItem;
}

interface SegmentTarget {
    ax: number;
    ay: number;
    bx: number;
    by: number;
    item: LineSegment;
}

/** Grid cell size in millimetres. */
const CELL = 2;

const cell_key = (cx: number, cy: number) => `${cx}:${cy}`;

export function pad_center(pad: Pad): Vec2 {
    const fp = pad.parent;
    const theta = (fp.at.rotation * Math.PI) / 180;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const { x, y } = pad.at.position;
    return new Vec2(
        fp.at.position.x + x * cos + y * sin,
        fp.at.position.y - x * sin + y * cos,
    );
}

export function measure(a: MeasureSnap, b: MeasureSnap): Measurement {
    const dx = Math.abs(b.x - a.x);
    const dy = Math.abs(b.y - a.y);
    return {
        a,
        b,
        distance: Math.hypot(dx, dy),
        dx,
        dy,
        angle: (Math.atan2(dy, dx) * 180) / Math.PI,
    };
}

/** 3 decimals in millimetres, 1 in mils (P-VT-6). */
export function format_length(mm: number, units: MeasureUnits): string {
    return units === "mil"
        ? `${(mm / MM_PER_MIL).toFixed(1)} mil`
        : `${mm.toFixed(3)} mm`;
}

/**
 * Snap targets of one board, bucketed on a uniform grid so a query touches
 * only the cells within the snap radius.
 */
export class SnapIndex {
    #points = new Map<string, PointTarget[]>();
    #segments = new Map<string, SegmentTarget[]>();

    constructor(readonly board: KicadPCB) {
        for (const fp of board.footprints)
            for (const pad of fp.pads) {
                const c = pad_center(pad);
                this.#add_point({ kind: "pad", x: c.x, y: c.y, item: pad });
            }
        for (const via of board.vias) {
            const { x, y } = via.at.position;
            this.#add_point({ kind: "via", x, y, item: via });
        }
        for (const track of board.segments) {
            for (const end of [track.start, track.end])
                this.#add_point({
                    kind: "track-end",
                    x: end.x,
                    y: end.y,
                    item: track,
                });
            if (track instanceof LineSegment) this.#add_segment(track);
        }
    }

    #add_point(target: PointTarget) {
        const key = cell_key(
            Math.floor(target.x / CELL),
            Math.floor(target.y / CELL),
        );
        const bucket = this.#points.get(key);
        if (bucket) bucket.push(target);
        else this.#points.set(key, [target]);
    }

    #add_segment(item: LineSegment) {
        const target = {
            ax: item.start.x,
            ay: item.start.y,
            bx: item.end.x,
            by: item.end.y,
            item,
        };
        const x0 = Math.floor(Math.min(target.ax, target.bx) / CELL);
        const x1 = Math.floor(Math.max(target.ax, target.bx) / CELL);
        const y0 = Math.floor(Math.min(target.ay, target.by) / CELL);
        const y1 = Math.floor(Math.max(target.ay, target.by) / CELL);
        for (let cx = x0; cx <= x1; cx++)
            for (let cy = y0; cy <= y1; cy++) {
                const key = cell_key(cx, cy);
                const bucket = this.#segments.get(key);
                if (bucket) bucket.push(target);
                else this.#segments.set(key, [target]);
            }
    }

    /**
     * The best snap within `radius` millimetres of `at`, or a free point.
     * `visible` filters targets on hidden or non-isolated layers.
     */
    snap(
        at: Vec2,
        radius: number,
        visible: (item: SnapItem) => boolean,
    ): MeasureSnap {
        const r2 = radius * radius;
        const x0 = Math.floor((at.x - radius) / CELL);
        const x1 = Math.floor((at.x + radius) / CELL);
        const y0 = Math.floor((at.y - radius) / CELL);
        const y1 = Math.floor((at.y + radius) / CELL);

        let best: {
            kind: MeasureSnapKind;
            x: number;
            y: number;
            d2: number;
            item: SnapItem;
        } | null = null;
        const better = (kind: MeasureSnapKind, d2: number) =>
            !best ||
            PRIORITY[kind] < PRIORITY[best.kind] ||
            (PRIORITY[kind] === PRIORITY[best.kind] && d2 < best.d2);

        const seen = new Set<SegmentTarget>();
        for (let cx = x0; cx <= x1; cx++)
            for (let cy = y0; cy <= y1; cy++) {
                const key = cell_key(cx, cy);
                for (const t of this.#points.get(key) ?? []) {
                    const d2 = (t.x - at.x) ** 2 + (t.y - at.y) ** 2;
                    if (d2 > r2 || !better(t.kind, d2) || !visible(t.item))
                        continue;
                    best = { kind: t.kind, x: t.x, y: t.y, d2, item: t.item };
                }
                if (best && PRIORITY[best.kind] < PRIORITY.track) continue;
                for (const s of this.#segments.get(key) ?? []) {
                    if (seen.has(s)) continue;
                    seen.add(s);
                    const p = nearest_on_segment(at, s);
                    const d2 = (p.x - at.x) ** 2 + (p.y - at.y) ** 2;
                    if (d2 > r2 || !better("track", d2) || !visible(s.item))
                        continue;
                    best = { kind: "track", x: p.x, y: p.y, d2, item: s.item };
                }
            }

        if (!best)
            return { kind: "free", x: at.x, y: at.y, label: "", net: null };
        return {
            kind: best.kind,
            x: best.x,
            y: best.y,
            label: this.#label(best.kind, best.item),
            net: this.#net(best.item),
        };
    }

    #label(kind: MeasureSnapKind, item: SnapItem): string {
        if (item instanceof Pad) {
            const ref = item.parent.reference;
            return item.number ? `${ref} · ${item.number}` : ref;
        }
        if (item instanceof Via) return "via";
        return kind === "track-end" ? "track end" : "track";
    }

    #net(item: SnapItem): string | null {
        if (item instanceof Pad) return item.net?.name || null;
        const name = this.board.getNetName(item.net);
        return name || null;
    }
}

function nearest_on_segment(p: Vec2, s: SegmentTarget): Vec2 {
    const vx = s.bx - s.ax;
    const vy = s.by - s.ay;
    const len2 = vx * vx + vy * vy;
    const t =
        len2 === 0
            ? 0
            : Math.max(
                  0,
                  Math.min(1, ((p.x - s.ax) * vx + (p.y - s.ay) * vy) / len2),
              );
    return new Vec2(s.ax + vx * t, s.ay + vy * t);
}

/**
 * The board body: the area enclosed by Edge.Cuts, filled so the board reads as
 * a physical object instead of copper floating over the canvas.
 *
 * Edge.Cuts is stored as loose lines, arcs and curves, on the board and inside
 * footprints (connector slots, edge-mounted parts). They are chained into
 * closed loops here, in board coordinates. A loop inside an odd number of
 * other loops is a cutout; one inside an even number is an outline (a board,
 * or an island inside a cutout). Each outline is triangulated with its direct
 * cutouts as holes. Pieces that do not close into a loop are left out and
 * reported: an unfinished outline paints no body rather than a wrong one.
 */

import { warn } from "../../base/log";
import {
    Angle,
    Arc as MathArc,
    BBox,
    Matrix3,
    Vec2,
    polygon_contains,
} from "../../base/math";
import { triangulate_with_holes } from "../../graphics/webgl/triangulate";
import * as board_items from "../../kicad/board";
import { LayerNames } from "./layers";

/** Endpoints closer than this (mm) are the same vertex, as in KiCad's DRC. */
const JOIN_TOLERANCE = 0.01;

type Path = Vec2[];

/** A closed outline and the cutouts directly inside it. */
export interface SubstrateOutline {
    outline: Path;
    holes: Path[];
}

export class BoardSubstrate {
    /** Every outline's triangles, interleaved xy, in board coordinates. */
    readonly triangles: Float32Array;
    readonly bbox: BBox;

    constructor(
        public readonly outlines: readonly SubstrateOutline[],
        /** Edge.Cuts chains that did not close and so paint nothing. */
        public readonly open_chains = 0,
    ) {
        const parts = outlines.map(({ outline, holes }) =>
            triangulate_with_holes(outline, holes),
        );
        this.triangles = new Float32Array(
            parts.reduce((n, part) => n + part.length, 0),
        );
        let offset = 0;
        for (const part of parts) {
            this.triangles.set(part, offset);
            offset += part.length;
        }
        this.bbox = BBox.from_points(outlines.flatMap((o) => o.outline));
    }

    static #cache = new WeakMap<board_items.KicadPCB, BoardSubstrate>();

    /**
     * The board's body, built once per board: the painter asks again on
     * every repaint (layer toggles, variant changes), and the board's
     * geometry does not change after it is parsed.
     */
    static for_board(board: board_items.KicadPCB): BoardSubstrate {
        let substrate = BoardSubstrate.#cache.get(board);
        if (!substrate) {
            substrate = BoardSubstrate.from_board(board);
            BoardSubstrate.#cache.set(board, substrate);
            if (substrate.open_chains) {
                warn(
                    `${board.filename}: ${substrate.open_chains} Edge.Cuts ` +
                        `outline(s) do not close; no board body is painted ` +
                        `for them.`,
                );
            }
        }
        return substrate;
    }

    /** Build the body without caching it. */
    static from_board(board: board_items.KicadPCB): BoardSubstrate {
        const { loops, open_chains } = board_edge_loops(board);
        return new BoardSubstrate(nest(loops), open_chains);
    }
}

function near(a: Vec2, b: Vec2) {
    return (
        Math.abs(a.x - b.x) <= JOIN_TOLERANCE &&
        Math.abs(a.y - b.y) <= JOIN_TOLERANCE
    );
}

/** An arc's polyline, pinned to its exact end points so chains meet. */
function arc_points(a: board_items.Arc): Path {
    const points = a.arc.to_polyline();
    points[0] = a.start;
    points[points.length - 1] = a.end;
    return points;
}

function circle_points(center: Vec2, radius: number): Path {
    const points = new MathArc(
        center,
        radius,
        new Angle(0),
        new Angle(2 * Math.PI),
        0,
    ).to_polyline();
    points.pop(); // the end repeats the start
    return points;
}

/** A ring without repeated points, including a closing repeat. */
function clean_ring(ring: Path): Path {
    const out: Path = [];
    for (const p of ring) {
        if (!out.length || !near(out[out.length - 1]!, p)) out.push(p);
    }
    while (out.length > 1 && near(out[0]!, out[out.length - 1]!)) out.pop();
    return out;
}

/**
 * Edge.Cuts pieces of the board and of its footprints, in board coordinates:
 * `open` pieces still to be chained, `closed` ones already loops.
 */
function edge_pieces(board: board_items.KicadPCB) {
    const open: Path[] = [];
    const closed: Path[] = [];

    const add = (d: unknown, place: Matrix3 | null) => {
        if (!(d instanceof board_items.GraphicItem)) return;
        if (d.layer !== LayerNames.edge_cuts) return;
        const at = (points: Path) =>
            place ? Array.from(place.transform_all(points)) : points;

        if (d instanceof board_items.Line) {
            open.push(at([d.start, d.end]));
        } else if (d instanceof board_items.Arc) {
            open.push(at(arc_points(d)));
        } else if (d instanceof board_items.Curve) {
            open.push(at(d.points));
        } else if (d instanceof board_items.Rect) {
            const { start: a, end: b } = d;
            closed.push(at([a, new Vec2(b.x, a.y), b, new Vec2(a.x, b.y)]));
        } else if (d instanceof board_items.Circle) {
            const r = d.center.sub(d.end).magnitude;
            if (r > 0) closed.push(at(circle_points(d.center, r)));
        } else if (d instanceof board_items.Poly) {
            const ring: Path = [];
            for (const pt of d.pts) {
                if (pt instanceof Vec2) ring.push(pt);
                else ring.push(...arc_points(pt));
            }
            closed.push(at(ring));
        }
    };

    for (const d of board.drawings) add(d, null);
    for (const fp of board.footprints) {
        // The same placement the footprint painter draws with.
        const place = Matrix3.translation(
            fp.at.position.x,
            fp.at.position.y,
        ).rotate_self(Angle.deg_to_rad(fp.at.rotation));
        for (const d of fp.drawings) add(d, place);
    }

    return { open, closed };
}

/**
 * Edge.Cuts as closed loops, board and footprint pieces together, so a
 * footprint edge that completes the board's own outline joins it as KiCad
 * does. `open_chains` counts the chains left with a gap.
 */
export function board_edge_loops(board: board_items.KicadPCB): {
    loops: Path[];
    open_chains: number;
} {
    const { open, closed } = edge_pieces(board);
    const loops: Path[] = [];
    let open_chains = 0;

    for (const ring of closed) {
        const clean = clean_ring(ring);
        if (clean.length >= 3) loops.push(clean);
    }

    // Chain the loose pieces end to end. Walking from one piece's tail is
    // enough: in a closed loop every vertex joins exactly two pieces, so the
    // walk comes back round to the head.
    const used = new Array<boolean>(open.length).fill(false);
    for (let i = 0; i < open.length; i++) {
        if (used[i]) continue;
        used[i] = true;
        const chain: Path = [...open[i]!];
        let extended = true;
        while (extended && !near(chain[0]!, chain[chain.length - 1]!)) {
            extended = false;
            const tail = chain[chain.length - 1]!;
            for (let j = 0; j < open.length; j++) {
                if (used[j]) continue;
                const piece = open[j]!;
                if (near(piece[0]!, tail)) {
                    chain.push(...piece.slice(1));
                } else if (near(piece[piece.length - 1]!, tail)) {
                    chain.push(...piece.slice(0, -1).reverse());
                } else {
                    continue;
                }
                used[j] = true;
                extended = true;
                break;
            }
        }
        const ring = clean_ring(chain);
        if (near(chain[0]!, chain[chain.length - 1]!) && ring.length >= 3) {
            loops.push(ring);
        } else {
            open_chains++;
        }
    }

    return { loops, open_chains };
}

/**
 * Loops sorted into outlines and their holes by nesting depth: even depth is
 * material, odd is a cutout, and each cutout belongs to the outline one level
 * up that contains it.
 */
function nest(loops: Path[]): SubstrateOutline[] {
    const inside = (outer: Path, inner: Path) =>
        polygon_contains(outer, inner[0]!);
    const depth = loops.map(
        (loop, i) =>
            loops.filter((other, j) => j !== i && inside(other, loop)).length,
    );

    const outlines: SubstrateOutline[] = [];
    loops.forEach((outline, i) => {
        if (depth[i]! % 2 !== 0) return;
        const holes = loops.filter(
            (hole, j) => depth[j] === depth[i]! + 1 && inside(outline, hole),
        );
        outlines.push({ outline, holes });
    });
    return outlines;
}

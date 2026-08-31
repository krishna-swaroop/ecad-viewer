import { expect } from "@esm-bundle/chai";

import { Vec2 } from "../src/base/math";
import {
    triangulate,
    triangulation_backend,
    triangulation_ready,
} from "../src/graphics/webgl/triangulate";

/**
 * Polygon triangulation.
 *
 * The wasm triangulator emits a *different* triangle set than the JS earcut it
 * replaces -- same ear-clipping algorithm, different clipping order -- so
 * nothing here may assert particular indices or particular vertices.
 *
 * Nor is the vertex count a useful check: every complete triangulation of a
 * simple n-gon has exactly n-2 triangles, so the count is fixed by the input
 * regardless of which implementation ran, and a backend that silently produced
 * garbage of the right size would sail past it.
 *
 * What the renderer actually depends on is that the triangles tile the ring.
 * That is what these assert, via the same area-deviation metric earcut's own
 * test suite uses.
 */

/** Shoelace area of a ring. */
function ring_area(points: Vec2[]): number {
    let sum = 0;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const a = points[j]!;
        const b = points[i]!;
        sum += (a.x - b.x) * (b.y + a.y);
    }
    return Math.abs(sum / 2);
}

/** Summed area of a triangle soup laid out as interleaved xy. */
function soup_area(verts: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < verts.length; i += 6) {
        const ax = verts[i]!;
        const ay = verts[i + 1]!;
        const bx = verts[i + 2]!;
        const by = verts[i + 3]!;
        const cx = verts[i + 4]!;
        const cy = verts[i + 5]!;
        sum += Math.abs((ax - cx) * (by - ay) - (ax - bx) * (cy - ay));
    }
    return sum / 2;
}

function deviation(points: Vec2[]): number {
    const area = ring_area(points);
    return Math.abs(soup_area(triangulate(points)) - area) / area;
}

/**
 * The tolerance is set by the float32 vertex buffer, not by the triangulator.
 * Both backends round their output to float32 -- that is what the GPU takes --
 * so on a ring of radius 100 the area of the reassembled soup lands about 2e-8
 * off, and the JS path measures the *same* 1.9654247945804127e-8 to the last
 * digit. Recomputing the same triangulation in float64 brings it to 1.2e-16,
 * which is what confirms the residue is the cast and nothing else.
 *
 * 1e-6 therefore sits ~30x above the float32 floor and many orders below any
 * real defect: a stale heap view or a dropped ear shows up as a deviation near
 * 1, not near 1e-7.
 */
const F32_AREA_TOLERANCE = 1e-6;

/** A comb: concave, self-adjacent, the shape ear clipping is worst at. */
function comb(teeth: number): Vec2[] {
    const points: Vec2[] = [];
    for (let i = 0; i < teeth; i++) {
        points.push(new Vec2(i * 2, 0));
        points.push(new Vec2(i * 2, 10));
        points.push(new Vec2(i * 2 + 1, 10));
        points.push(new Vec2(i * 2 + 1, 0));
    }
    points.push(new Vec2(teeth * 2, -5));
    points.push(new Vec2(0, -5));
    return points;
}

/** A many-vertex ring, the size at which earcut switches on z-order hashing. */
function circle(n: number, r = 100): Vec2[] {
    const points: Vec2[] = [];
    for (let i = 0; i < n; i++) {
        const t = (i / n) * Math.PI * 2;
        points.push(new Vec2(Math.cos(t) * r, Math.sin(t) * r));
    }
    return points;
}

suite("polygon triangulation", function () {
    suiteSetup(async function () {
        await triangulation_ready();
    });

    test("uses the wasm backend", function () {
        // If this ever fails the viewer is still correct, just slower -- but
        // it means the wasm module stopped loading, which is worth knowing.
        expect(triangulation_backend()).to.equal("wasm");
    });

    test("passes a triangle straight through", function () {
        const points = [new Vec2(0, 0), new Vec2(10, 0), new Vec2(0, 10)];
        const verts = triangulate(points);

        expect(Array.from(verts)).to.deep.equal([0, 0, 10, 0, 0, 10]);
    });

    test("tiles a convex ring", function () {
        expect(deviation(circle(64))).to.be.lessThan(F32_AREA_TOLERANCE);
    });

    test("tiles a ring large enough to trigger z-order hashing", function () {
        // earcut only builds the z-order index above 80 points, so this covers
        // a materially different path through the algorithm than the small
        // rings above.
        expect(deviation(circle(2000))).to.be.lessThan(F32_AREA_TOLERANCE);
    });

    test("tiles a deeply concave ring", function () {
        expect(deviation(comb(40))).to.be.lessThan(F32_AREA_TOLERANCE);
    });

    test("emits n-2 triangles", function () {
        const points = circle(64);
        const verts = triangulate(points);

        expect(verts.length).to.equal((points.length - 2) * 3 * 2);
    });

    test("survives a repeat call after growing the arena", function () {
        // The wasm coordinate arena is reused across calls and resized to fit,
        // which can detach the heap views. A big polygon followed by a small
        // one is the sequence that catches a stale view.
        triangulate(circle(5000));
        expect(deviation(circle(16))).to.be.lessThan(F32_AREA_TOLERANCE);
    });
});

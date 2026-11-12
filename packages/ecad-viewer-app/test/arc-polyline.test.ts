/**
 * Arc.to_polyline walks an arc from its start to its end, in the arc's own
 * direction, through its mid point.
 */
import { expect } from "@esm-bundle/chai";

import { Angle, Arc, Vec2 } from "../src/base/math";

function close(a: Vec2, b: Vec2) {
    expect(a.x).to.be.closeTo(b.x, 1e-6);
    expect(a.y).to.be.closeTo(b.y, 1e-6);
}

/** Whether a point of the polyline lies within `tol` of `p`. */
function passes_near(points: Vec2[], p: Vec2, tol: number) {
    return points.some((q) => Math.hypot(q.x - p.x, q.y - p.y) <= tol);
}

suite("Arc.to_polyline", () => {
    // Three points on the unit circle. Through (0, 1) the arc from (1, 0) to
    // (-1, 0) is a half turn one way; through (0, -1) it is the other way.
    const cases: [string, Vec2, Vec2, Vec2][] = [
        [
            "counterclockwise half",
            new Vec2(1, 0),
            new Vec2(0, 1),
            new Vec2(-1, 0),
        ],
        ["clockwise half", new Vec2(1, 0), new Vec2(0, -1), new Vec2(-1, 0)],
        // 270 degrees, clockwise: start at (1, 0), end at (0, 1), through (-1, 0).
        [
            "clockwise major",
            new Vec2(1, 0),
            new Vec2(-Math.SQRT1_2, -Math.SQRT1_2),
            new Vec2(0, 1),
        ],
        [
            "counterclockwise major",
            new Vec2(0, 1),
            new Vec2(-Math.SQRT1_2, -Math.SQRT1_2),
            new Vec2(1, 0),
        ],
    ];

    for (const [name, start, mid, end] of cases) {
        test(`${name}: starts at start, ends at end, passes mid`, () => {
            const points = Arc.from_three_points(start, mid, end).to_polyline();
            close(points[0]!, start);
            close(points[points.length - 1]!, end);
            expect(passes_near(points, mid, 0.06)).to.equal(true);
            for (const p of points) {
                expect(Math.hypot(p.x, p.y)).to.be.closeTo(1, 1e-6);
            }
        });
    }

    test("a full circle closes on itself", () => {
        const points = new Arc(
            new Vec2(0, 0),
            2,
            new Angle(0),
            new Angle(2 * Math.PI),
            0,
        ).to_polyline();
        close(points[0]!, points[points.length - 1]!);
        expect(passes_near(points, new Vec2(-2, 0), 1e-6)).to.equal(true);
    });
});

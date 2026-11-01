import { expect } from "@esm-bundle/chai";

import { FilledPolygon, Poly } from "../src/kicad/board";

/**
 * Zone fills keep their points packed (see FilledPolygon). Everything a
 * caller can read must match what the general Poly gives for the same data.
 */

function fill_data(pts: object[]) {
    return {
        layer: "F.Cu",
        pts,
        width: 0,
        fill: "solid",
        island: false,
        stroke: { width: 0, type: "solid" },
    } as any;
}

const ring = [
    { x: 1.5, y: 2 },
    { x: 10, y: 2 },
    { x: 10, y: 7.25 },
    { x: 4, y: 9 },
    { x: 1.5, y: 2 },
];

suite("FilledPolygon", function () {
    test("packs a fill without arcs", function () {
        const fill = new FilledPolygon(fill_data(ring));
        expect(fill.pts).to.have.length(0);
        expect(fill.point_count).to.equal(ring.length);
        expect(Array.from(fill.coords)).to.deep.equal(
            ring.flatMap((p) => [p.x, p.y]),
        );
    });

    test("reads like the general Poly", function () {
        const fill = new FilledPolygon(fill_data(ring));
        const poly = new Poly(fill_data(ring));
        expect(fill.points.map((p) => [p.x, p.y])).to.deep.equal(
            poly.points.map((p) => [p.x, p.y]),
        );
        const a = fill.bbox;
        const b = poly.bbox;
        expect([a.x, a.y, a.w, a.h]).to.deep.equal([b.x, b.y, b.w, b.h]);
    });

    test("keeps a fill with arcs in the general form", function () {
        const with_arc = [
            { x: 0, y: 0 },
            {
                start: { x: 10, y: 0 },
                mid: { x: 12, y: 5 },
                end: { x: 10, y: 10 },
            },
            { x: 0, y: 10 },
        ];
        const fill = new FilledPolygon(fill_data(with_arc));
        const poly = new Poly(fill_data(with_arc));
        expect(fill.pts).to.have.length(3);
        expect(fill.point_count).to.equal(poly.points.length);
        expect(fill.points.map((p) => [p.x, p.y])).to.deep.equal(
            poly.points.map((p) => [p.x, p.y]),
        );
        expect(Array.from(fill.coords)).to.deep.equal(
            poly.points.flatMap((p) => [p.x, p.y]),
        );
    });

    test("an empty fill has no points", function () {
        const fill = new FilledPolygon(fill_data([]));
        expect(fill.point_count).to.equal(0);
        expect(fill.points).to.have.length(0);
    });
});

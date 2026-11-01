import { expect } from "@esm-bundle/chai";

import { Matrix3, Vec2 } from "../src/base/math";
import { Color, Polygon } from "../src/graphics";
import { NullRenderer } from "../src/graphics/null-renderer";
import {
    triangulate,
    triangulate_flat,
    triangulation_ready,
} from "../src/graphics/webgl/triangulate";

/**
 * Large zone fills are triangulated in the parser workers and the triangles
 * ride on FilledPolygon to the zone painter, which presets them on the
 * Polygon so the tesselator skips it. These cover the two contracts that
 * makes safe: the workers' entry point gives what the main thread would, and
 * preset triangles never survive a transform they were not made under.
 */

/** Expose the protected prep step the WebGL renderer runs on polygons. */
class PrepRenderer extends NullRenderer {
    prep(polygon: Polygon) {
        return this.prep_polygon(polygon);
    }
}

function square(): Vec2[] {
    return [new Vec2(0, 0), new Vec2(10, 0), new Vec2(10, 10), new Vec2(0, 10)];
}

suite("zone fill triangles from workers", function () {
    suiteSetup(async function () {
        await triangulation_ready();
    });

    test("triangulate_flat matches triangulate", function () {
        const points: Vec2[] = [];
        for (let i = 0; i < 300; i++) {
            const t = (i / 300) * Math.PI * 2;
            const r = i % 2 ? 50 : 80;
            points.push(new Vec2(Math.cos(t) * r, Math.sin(t) * r));
        }
        const flat = new Float64Array(points.length * 2);
        points.forEach((p, i) => {
            flat[i * 2] = p.x;
            flat[i * 2 + 1] = p.y;
        });
        expect(Array.from(triangulate_flat(flat))).to.deep.equal(
            Array.from(triangulate(points)),
        );
    });

    test("keeps preset triangles under the identity transform", function () {
        const r = new PrepRenderer();
        const preset = new Float32Array([0, 0, 10, 0, 10, 10]);
        const polygon = new Polygon(square(), Color.white);
        polygon.vertices = preset;

        expect(r.prep(polygon).vertices).to.equal(preset);
    });

    test("drops preset triangles under any other transform", function () {
        const r = new PrepRenderer();
        r.state.matrix = Matrix3.translation(5, 5);
        const polygon = new Polygon(square(), Color.white);
        polygon.vertices = new Float32Array([0, 0, 10, 0, 10, 10]);

        const prepped = r.prep(polygon);
        expect(prepped.vertices).to.equal(undefined);
        expect(prepped.points[0]!.x).to.equal(5);
    });
});

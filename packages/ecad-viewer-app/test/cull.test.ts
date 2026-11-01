/**
 * View culling for large WebGL layers (IN-30).
 */
import { expect } from "@esm-bundle/chai";
import { BoardParser } from "kicad-parser";

import { BBox, Matrix3 } from "../src/base/math";
import {
    build_ranges,
    cull_settings,
    cull_stats,
    cull_triangles,
    plan_cells,
    view_box,
    visible_draws,
    type Box,
} from "../src/graphics/webgl/cull";
import type { WebGL2Renderer } from "../src/graphics/webgl";
import { KicadPCB } from "../src/kicad";
import themes from "../src/kicanvas/themes";
import { BoardViewer } from "../src/viewers/board/viewer";

const box = (x: number, y: number, w = 1, h = 1): Box => ({
    x0: x,
    y0: y,
    x1: x + w,
    y1: y + h,
});

suite("cull: planning", () => {
    test("small layers are left alone", () => {
        const items = Array.from({ length: 100 }, (_, i) => box(i, 0));
        expect(plan_cells(items, (b) => b)).to.equal(null);
    });

    test("a large layer is ordered by cell, stably", () => {
        // 1024 unit boxes on a 32 × 32 lattice → a 4 × 4 grid.
        const items = Array.from({ length: 1024 }, (_, i) =>
            box((i % 32) * 2, Math.floor(i / 32) * 2),
        );
        const plan = plan_cells(items, (b) => b)!;
        expect(plan).to.not.equal(null);
        expect(plan.order).to.have.length(1024);
        for (let i = 1; i < plan.cells.length; i++)
            expect(plan.cells[i]).to.be.at.least(plan.cells[i - 1]!);
        // Within a cell, original order is kept.
        const first_cell = plan.order.filter((_, i) => plan.cells[i] === 0);
        const indices = first_cell.map((b) => items.indexOf(b));
        expect(indices).to.deep.equal([...indices].sort((a, b) => a - b));
    });

    test("few huge items qualify by points", () => {
        const items = Array.from({ length: 64 }, (_, i) => box(i * 3, 0));
        expect(plan_cells(items, (b) => b)).to.equal(null);
        expect(
            plan_cells(
                items,
                (b) => b,
                () => 200,
            ),
        ).to.not.equal(null);
    });

    test("the switch turns planning off", () => {
        const items = Array.from({ length: 1024 }, (_, i) => box(i, i));
        cull_settings.enabled = false;
        try {
            expect(plan_cells(items, (b) => b)).to.equal(null);
        } finally {
            cull_settings.enabled = true;
        }
    });

    test("ranges cover every vertex once, bounded by their members", () => {
        const items = Array.from({ length: 1024 }, (_, i) =>
            box((i % 32) * 2, Math.floor(i / 32) * 2),
        );
        const plan = plan_cells(items, (b) => b)!;
        // 6 vertices per item.
        const starts = plan.order.map((_, i) => i * 6).concat(1024 * 6);
        const ranges = build_ranges(plan, starts);
        expect(ranges.reduce((n, r) => n + r.count, 0)).to.equal(1024 * 6);
        for (let i = 1; i < ranges.length; i++)
            expect(ranges[i]!.first).to.equal(
                ranges[i - 1]!.first + ranges[i - 1]!.count,
            );
        for (const [i, b] of plan.boxes.entries()) {
            const r = ranges.find(
                (r) => starts[i]! >= r.first && starts[i]! < r.first + r.count,
            )!;
            expect(b.x0).to.be.at.least(r.x0);
            expect(b.x1).to.be.at.most(r.x1);
        }
    });

    test("visible ranges merge into as few draws as possible", () => {
        const ranges = [
            { first: 0, count: 6, ...box(0, 0) },
            { first: 6, count: 6, ...box(2, 0) },
            { first: 12, count: 6, ...box(50, 50) },
            { first: 18, count: 6, ...box(4, 0) },
        ];
        expect(visible_draws(ranges, box(0, 0, 10, 2))).to.deep.equal([
            [0, 12],
            [18, 6],
        ]);
        expect(visible_draws(ranges, box(100, 100))).to.deep.equal([]);
    });

    test("the view box inverts the full matrix, rotation included", () => {
        const m = Matrix3.scaling(0.1, 0.1).rotate_self(Math.PI / 2);
        const v = view_box(m.inverse());
        expect(v.x0).to.be.closeTo(-10, 1e-4);
        expect(v.x1).to.be.closeTo(10, 1e-4);
        expect(v.y0).to.be.closeTo(-10, 1e-4);
        expect(v.y1).to.be.closeTo(10, 1e-4);
    });
});

suite("cull: triangles", () => {
    test("a large triangle list is regrouped by cell, keeping each triangle whole", () => {
        // 4096 tiny triangles on a 64 × 64 lattice, colour = triangle index.
        const n = 4096;
        const positions = new Float32Array(n * 6);
        const colors = new Float32Array(n * 12);
        for (let t = 0; t < n; t++) {
            const x = (t % 64) * 2;
            const y = Math.floor(t / 64) * 2;
            positions.set([x, y, x + 1, y, x, y + 1], t * 6);
            colors.fill(t, t * 12, t * 12 + 12);
        }
        const ranges = cull_triangles(positions, colors, 4)!;
        expect(ranges).to.not.equal(null);
        expect(ranges.reduce((s, r) => s + r.count, 0)).to.equal(n * 3);
        const seen = new Set<number>();
        for (let t = 0; t < n; t++) {
            // Each triangle keeps its own colour on all 3 vertices.
            const c = colors[t * 12]!;
            expect(colors[t * 12 + 11]).to.equal(c);
            // ...and its own geometry.
            const x = positions[t * 6]!;
            expect(positions[t * 6 + 2]).to.equal(x + 1);
            seen.add(c);
        }
        expect(seen.size).to.equal(n);
        // A small view sees a small share.
        const view = box(0, 0, 10, 10);
        const drawn = visible_draws(ranges, view).reduce((s, d) => s + d[1], 0);
        expect(drawn).to.be.lessThan((n * 3) / 8);
    });

    test("small triangle lists are left alone", () => {
        expect(
            cull_triangles(new Float32Array(600), new Float32Array(1200), 4),
        ).to.equal(null);
    });
});

// A busy board: 1200 tracks over a 120 × 80 mm area plus a plane fill.
function busy_board(): string {
    const segments: string[] = [];
    for (let i = 0; i < 1200; i++) {
        const x = (i % 40) * 3;
        const y = Math.floor(i / 40) * 2.6;
        segments.push(
            `(segment (start ${x} ${y}) (end ${x + 2.2} ${y + 1}) (width 0.25) (layer "F.Cu") (net ${(i % 3) + 1}) (uuid "s${i}"))`,
        );
    }
    const plane: string[] = [];
    for (let i = 0; i <= 60; i++) plane.push(`(xy ${i * 2} 0)`);
    for (let i = 60; i >= 0; i--)
        plane.push(`(xy ${i * 2} ${80 + (i % 2) * 0.5})`);
    return `(kicad_pcb (version 20240108) (generator "pcbnew") (paper "A3")
  (layers (0 "F.Cu" signal) (1 "In1.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (net 0 "") (net 1 "A") (net 2 "B") (net 3 "C")
  (gr_rect (start 0 0) (end 122 82) (layer "Edge.Cuts") (width 0.1))
  ${segments.join("\n  ")}
  (zone (net 3) (net_name "C") (layer "In1.Cu") (uuid "plane") (hatch edge 0.5)
    (connect_pads (clearance 0.2)) (min_thickness 0.2)
    (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5))
    (polygon (pts ${plane.join(" ")}))
    (filled_polygon (layer "In1.Cu") (pts ${plane.join(" ")})))
)`;
}

async function mount(): Promise<BoardViewer> {
    const canvas = document.createElement("canvas");
    Object.assign(canvas.style, {
        position: "fixed",
        left: "0px",
        top: "0px",
        width: "800px",
        height: "600px",
    });
    document.body.append(canvas);
    const viewer = new BoardViewer(canvas, false, themes.default.board);
    await viewer.setup();
    await viewer.load(
        new KicadPCB(
            "busy.kicad_pcb",
            new BoardParser().parse(busy_board()) as never,
        ),
    );
    await viewer.loaded;
    return viewer;
}

function main_pixels(viewer: BoardViewer) {
    const gl = (viewer.renderer as WebGL2Renderer).gl!;
    viewer.draw_now();
    const { width, height } = viewer.canvas;
    const px = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
}

suite("cull: a busy board", () => {
    test("the main view is pixel-identical with culling on and off", async () => {
        cull_settings.enabled = false;
        const plain = await mount();
        const a = main_pixels(plain);
        plain.dispose();
        plain.canvas.remove();
        cull_settings.enabled = true;
        const culled = await mount();
        const b = main_pixels(culled);
        culled.dispose();
        culled.canvas.remove();
        let differing = 0;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differing++;
        expect(differing).to.equal(0);
    });

    test("a zoomed-in view submits a small share of the culled vertices", async () => {
        const viewer = await mount();
        try {
            const camera = viewer.viewport.camera;
            camera.center.set(10, 10);
            camera.zoom = 60;
            cull_stats.reset();
            viewer.draw_now();
            expect(cull_stats.held).to.be.greaterThan(0);
            expect(cull_stats.drawn / cull_stats.held).to.be.lessThan(0.2);
        } finally {
            viewer.dispose();
            viewer.canvas.remove();
        }
    });

    test("a zoomed-in view is pixel-identical with culling on and off", async () => {
        // Where culling actually skips geometry, the output must not change.
        const zoomed = async (cull: boolean) => {
            cull_settings.enabled = cull;
            const viewer = await mount();
            viewer.viewport.camera.bbox = new BBox(20, 15, 30, 20);
            cull_stats.reset();
            const px = main_pixels(viewer);
            const stats = { drawn: cull_stats.drawn, held: cull_stats.held };
            viewer.dispose();
            viewer.canvas.remove();
            cull_settings.enabled = true;
            return { px, stats };
        };
        const plain = await zoomed(false);
        const culled = await zoomed(true);
        expect(culled.stats.drawn).to.be.lessThan(culled.stats.held);
        let differing = 0;
        for (let i = 0; i < plain.px.length; i++)
            if (plain.px[i] !== culled.px[i]) differing++;
        expect(differing).to.equal(0);
    });
});

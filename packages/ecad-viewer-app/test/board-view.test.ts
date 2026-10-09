/**
 * Board insets (IN-02): rendering the board through another camera into a
 * 2D canvas from the board viewer's own WebGL context.
 */
import { expect } from "@esm-bundle/chai";
import { BoardParser } from "kicad-parser";

import { Matrix3, Vec2 } from "../src/base/math";
import type { WebGL2Renderer } from "../src/graphics/webgl";
import { KicadPCB } from "../src/kicad";
import themes from "../src/kicanvas/themes";
import {
    BoardInsetProvider,
    inset_matrix,
    type InsetCamera,
} from "../src/ecad-viewer/insets";
import { board_view_stats } from "../src/viewers/board/board-view";
import { BoardViewer } from "../src/viewers/board/viewer";

// R1 on F.Cu, C1 on B.Cu, a track on each copper layer.
const BOARD = `
(kicad_pcb
  (version 20240108)
  (generator "pcbnew")
  (paper "A4")
  (layers
    (0 "F.Cu" signal)
    (31 "B.Cu" signal)
    (44 "Edge.Cuts" user)
  )
  (net 0 "")
  (net 1 "VBUS")
  (net 2 "GND")
  (gr_rect (start 0 0) (end 40 30) (layer "Edge.Cuts") (width 0.1))
  (footprint "R_0805" (layer "F.Cu") (at 10 10) (uuid "fp-r1")
    (property "Reference" "R1" (at 0 -2 0) (layer "F.SilkS") (uuid "r1-ref") (effects (font (size 1 1) (thickness 0.15))))
    (pad "1" smd rect (at -1 0) (size 1.2 1.2) (layers "F.Cu" "F.Paste" "F.Mask") (net 1 "VBUS") (uuid "r1-1"))
    (pad "2" smd rect (at 1 0) (size 1.2 1.2) (layers "F.Cu" "F.Paste" "F.Mask") (net 2 "GND") (uuid "r1-2"))
  )
  (footprint "C_0805" (layer "B.Cu") (at 30 20) (uuid "fp-c1")
    (property "Reference" "C1" (at 0 -2 0) (layer "B.SilkS") (uuid "c1-ref") (effects (font (size 1 1) (thickness 0.15))))
    (pad "1" smd rect (at -1 0) (size 1.2 1.2) (layers "B.Cu" "B.Paste" "B.Mask") (net 1 "VBUS") (uuid "c1-1"))
    (pad "2" smd rect (at 1 0) (size 1.2 1.2) (layers "B.Cu" "B.Paste" "B.Mask") (net 2 "GND") (uuid "c1-2"))
  )
  (segment (start 9 10) (end 29 20) (width 0.6) (layer "F.Cu") (net 1) (uuid "seg-f"))
  (segment (start 11 10) (end 31 20) (width 0.6) (layer "B.Cu") (net 2) (uuid "seg-b"))
)
`;

function board(): KicadPCB {
    return new KicadPCB(
        "inset.kicad_pcb",
        new BoardParser().parse(BOARD) as never,
    );
}

async function mount(w = 800, h = 600): Promise<BoardViewer> {
    const canvas = document.createElement("canvas");
    Object.assign(canvas.style, {
        position: "fixed",
        left: "0px",
        top: "0px",
        width: `${w}px`,
        height: `${h}px`,
    });
    document.body.append(canvas);
    const viewer = new BoardViewer(canvas, false, themes.default.board);
    await viewer.setup();
    await viewer.load(board());
    await viewer.loaded;
    viewer.draw_now();
    return viewer;
}

function unmount(viewer: BoardViewer) {
    const canvas = viewer.canvas;
    viewer.dispose();
    canvas.remove();
}

function inset_canvas(w = 240, h = 180) {
    const canvas = document.createElement("canvas");
    Object.assign(canvas.style, {
        position: "fixed",
        left: "900px",
        top: "0px",
        width: `${w}px`,
        height: `${h}px`,
    });
    document.body.append(canvas);
    return canvas;
}

const gl_of = (viewer: BoardViewer) => (viewer.renderer as WebGL2Renderer).gl!;

function read_main(viewer: BoardViewer): Uint8Array {
    const gl = gl_of(viewer);
    const { width, height } = viewer.canvas;
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return pixels;
}

function distinct_colors(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d")!;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const seen = new Set<number>();
    for (let i = 0; i < data.length; i += 4 * 37)
        seen.add((data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!);
    return seen.size;
}

function camera_on(viewer: BoardViewer, reference: string): InsetCamera {
    const fp = viewer.board.footprints.find((f) => f.reference === reference)!;
    const b = fp.bbox;
    return {
        center: new Vec2(b.x + b.w / 2, b.y + b.h / 2),
        zoom: 20,
        rotation: 0,
        mirror: false,
    };
}

suite("board insets: provider", () => {
    let viewer: BoardViewer;
    let provider: BoardInsetProvider;

    setup(async () => {
        viewer = await mount();
        provider = new BoardInsetProvider(() => viewer);
    });
    teardown(() => unmount(viewer));

    test("a top-side pad resolves to its footprint, pad centre and net", async () => {
        const t = (await provider.resolve("R1", "1"))!;
        expect(t.kind).to.equal("pcb");
        expect(t.side).to.equal("top");
        expect(t.mirror).to.equal(false);
        expect(t.detail).to.equal("VBUS");
        expect(t.anchor.x).to.be.closeTo(9, 1e-6);
        expect(t.anchor.y).to.be.closeTo(10, 1e-6);
        const fp = viewer.board.footprints.find((f) => f.reference === "R1")!;
        expect(t.focus).to.deep.equal(fp.bbox);
    });

    test("the target carries its pad box, and pads are hit-tested", async () => {
        const t = (await provider.resolve("R1", "1"))!;
        const fp = viewer.board.footprints.find((f) => f.reference === "R1")!;
        expect(t.anchor_box).to.deep.equal(fp.pad_by_number("1").bbox);
        const hit = provider.hit_test(t, new Vec2(11, 10))!;
        expect(hit.reference).to.equal("R1");
        expect(hit.number).to.equal("2");
        expect(provider.hit_test(t, new Vec2(20, 2))).to.equal(null);
    });

    test("a bottom-side footprint opens mirrored", async () => {
        const t = (await provider.resolve("C1", "2"))!;
        expect(t.side).to.equal("bottom");
        expect(t.mirror).to.equal(true);
        expect(t.detail).to.equal("GND");
    });

    test("an unknown pad anchors at the footprint centre; an unknown part is null", async () => {
        const t = (await provider.resolve("R1", "9"))!;
        expect(t.anchor.x).to.be.closeTo(10, 1e-6);
        expect(t.detail).to.equal(undefined);
        expect(await provider.resolve("U99", "1")).to.equal(null);
    });

    test("no board yet resolves to null", async () => {
        const empty = new BoardInsetProvider(() => null);
        expect(await empty.resolve("R1", "1")).to.equal(null);
    });
});

suite("board insets: render_view", () => {
    let viewer: BoardViewer;
    let target: HTMLCanvasElement;

    setup(async () => {
        viewer = await mount();
        target = inset_canvas();
        board_view_stats.reset();
    });
    teardown(() => {
        unmount(viewer);
        target.remove();
    });

    test("draws the board into the inset canvas at device resolution", () => {
        const camera = camera_on(viewer, "R1");
        const drawn = viewer.render_view(target, (w, h) =>
            inset_matrix(camera, w, h),
        );
        expect(drawn).to.equal(true);
        const dpr = window.devicePixelRatio || 1;
        expect(target.width).to.equal(Math.round(240 * dpr));
        expect(target.height).to.equal(Math.round(180 * dpr));
        // Background, copper and pads: more than one colour.
        expect(distinct_colors(target)).to.be.greaterThan(1);
        expect(board_view_stats.frames).to.equal(1);
        expect(board_view_stats.grown).to.equal(0);
    });

    test("restores the main canvas size, viewport, scissor and projection", () => {
        const gl = gl_of(viewer);
        const renderer = viewer.renderer as WebGL2Renderer;
        const before = {
            w: viewer.canvas.width,
            h: viewer.canvas.height,
            viewport: Array.from(gl.getParameter(gl.VIEWPORT) as Int32Array),
            projection: renderer.projection_matrix,
        };
        const camera = camera_on(viewer, "R1");
        viewer.render_view(target, (w, h) => inset_matrix(camera, w, h));
        expect(viewer.canvas.width).to.equal(before.w);
        expect(viewer.canvas.height).to.equal(before.h);
        expect(
            Array.from(gl.getParameter(gl.VIEWPORT) as Int32Array),
        ).to.deep.equal(before.viewport);
        expect(gl.isEnabled(gl.SCISSOR_TEST)).to.equal(false);
        expect(renderer.projection_matrix).to.equal(before.projection);
    });

    test("a visible main frame is pixel-identical after inset frames", () => {
        viewer.draw_now();
        const before = read_main(viewer);
        for (const reference of ["R1", "C1", "R1"]) {
            const camera = camera_on(viewer, reference);
            camera.rotation = 0.4;
            viewer.render_view(target, (w, h) => inset_matrix(camera, w, h), {
                back_on_top: true,
            });
        }
        const after = read_main(viewer);
        let differing = 0;
        for (let i = 0; i < before.length; i++)
            if (before[i] !== after[i]) differing++;
        expect(differing).to.equal(0);
    });

    test("an inactive viewer is not redrawn; it redraws when reactivated", async () => {
        viewer.set_active(false);
        let draws = 0;
        const original = viewer.draw_now.bind(viewer);
        viewer.draw_now = () => {
            draws++;
            original();
        };
        const camera = camera_on(viewer, "R1");
        viewer.render_view(target, (w, h) => inset_matrix(camera, w, h));
        expect(draws).to.equal(0);
        viewer.draw_now = original;
        viewer.set_active(true);
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        // Reactivation schedules a full main frame (Viewer.set_active).
        expect(viewer.active).to.equal(true);
    });

    test("back_on_top raises back layers for that frame only", () => {
        const seen: string[] = [];
        const original = viewer.render_layers.bind(viewer);
        viewer.render_layers = (m: Matrix3) => {
            for (const layer of viewer.layers.in_display_order())
                if (layer.highlighted) seen.push(layer.name);
            original(m);
        };
        const camera = { ...camera_on(viewer, "C1"), mirror: true };
        viewer.render_view(target, (w, h) => inset_matrix(camera, w, h), {
            back_on_top: true,
        });
        viewer.render_layers = original;
        expect(seen.length).to.be.greaterThan(0);
        expect(seen.every((name) => /^:?B\./.test(name))).to.equal(true);
        expect(seen).to.include("B.Cu");
        for (const layer of viewer.layers.in_display_order())
            expect(layer.highlighted).to.equal(false);
    });

    test("an inset larger than the main canvas grows the buffer and restores it", async () => {
        unmount(viewer);
        viewer = await mount(120, 90);
        const big = inset_canvas(400, 300);
        const before = { w: viewer.canvas.width, h: viewer.canvas.height };
        const camera = camera_on(viewer, "R1");
        expect(
            viewer.render_view(big, (w, h) => inset_matrix(camera, w, h)),
        ).to.equal(true);
        expect(board_view_stats.grown).to.equal(1);
        expect(distinct_colors(big)).to.be.greaterThan(1);
        expect(viewer.canvas.width).to.equal(before.w);
        expect(viewer.canvas.height).to.equal(before.h);
        big.remove();
    });

    test("a zero-size inset draws nothing", () => {
        const hidden = inset_canvas(0, 0);
        const camera = camera_on(viewer, "R1");
        expect(
            viewer.render_view(hidden, (w, h) => inset_matrix(camera, w, h)),
        ).to.equal(false);
        hidden.remove();
    });
});

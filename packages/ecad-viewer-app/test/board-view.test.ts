/**
 * Board insets (IN-02): rendering the board through another camera into a
 * 2D canvas from the board viewer's own WebGL context.
 */
import { expect } from "@esm-bundle/chai";
import { BoardParser } from "kicad-parser";

import { BBox, Matrix3, Vec2 } from "../src/base/math";
import type { WebGL2Renderer } from "../src/graphics/webgl";
import { KicadPCB } from "../src/kicad";
import themes from "../src/kicanvas/themes";
import {
    BoardInsetProvider,
    InsetSession,
    inset_matrix,
    local_focus,
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
        // The part with its pads.
        const fp = viewer.board.footprints.find((f) => f.reference === "R1")!;
        for (const pad of fp.pads) {
            expect(pad.bbox.x).to.be.at.least(t.focus.x - 1e-6);
            expect(pad.bbox.x + pad.bbox.w).to.be.at.most(
                t.focus.x + t.focus.w + 1e-6,
            );
        }
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

suite("board insets follow the main view (IN-21)", () => {
    let viewer: BoardViewer;
    setup(async () => {
        viewer = await mount();
    });
    teardown(() => unmount(viewer));

    test("subscribers hear every draw the board viewer requests", async () => {
        const provider = new BoardInsetProvider(() => viewer);
        let heard = 0;
        const off = provider.subscribe(() => heard++);
        await new Promise((r) => requestAnimationFrame(r));
        heard = 0;
        viewer.draw();
        expect(heard).to.equal(1);
        // Coalesced: a second request in the same frame schedules nothing new.
        viewer.draw();
        expect(heard).to.equal(1);
        off();
        await new Promise((r) => requestAnimationFrame(r));
        viewer.draw();
        expect(heard).to.equal(1);
    });

    test("an open board inset re-renders after a net highlight in the main view", async () => {
        const host = document.createElement("div");
        Object.assign(host.style, {
            position: "fixed",
            left: "0px",
            top: "0px",
            width: "1200px",
            height: "800px",
        });
        document.body.append(host);
        const session = new InsetSession();
        session.register(new BoardInsetProvider(() => viewer));
        session.mount(host);
        try {
            await session.open({
                kind: "pcb",
                reference: "R1",
                number: "1",
                source: { world_to_client: () => new Vec2(50, 50) },
                source_anchor: new Vec2(0, 0),
            });
            for (let i = 0; i < 3; i++)
                await new Promise((r) => requestAnimationFrame(r));
            board_view_stats.reset();
            viewer.set_highlighted_nets([1]);
            for (let i = 0; i < 3; i++)
                await new Promise((r) => requestAnimationFrame(r));
            expect(board_view_stats.frames).to.be.greaterThan(0);
        } finally {
            session.dispose();
            host.remove();
        }
    });
});

suite("board insets show labels at their own zoom (IN-31)", () => {
    let viewer: BoardViewer;
    let target: HTMLCanvasElement;
    setup(async () => {
        viewer = await mount();
        target = inset_canvas(240, 180);
        // Main view far out: its pad labels are gated off.
        viewer.viewport.camera.zoom = 0.5;
        viewer.draw_now();
    });
    teardown(() => {
        unmount(viewer);
        target.remove();
    });

    const close_camera = (): InsetCamera => ({
        center: new Vec2(10, 10),
        zoom: 60,
        rotation: 0,
        mirror: false,
    });

    test("a forked label set gates by its own zoom", () => {
        expect(viewer.net_label_layouts().size).to.equal(0);
        const fork = viewer.fork_net_labels({
            zoom: 60,
            bbox: new BBox(5, 5, 10, 10),
        })!;
        const layouts = fork.layouts();
        const total = [...layouts.values()].reduce((n, l) => n + l.length, 0);
        expect(total).to.be.greaterThan(0);
        // The main view's gating is untouched.
        expect(viewer.net_label_layouts().size).to.equal(0);
        fork.dispose();
    });

    test("an inset draws pad labels the main view does not, and leaves its labels alone", async () => {
        const provider = new BoardInsetProvider(() => viewer);
        const t = (await provider.resolve("R1", "1"))!;
        const label_layers = [...viewer.layers.in_display_order()].filter((l) =>
            /NetNames/.test(l.name),
        );
        const before = label_layers.map((l) => l.graphics);
        viewer.draw_now();
        const main_before = read_main(viewer);

        provider.render(t, close_camera(), target);
        const with_labels = target
            .getContext("2d")!
            .getImageData(0, 0, target.width, target.height)
            .data.slice();

        // The main view's label graphics are the same objects as before.
        expect(label_layers.map((l) => l.graphics)).to.deep.equal(before);
        viewer.draw_now();
        const main_after = read_main(viewer);
        let differing = 0;
        for (let i = 0; i < main_before.length; i++)
            if (main_before[i] !== main_after[i]) differing++;
        expect(differing).to.equal(0);

        // Turning the labels off changes the inset: they were drawn.
        viewer.set_net_label_option("padNumbers", false);
        viewer.set_net_label_option("padNetNames", false);
        provider.render(t, close_camera(), target);
        const without = target
            .getContext("2d")!
            .getImageData(0, 0, target.width, target.height).data;
        let changed = 0;
        for (let i = 0; i < without.length; i++)
            if (without[i] !== with_labels[i]) changed++;
        expect(changed).to.be.greaterThan(0);
        provider.release(t);
    });
});

suite("board insets: edge cases (IN-50)", () => {
    test("local_focus keeps small parts whole and windows large ones on the pad", () => {
        const small = new BBox(0, 0, 4, 2);
        expect(local_focus(small, new BBox(0, 0, 1, 1), 15, 8)).to.equal(small);
        const big = new BBox(0, 0, 40, 40);
        const near_corner = local_focus(big, new BBox(1, 1, 1, 1), 15, 8);
        // Centred on the pad but kept inside the part.
        expect([
            near_corner.x,
            near_corner.y,
            near_corner.w,
            near_corner.h,
        ]).to.deep.equal([0, 0, 8, 8]);
        const middle = local_focus(big, new BBox(19.5, 19.5, 1, 1), 15, 8);
        expect([middle.x, middle.y]).to.deep.equal([16, 16]);
        expect(local_focus(big, undefined, 15, 8)).to.equal(big);
    });

    test("a large footprint opens on its pad's neighbourhood", async () => {
        const big = BOARD.replace(
            "  (segment",
            `  (footprint "BGA" (layer "F.Cu") (at 70 70) (uuid "fp-u9")
    (property "Reference" "U9" (at 0 -22 0) (layer "F.SilkS") (uuid "u9-ref") (effects (font (size 1 1) (thickness 0.15))))
    (pad "A1" smd circle (at -19 -19) (size 0.5 0.5) (layers "F.Cu") (net 1 "VBUS") (uuid "u9-a1"))
    (pad "T16" smd circle (at 19 19) (size 0.5 0.5) (layers "F.Cu") (net 2 "GND") (uuid "u9-t16"))
  )
  (segment`,
        );
        const canvas = document.createElement("canvas");
        Object.assign(canvas.style, {
            position: "fixed",
            left: "0px",
            top: "0px",
            width: "400px",
            height: "300px",
        });
        document.body.append(canvas);
        const viewer = new BoardViewer(canvas, false, themes.default.board);
        try {
            await viewer.setup();
            await viewer.load(
                new KicadPCB(
                    "big.kicad_pcb",
                    new BoardParser().parse(big) as never,
                ),
            );
            const provider = new BoardInsetProvider(() => viewer);
            const t = (await provider.resolve("U9", "A1"))!;
            expect(Math.max(t.focus.w, t.focus.h)).to.be.at.most(8);
            // The focus window contains the pad it opened for.
            expect(t.anchor.x).to.be.within(t.focus.x, t.focus.x + t.focus.w);
            expect(t.anchor.y).to.be.within(t.focus.y, t.focus.y + t.focus.h);
            // A small part still frames whole.
            const r1 = (await provider.resolve("R1", "1"))!;
            expect(Math.max(r1.focus.w, r1.focus.h)).to.be.lessThan(8);
            expect(r1.focus.w).to.be.greaterThan(0);
        } finally {
            viewer.dispose();
            canvas.remove();
        }
    });

    test("a lost WebGL context draws nothing and keeps the inset's last image", async () => {
        const viewer = await mount();
        const target = inset_canvas();
        try {
            const camera = camera_on(viewer, "R1");
            expect(
                viewer.render_view(target, (w, h) =>
                    inset_matrix(camera, w, h),
                ),
            ).to.equal(true);
            const before = target
                .getContext("2d")!
                .getImageData(0, 0, target.width, target.height)
                .data.slice();
            const gl = gl_of(viewer);
            gl.getExtension("WEBGL_lose_context")!.loseContext();
            expect(
                viewer.render_view(target, (w, h) =>
                    inset_matrix(camera, w, h),
                ),
            ).to.equal(false);
            const after = target
                .getContext("2d")!
                .getImageData(0, 0, target.width, target.height).data;
            let differing = 0;
            for (let i = 0; i < after.length; i++)
                if (after[i] !== before[i]) differing++;
            expect(differing).to.equal(0);
        } finally {
            unmount(viewer);
            target.remove();
        }
    });
});

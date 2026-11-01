/**
 * PCB measure mode: snap targets, the arithmetic, and the element API
 * (mode, clicks, Escape, the key, and its exclusion with inset mode).
 */
import { expect } from "@esm-bundle/chai";
import { BoardParser } from "kicad-parser";

import "../build/ecad-viewer.js";

import { Vec2 } from "../src/base/math";
import { KicadPCB } from "../src/kicad";
import {
    format_length,
    measure,
    pad_center,
    SnapIndex,
    type MeasureSnap,
} from "../src/viewers/board/measure";
import type { MeasureState } from "../src/viewers/board/measure-tool";
import type { BoardViewer } from "../src/viewers/board/viewer";

// R1 at (20, 10) unrotated; R2 at (30, 20) rotated 90°. An F.Cu track from
// (5, 10) to (15, 10), a B.Cu track from (5, 25) to (15, 25), a via at
// (16, 18) and an arc on F.Cu.
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
  (net 1 "GND")
  (net 2 "SIG")
  (gr_rect (start 0 0) (end 40 30) (layer "Edge.Cuts") (width 0.1))
  (footprint "R_0805" (layer "F.Cu") (at 20 10) (uuid "fp-r1")
    (property "Reference" "R1" (at 0 -2 0) (layer "F.SilkS") (uuid "r1-ref") (effects (font (size 1 1) (thickness 0.15))))
    (pad "1" smd rect (at -1 0) (size 1.2 1.2) (layers "F.Cu" "F.Paste" "F.Mask") (net 1 "GND") (uuid "r1-1"))
    (pad "2" smd rect (at 1 0) (size 1.2 1.2) (layers "F.Cu" "F.Paste" "F.Mask") (net 2 "SIG") (uuid "r1-2"))
  )
  (footprint "R_0805" (layer "F.Cu") (at 30 20 90) (uuid "fp-r2")
    (property "Reference" "R2" (at 0 -2 90) (layer "F.SilkS") (uuid "r2-ref") (effects (font (size 1 1) (thickness 0.15))))
    (pad "1" smd rect (at -1 0 90) (size 1.2 1.2) (layers "F.Cu" "F.Paste" "F.Mask") (net 1 "GND") (uuid "r2-1"))
    (pad "2" smd rect (at 1 0 90) (size 1.2 1.2) (layers "F.Cu" "F.Paste" "F.Mask") (net 2 "SIG") (uuid "r2-2"))
  )
  (segment (start 5 10) (end 15 10) (width 0.25) (layer "F.Cu") (net 2) (uuid "seg-f"))
  (segment (start 5 25) (end 15 25) (width 0.25) (layer "B.Cu") (net 1) (uuid "seg-b"))
  (arc (start 25 5) (mid 27 3) (end 29 5) (width 0.25) (layer "F.Cu") (net 2) (uuid "arc-f"))
  (via (at 16 18) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1) (uuid "via-1"))
)
`;

function board(): KicadPCB {
    return new KicadPCB(
        "measure.kicad_pcb",
        new BoardParser().parse(BOARD) as never,
    );
}

const all = () => true;

suite("PCB measure: snap targets", () => {
    const pcb = board();
    const index = new SnapIndex(pcb);

    test("a pad snaps to its anchor, through the footprint's rotation", () => {
        const r2 = pcb.footprints.find((fp) => fp.reference === "R2")!;
        const pad = r2.pads.find((p) => p.number === "1")!;
        const c = pad_center(pad);
        expect(c.x).to.be.closeTo(30, 1e-9);
        expect(c.y).to.be.closeTo(21, 1e-9);
        // The painter's box for the same pad is centred on the same point.
        const box = pad.bbox;
        expect(box.x + box.w / 2).to.be.closeTo(c.x, 1e-4);
        expect(box.y + box.h / 2).to.be.closeTo(c.y, 1e-4);
    });

    test("a pad centre beats a track under the pointer", () => {
        // R1.1 sits at (19, 10); the F.Cu track ends at (15, 10).
        const snap = index.snap(new Vec2(18.8, 10.1), 0.5, all);
        expect(snap).to.include({
            kind: "pad",
            x: 19,
            y: 10,
            label: "R1 · 1",
            net: "GND",
        });
    });

    test("vias, track ends and centrelines, in that order", () => {
        expect(index.snap(new Vec2(16.1, 18.1), 0.5, all)).to.include({
            kind: "via",
            x: 16,
            y: 18,
            label: "via",
            net: "GND",
        });
        expect(index.snap(new Vec2(15.2, 10.2), 0.5, all)).to.include({
            kind: "track-end",
            x: 15,
            y: 10,
            net: "SIG",
        });
        const mid = index.snap(new Vec2(9.3, 10.2), 0.5, all);
        expect(mid.kind).to.equal("track");
        expect(mid.x).to.be.closeTo(9.3, 1e-9);
        expect(mid.y).to.be.closeTo(10, 1e-9);
        // Arc ends snap too; arcs have no centreline snap.
        expect(index.snap(new Vec2(25.1, 5.1), 0.5, all)).to.include({
            kind: "track-end",
            x: 25,
            y: 5,
        });
    });

    test("nothing in reach is a free point", () => {
        expect(index.snap(new Vec2(35, 3), 0.5, all)).to.deep.equal({
            kind: "free",
            x: 35,
            y: 3,
            label: "",
            net: null,
        });
    });

    test("hidden items do not snap", () => {
        const at = new Vec2(10, 25.1);
        expect(index.snap(at, 0.5, all).kind).to.equal("track");
        expect(index.snap(at, 0.5, () => false).kind).to.equal("free");
    });
});

suite("PCB measure: arithmetic", () => {
    const point = (x: number, y: number): MeasureSnap => ({
        kind: "free",
        x,
        y,
        label: "",
        net: null,
    });

    test("distance, absolute deltas and the angle", () => {
        const m = measure(point(1, 5), point(4, 1));
        expect(m.distance).to.be.closeTo(5, 1e-12);
        expect(m.dx).to.be.closeTo(3, 1e-12);
        expect(m.dy).to.be.closeTo(4, 1e-12);
        expect(m.angle).to.be.closeTo(53.130102, 1e-6);
    });

    test("3 decimals in mm, 1 in mil", () => {
        expect(format_length(7.640941, "mm")).to.equal("7.641 mm");
        expect(format_length(7.640941, "mil")).to.equal("300.8 mil");
    });
});

// --- element ---------------------------------------------------------------

type Host = HTMLElement & {
    replaceSources(update: {
        revisionKey: string;
        sources: Array<{ filename: string; content: string }>;
    }): Promise<void>;
    ready: Promise<void>;
    measureMode: boolean;
    setMeasureMode(on: boolean): void;
    escapeMeasure(): boolean;
    setMeasureUnits(units: "mm" | "mil"): void;
    measureState: MeasureState | null;
    insetMode: boolean;
    setInsetMode(on: boolean): void;
    enableInsets(): void;
};

async function mount_host(): Promise<Host> {
    const host = document.createElement("ecad-viewer") as Host;
    host.setAttribute("show-header", "false");
    host.setAttribute("source-mode", "host");
    host.style.width = "900px";
    host.style.height = "600px";
    await customElements.whenDefined("ecad-viewer");
    document.body.append(host);
    await host.replaceSources({
        revisionKey: "rev-1",
        sources: [{ filename: "measure.kicad_pcb", content: BOARD }],
    });
    await host.ready;
    for (let i = 0; i < 200 && !viewer_of(host)?.board; i++)
        await new Promise((resolve) => setTimeout(resolve, 25));
    await viewer_of(host)!.loaded;
    return host;
}

function viewer_of(host: Host): BoardViewer | undefined {
    const app = host.shadowRoot?.querySelector("kc-board-app") as
        | (HTMLElement & { viewer: BoardViewer })
        | null;
    return app?.viewer;
}

/** Client coordinates of a board point. */
function client(viewer: BoardViewer, x: number, y: number) {
    const rect = viewer.canvas.getBoundingClientRect();
    const p = viewer.viewport.camera.world_to_screen(new Vec2(x, y));
    return { clientX: rect.left + p.x, clientY: rect.top + p.y };
}

function pointer(
    viewer: BoardViewer,
    type: "mousemove" | "click" | "dblclick",
    x: number,
    y: number,
    init: MouseEventInit = {},
) {
    viewer.canvas.dispatchEvent(
        new MouseEvent(type, {
            bubbles: true,
            ...client(viewer, x, y),
            ...init,
        }),
    );
}

function key(init: KeyboardEventInit) {
    window.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, ...init }),
    );
}

suite("PCB measure: element", () => {
    let host: Host;
    let viewer: BoardViewer;
    let states: MeasureState[];
    let modes: boolean[];
    setup(async () => {
        host = await mount_host();
        viewer = viewer_of(host)!;
        states = [];
        modes = [];
        host.addEventListener("ecad-viewer:measure", (e) =>
            states.push((e as CustomEvent<MeasureState>).detail),
        );
        host.addEventListener("ecad-viewer:measure-mode", (e) =>
            modes.push((e as CustomEvent<{ on: boolean }>).detail.on),
        );
    });
    teardown(() => host.remove());

    test("two clicks measure between snapped points; a third starts over", () => {
        host.setMeasureMode(true);
        expect(host.measureMode).to.equal(true);
        expect(modes).to.deep.equal([true]);
        expect(viewer.canvas.style.cursor).to.equal("crosshair");

        pointer(viewer, "click", 19.05, 10.05); // R1.1
        expect(host.measureState?.phase).to.equal("placing");
        pointer(viewer, "mousemove", 16.05, 18.05); // the via, live
        expect(host.measureState?.measurement?.b.kind).to.equal("via");
        pointer(viewer, "click", 16.05, 18.05);

        const done = host.measureState!;
        expect(done.phase).to.equal("done");
        const m = done.measurement!;
        expect(m.a).to.include({ kind: "pad", label: "R1 · 1", x: 19, y: 10 });
        expect(m.b).to.include({ kind: "via", x: 16, y: 18 });
        expect(m.distance).to.be.closeTo(Math.hypot(3, 8), 1e-9);
        expect(states.at(-1)?.phase).to.equal("done");

        pointer(viewer, "click", 30.05, 21.05); // R2.1
        expect(host.measureState?.phase).to.equal("placing");
        expect(host.measureState?.measurement).to.equal(null);
    });

    test("a click in measure mode selects nothing, and two clicks never focus a net", () => {
        let selections = 0;
        host.addEventListener("ecad-viewer:selection", () => selections++);
        viewer.addEventListener("kicanvas:select", () => selections++);
        host.setMeasureMode(true);
        pointer(viewer, "click", 10, 10.05);
        pointer(viewer, "click", 10, 10.05);
        pointer(viewer, "dblclick", 10, 10.05);
        expect(selections).to.equal(0);
        expect([...viewer.highlighted_nets]).to.deep.equal([]);
    });

    test("Shift places a free point", () => {
        host.setMeasureMode(true);
        pointer(viewer, "click", 19.05, 10.05, { shiftKey: true });
        pointer(viewer, "mousemove", 16.05, 18.05, { shiftKey: true });
        const m = host.measureState!.measurement!;
        expect(m.a.kind).to.equal("free");
        // Mouse events land on whole pixels.
        const pixel = 1 / viewer.viewport.camera.zoom;
        expect(m.a.x).to.be.closeTo(19.05, pixel);
        expect(m.b.kind).to.equal("free");
    });

    test("Escape clears the points, then leaves the mode", () => {
        expect(host.escapeMeasure()).to.equal(false);
        host.setMeasureMode(true);
        pointer(viewer, "click", 19.05, 10.05);
        expect(host.escapeMeasure()).to.equal(true);
        expect(host.measureMode).to.equal(true);
        expect(host.measureState?.phase).to.equal("idle");
        expect(host.escapeMeasure()).to.equal(true);
        expect(host.measureMode).to.equal(false);
        expect(viewer.canvas.style.cursor).to.not.equal("crosshair");
        expect(modes).to.deep.equal([true, false]);
    });

    test("Cmd/Ctrl+Shift+M toggles the mode; plain M does not", () => {
        key({ key: "M", shiftKey: true, metaKey: true });
        expect(host.measureMode).to.equal(true);
        key({ key: "M", shiftKey: true, ctrlKey: true });
        expect(host.measureMode).to.equal(false);
        key({ key: "m" });
        expect(host.measureMode).to.equal(false);
    });

    test("measure mode and inset mode exclude each other", () => {
        host.enableInsets();
        host.setInsetMode(true);
        host.setMeasureMode(true);
        expect(host.insetMode).to.equal(false);
        expect(host.measureMode).to.equal(true);
        host.setInsetMode(true);
        expect(host.measureMode).to.equal(false);
    });
});

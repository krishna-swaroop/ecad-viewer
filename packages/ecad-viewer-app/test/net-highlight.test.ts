/**
 * Multi-net highlighting (Prism #305 / #306).
 *
 * The board viewer keeps a set of highlighted net codes and paints it as a
 * dim pass plus the members repainted on top; the native layers are never
 * hidden. Labels of highlighted nets are repeated above the dim. Shift-click
 * toggles the net under the cursor and resolves a pad-over-track hit without
 * a pop-up. The element resolves host net names and reports its own changes.
 */
import { expect } from "@esm-bundle/chai";
import { BoardParser } from "kicad-parser";

import "../build/ecad-viewer.js";

import { Vec2 } from "../src/base/math";
import { KicadPCB } from "../src/kicad";
import * as board_items from "../src/kicad/board";
import themes from "../src/kicanvas/themes";
import {
    CopperVirtualLayerNames,
    LayerNames,
    LayerSet,
    virtual_layer_for,
} from "../src/viewers/board/layers";
import { EMPHASIS_LABEL_CHANNEL } from "../src/viewers/board/net-label-layers";
import { HIGHLIGHT_DIM_OPACITY } from "../src/viewers/board/painter";
import {
    BoardViewer,
    pick_item,
    shared_net,
} from "../src/viewers/board/viewer";
import { KiCanvasSelectEvent } from "../src/viewers/base/events";
import { Depth } from "../src/kicad/board_bbox_visitor";

// Two nets. NET_A: R1.1 (SMD, F.Cu), a 10 mm F.Cu track whose end sits
// under R1.1 (a pad-over-track hit), a B.Cu track running under R1.2 (a
// pad over another net's track), a via and a filled B.Cu zone. NET_B: R1.2
// and a 3 mm In1.Cu track. R2.1 is unconnected.
const BOARD = `
(kicad_pcb
  (version 20240108)
  (generator "pcbnew")
  (paper "A4")
  (layers
    (0 "F.Cu" signal)
    (1 "In1.Cu" signal)
    (31 "B.Cu" signal)
    (44 "Edge.Cuts" user)
  )
  (net 0 "")
  (net 1 "NET_A")
  (net 2 "NET_B")
  (gr_rect (start 0 0) (end 40 30) (layer "Edge.Cuts") (width 0.1))
  (footprint "R_0805" (layer "F.Cu") (at 20 10) (uuid "fp-r1")
    (property "Reference" "R1" (at 0 -2 0) (layer "F.SilkS") (uuid "r1-ref") (effects (font (size 1 1) (thickness 0.15))))
    (pad "1" smd rect (at -1 0) (size 1.2 1.2) (layers "F.Cu" "F.Paste" "F.Mask") (net 1 "NET_A") (uuid "r1-1"))
    (pad "2" smd rect (at 1 0) (size 1.2 1.2) (layers "F.Cu" "F.Paste" "F.Mask") (net 2 "NET_B") (uuid "r1-2"))
  )
  (footprint "R_0805" (layer "F.Cu") (at 30 20) (uuid "fp-r2")
    (property "Reference" "R2" (at 0 -2 0) (layer "F.SilkS") (uuid "r2-ref") (effects (font (size 1 1) (thickness 0.15))))
    (pad "1" smd rect (at -1 0) (size 1.2 1.2) (layers "F.Cu" "F.Paste" "F.Mask") (uuid "r2-1"))
  )
  (segment (start 9 10) (end 19 10) (width 0.4) (layer "F.Cu") (net 1) (uuid "seg-a"))
  (segment (start 20 9) (end 22 11) (width 0.4) (layer "B.Cu") (net 1) (uuid "seg-a-bcu"))
  (segment (start 21 15) (end 24 15) (width 0.4) (layer "In1.Cu") (net 2) (uuid "seg-b"))
  (via (at 9 10) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1) (uuid "via-a"))
  (zone (net 1) (net_name "NET_A") (layer "B.Cu") (uuid "zone-a") (hatch edge 0.5)
    (connect_pads (clearance 0.5)) (min_thickness 0.25)
    (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5))
    (polygon (pts (xy 2 2) (xy 12 2) (xy 12 12) (xy 2 12)))
    (filled_polygon (layer "B.Cu") (pts (xy 2 2) (xy 12 2) (xy 12 12) (xy 2 12)))
  )
)
`;

function board(): KicadPCB {
    return new KicadPCB(
        "highlight.kicad_pcb",
        new BoardParser().parse(BOARD) as never,
    );
}

async function mount_viewer(): Promise<BoardViewer> {
    const canvas = document.createElement("canvas");
    canvas.width = 800;
    canvas.height = 600;
    document.body.append(canvas);
    const viewer = new BoardViewer(canvas, false, themes.default.board);
    await viewer.setup();
    await viewer.load(board());
    return viewer;
}

function unmount(viewer: BoardViewer) {
    const canvas = viewer.canvas;
    viewer.dispose();
    canvas.remove();
}

function visibility(viewer: BoardViewer): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const layer of viewer.layers.in_ui_order())
        out[layer.name] = layer.visible;
    return out;
}

function layer(viewer: BoardViewer, name: string) {
    return (viewer.layers as LayerSet).by_name(name)!;
}

const F_CU_LABELS = virtual_layer_for(
    LayerNames.f_cu,
    CopperVirtualLayerNames.netnames,
);

const click = (shift: boolean) =>
    new MouseEvent("click", { shiftKey: shift, bubbles: true });

suite("net highlight: board viewer set", () => {
    let viewer: BoardViewer;
    setup(async () => {
        viewer = await mount_viewer();
    });
    teardown(() => unmount(viewer));

    test("replace, add, toggle, remove and clear report whether the set changed", () => {
        expect(viewer.set_highlighted_nets([1])).to.equal(true);
        expect([...viewer.highlighted_nets]).to.deep.equal([1]);
        expect(viewer.set_highlighted_nets([1])).to.equal(false);
        expect(viewer.add_highlighted_net(2)).to.equal(true);
        expect([...viewer.highlighted_nets]).to.deep.equal([1, 2]);
        expect(viewer.add_highlighted_net(2)).to.equal(false);
        expect(viewer.toggle_highlighted_net(1)).to.equal(true);
        expect([...viewer.highlighted_nets]).to.deep.equal([2]);
        expect(viewer.toggle_highlighted_net(1)).to.equal(true);
        expect([...viewer.highlighted_nets]).to.deep.equal([2, 1]);
        expect(viewer.remove_highlighted_net(7)).to.equal(false);
        expect(viewer.clear_highlighted_nets()).to.equal(true);
        expect(viewer.highlighted_nets.size).to.equal(0);
        expect(viewer.clear_highlighted_nets()).to.equal(false);
    });

    test("unknown and zero net codes are dropped", () => {
        expect(viewer.set_highlighted_nets([0, 42, 2])).to.equal(true);
        expect([...viewer.highlighted_nets]).to.deep.equal([2]);
    });

    test("painting never touches the user's layer visibility", () => {
        viewer.set_host_layer_visibility(LayerNames.in1_cu, false);
        const before = visibility(viewer);
        expect(before[LayerNames.in1_cu]).to.equal(false);

        viewer.set_highlighted_nets([1, 2]);
        expect(visibility(viewer)).to.deep.equal(before);
        expect(viewer.layers.selection_bg.graphics).to.not.equal(undefined);
        expect(viewer.layers.selection_bg.opacity).to.equal(
            HIGHLIGHT_DIM_OPACITY,
        );
        expect(viewer.layers.selection_fg.graphics).to.not.equal(undefined);
        expect(viewer.layers.selection_mask.graphics).to.not.equal(undefined);
        expect(viewer.painter.highlight_nets).to.deep.equal(new Set([1, 2]));

        viewer.clear_selection();
        expect(visibility(viewer)).to.deep.equal(before);
        expect(viewer.highlighted_nets.size).to.equal(0);
        expect(viewer.painter.highlight_nets).to.equal(null);
    });

    test("highlight overlays stay inside clip depth with many zoom label layers", async () => {
        viewer.set_highlighted_nets([1]);

        // Large production boards can activate more than 100 dynamic label
        // layers after crossing a zoom threshold. Model those foreground
        // inputs without depending on a huge fixture.
        for (let index = 0; index < 120; index++) {
            const dynamic = (viewer.layers as LayerSet).extension_layer(
                `zoom-label-${index}`,
                "content-overlay",
            );
            dynamic.graphics = {
                render() {},
                dispose() {},
            } as never;
        }

        let selection_depth = Number.NaN;
        const selection = viewer.layers.selection_mask.graphics!;
        const original_render = selection.render.bind(selection);
        selection.render = (camera, depth, alpha) => {
            selection_depth = depth;
            original_render(camera, depth, alpha);
        };

        viewer.draw();
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        expect(selection_depth).to.be.greaterThan(0);
        expect(selection_depth).to.be.lessThan(1);
    });

    test("the fit box covers the highlighted copper, not the zone alone", () => {
        viewer.set_highlighted_nets([1]);
        const box = viewer.painter.highlight_bbox!;
        expect(box.valid).to.equal(true);
        // Via at 9, F.Cu track to 19, pad at 19, B.Cu track to 22.
        expect(box.x).to.be.closeTo(8.6, 0.05);
        expect(box.x2).to.be.closeTo(22.2, 0.05);
        // The NET_B track on In1.Cu is not part of it.
        expect(box.y2).to.be.lessThan(14);

        viewer.set_highlighted_nets([2]);
        const b = viewer.painter.highlight_bbox!;
        expect(b.x).to.be.closeTo(20.4, 0.05);
        expect(b.x2).to.be.closeTo(24.2, 0.05);
    });

    test("a hidden layer's members are left out of the emphasis pass", () => {
        viewer.set_host_layer_visibility(LayerNames.in1_cu, false);
        viewer.set_highlighted_nets([2]);
        // Only R1.2 remains (the In1.Cu track is hidden).
        const box = viewer.painter.highlight_bbox!;
        expect(box.x2).to.be.lessThan(22);
    });

    test("adding never moves the camera; focus fits the set", () => {
        const before = viewer.viewport.camera.bbox;
        viewer.set_highlighted_nets([1]);
        expect(viewer.viewport.camera.bbox.x).to.equal(before.x);
        expect(viewer.viewport.camera.bbox.w).to.equal(before.w);
        expect(viewer.focus_highlighted_nets()).to.equal(true);
        expect(viewer.viewport.camera.bbox.w).to.be.lessThan(before.w);
        viewer.clear_highlighted_nets();
        expect(viewer.focus_highlighted_nets()).to.equal(false);
    });

    test("highlight_net and focus_net stay replace-of-one", () => {
        viewer.set_highlighted_nets([1, 2]);
        viewer.highlight_net(2, false);
        expect([...viewer.highlighted_nets]).to.deep.equal([2]);
        viewer.focus_net(1, false);
        expect([...viewer.highlighted_nets]).to.deep.equal([1]);
        viewer.highlight_net(null, false);
        expect(viewer.highlighted_nets.size).to.equal(0);
    });

    test("a footprint outline keeps the set; a footprint cross-probe replaces it", () => {
        viewer.set_highlighted_nets([1]);
        const fp = viewer.board.footprints[1]!;
        viewer.outline_fp(fp);
        expect([...viewer.highlighted_nets]).to.deep.equal([1]);
        viewer.highlight_fp(fp);
        expect(viewer.highlighted_nets.size).to.equal(0);
    });

    test("a footprint paint after a highlight is opaque and forgets the set", () => {
        viewer.set_highlighted_nets([1]);
        expect(viewer.layers.selection_fg.opacity).to.be.lessThan(1);
        viewer.highlight_fp(viewer.board.footprints[1]!);
        for (const layer of [
            viewer.layers.selection_bg,
            viewer.layers.selection_fg,
            viewer.layers.selection_mask,
        ])
            expect(layer.opacity).to.equal(1);
        expect(viewer.painter.highlight_nets).to.equal(null);
        expect(viewer.painter.highlight_bbox).to.equal(null);
        expect(viewer.focus_highlighted_nets()).to.equal(false);
    });
});

suite("net highlight: labels survive the dim", () => {
    let viewer: BoardViewer;
    setup(async () => {
        viewer = await mount_viewer();
        viewer.viewport.camera.zoom = 40;
        viewer.viewport.camera.center = new Vec2(20, 10);
    });
    teardown(() => unmount(viewer));

    const emphasis = () =>
        (viewer.layers as LayerSet).extension_layer(
            EMPHASIS_LABEL_CHANNEL,
            "foreground",
        );

    test("only highlighted nets' labels are repeated on the foreground layer", () => {
        viewer.draw();
        expect(emphasis().graphics).to.equal(undefined);
        expect(layer(viewer, F_CU_LABELS).graphics).to.not.equal(undefined);

        viewer.set_highlighted_nets([1]);
        viewer.draw();
        expect(emphasis().graphics).to.not.equal(undefined);
        // The native label layers are untouched.
        expect(layer(viewer, F_CU_LABELS).graphics).to.not.equal(undefined);
        expect(layer(viewer, F_CU_LABELS).visible).to.equal(true);

        viewer.clear_selection();
        viewer.draw();
        expect(emphasis().graphics).to.equal(undefined);
    });

    test("hiding a layer during a highlight drops its labels from the emphasis copy", () => {
        viewer.viewport.camera.center = new Vec2(22, 15);
        viewer.set_highlighted_nets([2]);
        viewer.draw();
        const with_in1 = emphasis().graphics;
        expect(with_in1).to.not.equal(undefined);
        viewer.set_host_layer_visibility(LayerNames.in1_cu, false);
        viewer.draw();
        const without = emphasis().graphics;
        // A rebuild happened: the layer object is new.
        expect(without).to.not.equal(with_in1);
    });
});

suite("net highlight: click gestures", () => {
    let viewer: BoardViewer;
    let events: KiCanvasSelectEvent[];
    setup(async () => {
        viewer = await mount_viewer();
        events = [];
        viewer.addEventListener(KiCanvasSelectEvent.type, (e) =>
            events.push(e as KiCanvasSelectEvent),
        );
    });
    teardown(() => unmount(viewer));

    const R1_PAD1 = new Vec2(19, 10); // track end under it
    const R1_PAD2 = new Vec2(21, 10);
    const R2_PAD1 = new Vec2(29, 20); // unconnected
    const TRACK_B = new Vec2(22.5, 15);

    test("a pad over a track end is one hit for the gesture", () => {
        const hits = viewer.find_items_under_pos(R1_PAD1);
        expect(hits.length).to.equal(2);
        expect(shared_net(hits)).to.equal(1);
        expect(pick_item(hits)!.depth).to.equal(Depth.PAD);
    });

    test("a pad over another net's track toggles the pad's net", () => {
        // R1.2 (NET_B) sits over a B.Cu track of NET_A: the pad wins.
        viewer.on_click(R1_PAD2, click(true));
        expect(events).to.have.length(1);
        const item = events[0]!.detail.item as board_items.Pad;
        expect(item).to.be.instanceOf(board_items.Pad);
        expect(item.net?.name).to.equal("NET_B");
    });

    test("shift-click toggles the net and carries the intent", () => {
        viewer.on_click(R1_PAD1, click(true));
        expect(events).to.have.length(1);
        const detail = events[0]!.detail;
        expect(detail.operation).to.equal("toggle");
        expect(detail.modifiers?.shift).to.equal(true);
        expect(detail.item).to.be.instanceOf(board_items.Pad);
        // The viewer does not apply the toggle itself; that is the owner's call.
        expect(viewer.highlighted_nets.size).to.equal(0);
    });

    test("shift-click on empty board or an unconnected pad is a no-op", () => {
        viewer.on_click(new Vec2(35, 5), click(true));
        viewer.on_click(R2_PAD1, click(true));
        expect(events).to.have.length(0);
    });

    test("plain click selects the pad, not a pop-up, and never toggles", () => {
        viewer.on_click(R1_PAD1, click(false));
        expect(events).to.have.length(1);
        expect(events[0]!.detail.operation).to.equal("replace");
        expect(events[0]!.detail.item).to.be.instanceOf(board_items.Pad);
        viewer.on_click(new Vec2(35, 5), click(false));
        expect(events[1]!.detail.item).to.equal(null);
    });

    test("shift-clicks on different nets each carry their own net", () => {
        viewer.on_click(R1_PAD2, click(true));
        viewer.on_click(TRACK_B, click(true));
        expect(
            events.map((e) => (e.detail.item as { net?: unknown }).net),
        ).to.have.length(2);
        expect(events[1]!.detail.item).to.be.instanceOf(
            board_items.LineSegment,
        );
    });
});

// ---------------------------------------------------------------- element

type Host = HTMLElement & {
    replaceSources(update: {
        revisionKey: string;
        sources: Array<{ filename: string; content: string }>;
    }): Promise<void>;
    ready: Promise<void>;
    setHighlightedNets(
        nets: Array<{ name: string; netCode?: number; uuids?: string[] }>,
        options?: { focus?: boolean },
    ): {
        applied: Array<{ name: string; netCode?: number }>;
        unresolved: unknown[];
    };
    getHighlightedNets(): Array<{ name: string; netCode?: number }>;
    focusHighlightedNets(): boolean;
    clearSelection(options?: { keepHighlights?: boolean }): void;
    requestCrossProbe(request: Record<string, unknown>): boolean;
    camera: { x: number; y: number; zoom: number } | null;
};

async function mount_host(host_mode: boolean): Promise<Host> {
    const host = document.createElement("ecad-viewer") as Host;
    host.setAttribute("show-header", "false");
    host.style.width = "900px";
    host.style.height = "600px";
    await customElements.whenDefined("ecad-viewer");
    if (host_mode) {
        host.setAttribute("source-mode", "host");
        document.body.append(host);
        await host.replaceSources({
            revisionKey: "rev-1",
            sources: [{ filename: "highlight.kicad_pcb", content: BOARD }],
        });
    } else {
        // Standalone: the element loads its own inline sources.
        const blob = document.createElement("ecad-blob");
        blob.setAttribute("filename", "highlight.kicad_pcb");
        blob.setAttribute("content", BOARD);
        host.append(blob);
        document.body.append(host);
    }
    await host.ready;
    // The board app mounts after the project settles; wait for its viewer.
    for (let i = 0; i < 200 && !board_app_of(host)?.viewer?.board; i++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await board_app_of(host)!.viewer.loaded;
    return host;
}

function board_app_of(host: Host) {
    return host.shadowRoot?.querySelector("kc-board-app") as
        | (HTMLElement & { viewer: BoardViewer })
        | null;
}

function board_viewer_of(host: Host): BoardViewer {
    return board_app_of(host)!.viewer;
}

suite("net highlight: element API", () => {
    let host: Host;
    let changes: Array<{ nets: Array<{ name: string }>; source: string }>;
    setup(async () => {
        host = await mount_host(true);
        changes = [];
        host.addEventListener("ecad-viewer:highlight-change", (e) =>
            changes.push((e as CustomEvent).detail),
        );
    });
    teardown(() => host.remove());

    test("resolves names first, codes second, and reports the rest", () => {
        const result = host.setHighlightedNets([
            { name: "NET_B", netCode: 1 },
            { name: "", netCode: 1 },
            { name: "NOPE" },
        ]);
        expect(result.applied.map((n) => [n.name, n.netCode])).to.deep.equal([
            ["NET_B", 2],
            ["NET_A", 1],
        ]);
        expect(result.unresolved).to.deep.equal([{ name: "NOPE" }]);
        expect(host.getHighlightedNets().map((n) => n.name)).to.deep.equal([
            "NET_B",
            "NET_A",
        ]);
        // The host owns this set: no echo.
        expect(changes).to.have.length(0);
    });

    test("setHighlightedNets leaves the camera alone unless asked", () => {
        const before = host.camera!;
        host.setHighlightedNets([{ name: "NET_A" }]);
        expect(host.camera).to.deep.equal(before);
        host.setHighlightedNets([{ name: "NET_A" }], { focus: true });
        expect(host.camera!.zoom).to.not.equal(before.zoom);
    });

    test("clearSelection empties the set and says so", () => {
        host.setHighlightedNets([{ name: "NET_A" }]);
        host.clearSelection();
        expect(host.getHighlightedNets()).to.deep.equal([]);
        expect(changes).to.deep.equal([{ nets: [], source: "clear" }]);
        host.clearSelection();
        expect(changes).to.have.length(1);
    });

    test("a host clearing only its inspected object keeps the set", () => {
        host.setHighlightedNets([{ name: "NET_A" }]);
        host.clearSelection({ keepHighlights: true });
        expect(host.getHighlightedNets().map((n) => n.name)).to.deep.equal([
            "NET_A",
        ]);
        expect(board_viewer_of(host).painter.highlight_nets).to.deep.equal(
            new Set([1]),
        );
        expect(changes).to.have.length(0);
    });

    test("resolves a net by copper uuid when the name is unknown", () => {
        const result = host.setHighlightedNets([
            { name: "/sheet/NET_A", uuids: ["seg-a"] },
        ]);
        expect(result.applied.map((n) => n.name)).to.deep.equal(["NET_A"]);
    });

    test("requestCrossProbe is a replace-of-one the host hears about", () => {
        host.setHighlightedNets([{ name: "NET_A" }, { name: "NET_B" }]);
        expect(
            host.requestCrossProbe({
                sourceContext: "SCH",
                targetContext: "PCB",
                mode: "focus",
                kind: "net",
                value: "NET_B",
            }),
        ).to.equal(true);
        expect(host.getHighlightedNets().map((n) => n.name)).to.deep.equal([
            "NET_B",
        ]);
        expect(changes.map((c) => c.source)).to.deep.equal(["crossprobe"]);
    });

    test("in host mode a shift-click is relayed, not applied", () => {
        const selections: Array<Record<string, unknown>> = [];
        host.addEventListener("ecad-viewer:selection", (e) =>
            selections.push((e as CustomEvent).detail),
        );
        board_viewer_of(host).on_click(new Vec2(19, 10), click(true));
        expect(selections).to.have.length(1);
        expect(selections[0]!["operation"]).to.equal("toggle");
        expect(selections[0]!["net"]).to.equal("NET_A");
        expect(selections[0]!["itemType"]).to.equal("pad");
        expect(host.getHighlightedNets()).to.deep.equal([]);
        expect(changes).to.have.length(0);
    });
});

suite("net highlight: standalone element", () => {
    let host: Host;
    setup(async () => {
        host = await mount_host(false);
    });
    teardown(() => host.remove());

    test("shift-click toggles locally and emits the change", () => {
        const changes: Array<{
            nets: Array<{ name: string }>;
            source: string;
        }> = [];
        host.addEventListener("ecad-viewer:highlight-change", (e) =>
            changes.push((e as CustomEvent).detail),
        );
        const viewer = board_viewer_of(host);
        viewer.on_click(new Vec2(19, 10), click(true));
        viewer.on_click(new Vec2(22.5, 15), click(true));
        expect(host.getHighlightedNets().map((n) => n.name)).to.deep.equal([
            "NET_A",
            "NET_B",
        ]);
        viewer.on_click(new Vec2(19, 10), click(true));
        expect(host.getHighlightedNets().map((n) => n.name)).to.deep.equal([
            "NET_B",
        ]);
        expect(changes.map((c) => [c.source, c.nets.length])).to.deep.equal([
            ["gesture", 1],
            ["gesture", 2],
            ["gesture", 1],
        ]);
    });
});

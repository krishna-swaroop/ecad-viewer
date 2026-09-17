/**
 * Pad-number and net-name labels on the board view.
 *
 * The layout functions are a port of KiCad's `PCB_PAINTER` label branches and
 * `ViewGetLOD` zoom gates; the numbers asserted here are those formulas
 * evaluated by hand for the fixture in
 * packages/kicad-parser/tests/fixtures/net-labels (see its README).
 */
import { expect } from "@esm-bundle/chai";
import { BoardParser } from "kicad-parser";

import { Angle, BBox, Vec2 } from "../src/base/math";
import { NullRenderer } from "../src/graphics/null-renderer";
import { KicadPCB } from "../src/kicad";
import * as board_items from "../src/kicad/board";
import themes from "../src/kicanvas/themes";
import {
    CopperVirtualLayerNames,
    LayerNames,
    LayerSet,
    NetLabelColors,
    virtual_layer_for,
} from "../src/viewers/board/layers";
import {
    MIN_GLYPH_PX,
    PAD_LABEL_MIN_PX,
    TRACK_LABEL_MIN_PX,
    VIA_LABEL_MIN_PX,
    arc_label_layout,
    copper_layer_index,
    display_net_name,
    draw_label,
    fold_upright,
    pad_label_layer,
    pad_label_layout,
    pad_label_min_zoom,
    pad_net_text,
    segment_label_layouts,
    track_label_min_zoom,
    via_label_layout,
    via_label_min_zoom,
} from "../src/viewers/board/net-label-painter";
import { BoardViewer } from "../src/viewers/board/viewer";

const FIXTURES = "/kicad-parser/tests/fixtures/net-labels";

async function fixture_board(): Promise<KicadPCB> {
    const module = await import(
        /* @vite-ignore */ `${FIXTURES}/net_labels.kicad_pcb`
    );
    return new KicadPCB(
        "net_labels.kicad_pcb",
        new BoardParser().parse(module.default as string) as never,
    );
}

function pad_of(board: KicadPCB, ref: string, number: string) {
    const fp = board.footprints.find((f) => f.reference === ref)!;
    const pad = fp.pads.find((p) => p.number === number);
    if (!pad) throw new Error(`${ref} has no pad ${JSON.stringify(number)}`);
    return pad;
}

function lines_of(layout: ReturnType<typeof pad_label_layout>) {
    return Object.fromEntries(layout!.lines.map((l) => [l.text, l]));
}

const F_CU_LABELS = virtual_layer_for(
    LayerNames.f_cu,
    CopperVirtualLayerNames.netnames,
);
const B_CU_LABELS = virtual_layer_for(
    LayerNames.b_cu,
    CopperVirtualLayerNames.netnames,
);

suite("net labels: helpers", () => {
    test("display_net_name keeps the leaf of a hierarchical name", () => {
        expect(display_net_name("/sig/DATA")).to.equal("DATA");
        expect(display_net_name("GND")).to.equal("GND");
        expect(display_net_name("")).to.equal("");
        expect(display_net_name(undefined)).to.equal("");
    });

    test("fold_upright keeps text in (-90°, 90°]", () => {
        expect(fold_upright(Angle.from_degrees(135)).degrees).to.equal(-45);
        expect(fold_upright(Angle.from_degrees(-135)).degrees).to.equal(45);
        expect(fold_upright(Angle.from_degrees(90)).degrees).to.equal(90);
        expect(fold_upright(Angle.from_degrees(-90)).degrees).to.equal(90);
        expect(fold_upright(Angle.from_degrees(180)).degrees).to.equal(0);
    });

    test("copper_layer_index numbers the stack like KiCad's via labels", () => {
        expect(copper_layer_index("F.Cu", 4)).to.equal(1);
        expect(copper_layer_index("In1.Cu", 4)).to.equal(2);
        expect(copper_layer_index("In2.Cu", 4)).to.equal(3);
        expect(copper_layer_index("B.Cu", 4)).to.equal(4);
    });

    test("zoom gates are KiCad's thresholds in px per mm", () => {
        expect(track_label_min_zoom(0.5)).to.be.closeTo(
            TRACK_LABEL_MIN_PX / 0.5,
            1e-9,
        );
        expect(track_label_min_zoom(0)).to.equal(Infinity);
    });
});

suite("net labels: pad layout", () => {
    let board: KicadPCB;
    suiteSetup(async () => {
        board = await fixture_board();
    });

    test("through-hole and multi-layer pads label on :Pad:NetNames, single-layer pads on their copper", () => {
        expect(pad_label_layer(pad_of(board, "U1", "1"))).to.equal(
            LayerNames.pad_netnames,
        );
        expect(pad_label_layer(pad_of(board, "U1", "3"))).to.equal(F_CU_LABELS);
        expect(pad_label_layer(pad_of(board, "J1", "1"))).to.equal(B_CU_LABELS);
    });

    test("net text: short name, x for no-connect", () => {
        expect(pad_net_text(pad_of(board, "U1", "2"))).to.equal("DATA");
        expect(pad_net_text(pad_of(board, "U1", "4"))).to.equal("x");
        expect(pad_net_text(pad_of(board, "U1", ""))).to.equal("");
    });

    test("a pad with neither number nor net has no label", () => {
        expect(pad_label_layout(pad_of(board, "U1", ""), true, true)).to.equal(
            null,
        );
        expect(
            pad_label_layout(pad_of(board, "U1", "3"), false, false),
        ).to.equal(null);
    });

    test("wide 2×1 mm pad: horizontal, number above and net below", () => {
        const pad = pad_of(board, "U1", "3");
        const layout = pad_label_layout(pad, true, true)!;
        expect(layout.angle.degrees).to.equal(0);
        expect(layout.position.x).to.be.closeTo(16, 1e-6);
        expect(layout.position.y).to.be.closeTo(10, 1e-6);

        // size = h = 1 → both strings: size = 0.4, y_net = 0.4/1.4, y_num = 0.4/1.7
        const size = 1 / 2.5;
        const { VCC, "3": number } = lines_of(layout);
        // net: min(1.5*2/max(4,5), 0.4)*0.85 = 0.34
        const t_net = Math.min((1.5 * 2) / 5, size) * 0.85;
        expect(VCC!.size.y).to.be.closeTo(t_net, 1e-9);
        expect(VCC!.size.x).to.be.closeTo(t_net * 0.9, 1e-9);
        expect(VCC!.stroke).to.be.closeTo((t_net * 0.9) / 6, 1e-9);
        expect(VCC!.y).to.be.closeTo(Math.min(t_net * 1.4, size / 1.4), 1e-9);
        expect(VCC!.y).to.be.greaterThan(0, "net name sits below centre");
        // number: min(1.5*2/max(1,3), 0.4)*0.85 = 0.34
        const t_num = Math.min((1.5 * 2) / 3, size) * 0.85;
        expect(number!.size.y).to.be.closeTo(t_num, 1e-9);
        expect(number!.y).to.be.closeTo(-size / 1.7, 1e-9);
        expect(number!.y).to.be.lessThan(0, "pad number sits above centre");
    });

    test("tall 1×2 mm pad rotates 90° and uses the long side for width", () => {
        const layout = pad_label_layout(pad_of(board, "U1", "2"), true, true)!;
        expect(layout.angle.degrees).to.equal(90);
        const size = 1 / 2.5;
        const { DATA } = lines_of(layout);
        // after the swap w = 2: min(1.5*2/max(5,5), 0.4)*0.85
        expect(DATA!.size.y).to.be.closeTo(
            Math.min((1.5 * 2) / 5, size) * 0.85,
            1e-9,
        );
    });

    test("number alone uses the full pad height", () => {
        const layout = pad_label_layout(pad_of(board, "U1", "3"), true, false)!;
        expect(layout.lines.length).to.equal(1);
        const line = layout.lines[0]!;
        expect(line.text).to.equal("3");
        // min(1.5*2/3, 1)*0.85 = 0.85
        expect(line.size.y).to.be.closeTo(0.85, 1e-9);
        expect(line.y).to.equal(0);
    });

    test("circle pads shrink the net name by 0.9", () => {
        const circle = pad_label_layout(pad_of(board, "U1", "5"), false, true)!;
        const size = 1;
        expect(circle.lines[0]!.size.y).to.be.closeTo(
            Math.min((1.5 * 1) / 5, size) * 0.85 * 0.9,
            1e-9,
        );
    });

    test("pad zoom gate is the short bbox side against 0.5 mm-equivalent", () => {
        const pad = pad_of(board, "U1", "2");
        expect(pad_label_min_zoom(pad)).to.be.closeTo(
            PAD_LABEL_MIN_PX / 1,
            1e-9,
        );
    });
});

suite("net labels: tracks and vias", () => {
    const region = new BBox(-100, -100, 300, 300);

    test("a segment shorter than chars × width has no label", () => {
        expect(
            segment_label_layouts(
                new Vec2(10, 12),
                new Vec2(10.5, 12),
                0.5,
                "DATA",
                region,
            ),
        ).to.deep.equal([]);
    });

    test("horizontal segment: one centred label, 0.55 × width, pen width/12", () => {
        const layouts = segment_label_layouts(
            new Vec2(13, 10),
            new Vec2(30, 10),
            0.5,
            "DATA",
            region,
        );
        expect(layouts.length).to.equal(1);
        const [layout] = layouts;
        expect(layout!.angle.degrees).to.equal(0);
        expect(layout!.position.x).to.be.closeTo(21.5, 1e-9);
        expect(layout!.position.y).to.be.closeTo(10, 1e-9);
        const line = layout!.lines[0]!;
        expect(line.size.x).to.be.closeTo(0.275, 1e-9);
        expect(line.size.y).to.be.closeTo(0.275, 1e-9);
        expect(line.stroke).to.be.closeTo(0.5 / 12, 1e-9);
    });

    test("vertical segment reads at 90°", () => {
        const [layout] = segment_label_layouts(
            new Vec2(35, 5),
            new Vec2(35, 25),
            0.4,
            "GND",
            region,
        );
        expect(layout!.angle.degrees).to.equal(90);
    });

    test("diagonal segment folds its angle upright", () => {
        // (12,14)→(20,22): atan2 = 45° in y-down space → text angle -45°
        const [layout] = segment_label_layouts(
            new Vec2(12, 14),
            new Vec2(20, 22),
            0.5,
            "VCC",
            region,
        );
        expect(layout!.angle.degrees).to.equal(-45);
        // and the reverse direction lands on the same upright angle
        const [reverse] = segment_label_layouts(
            new Vec2(20, 22),
            new Vec2(12, 14),
            0.5,
            "VCC",
            region,
        );
        expect(reverse!.angle.degrees).to.equal(-45);
    });

    test("a track longer than the region is labelled once per region extent, inside it", () => {
        const small = new BBox(0, 0, 10, 10);
        const layouts = segment_label_layouts(
            new Vec2(-20, 5),
            new Vec2(30, 5),
            0.5,
            "N",
            small,
        );
        // length 50 / region 10 → 5 labels at 1/6 … 5/6, only those inside
        for (const layout of layouts) {
            expect(small.contains_point(layout.position)).to.equal(true);
        }
        expect(layouts.length).to.be.greaterThan(0);
        expect(layouts.length).to.be.lessThan(5);
    });

    test("arc: one label at the midpoint along the tangent", async () => {
        const board = await fixture_board();
        const arc = board.segments.find(
            (s): s is board_items.ArcSegment =>
                s instanceof board_items.ArcSegment,
        )!;
        const layouts = arc_label_layout(arc, "GND", region);
        expect(layouts.length).to.equal(1);
        expect(layouts[0]!.position.x).to.be.closeTo(25, 1e-9);
        expect(layouts[0]!.position.y).to.be.closeTo(35, 1e-9);
        // tangent at the bottom of the arc is horizontal
        expect(Math.abs(layouts[0]!.angle.degrees)).to.equal(0);
        expect(
            arc_label_layout(
                arc,
                "a-very-long-net-name-that-cannot-fit",
                region,
            ),
        ).to.deep.equal([]);
    });

    test("via: net name only for a through via, layer pair above it for a blind via", async () => {
        const board = await fixture_board();
        const through = board.vias.find((v) => v.type === "through-hole")!;
        const blind = board.vias.find((v) => v.type === "blind")!;

        const t = via_label_layout(through, "DATA", 4, true)!;
        expect(t.angle.degrees).to.equal(0);
        expect(t.lines.map((l) => l.text)).to.deep.equal(["DATA"]);
        // min(1.5*0.8/max(4,3), 0.8)*0.75 = 0.225
        expect(t.lines[0]!.size.y).to.be.closeTo(0.225, 1e-9);
        expect(t.lines[0]!.stroke).to.be.closeTo(0.0225, 1e-9);
        expect(t.lines[0]!.y).to.equal(0);

        const b = via_label_layout(blind, "VCC", 4, true)!;
        expect(b.lines.map((l) => l.text)).to.deep.equal(["VCC", "1-2"]);
        const tsize = Math.min((1.5 * 0.6) / 6, 0.6) * 0.75;
        expect(b.lines[0]!.y).to.be.closeTo((tsize * 1.3) / 2, 1e-9);
        expect(b.lines[1]!.y).to.be.closeTo(
            (tsize * 1.3) / 2 - tsize * 1.3,
            1e-9,
        );
        expect(b.lines[1]!.y).to.be.lessThan(b.lines[0]!.y);

        // A blind via keeps its layer pair with net names off; a through via
        // has nothing left to say.
        expect(
            via_label_layout(blind, "VCC", 4, false)!.lines.map((l) => l.text),
        ).to.deep.equal(["1-2"]);
        expect(via_label_layout(through, "DATA", 4, false)).to.equal(null);

        expect(via_label_min_zoom(through)).to.be.closeTo(
            VIA_LABEL_MIN_PX / 0.8,
            1e-9,
        );
    });
});

suite("net labels: drawing", () => {
    test("draw_label strokes in board millimetres, not font units", () => {
        const gfx = new NullRenderer();
        gfx.start_layer("test");
        gfx.start_bbox();
        draw_label(
            gfx,
            {
                position: new Vec2(10, 10),
                angle: Angle.from_degrees(0),
                lines: [
                    {
                        text: "1",
                        size: new Vec2(0.9, 1),
                        stroke: 0.15,
                        y: 0,
                    },
                ],
            },
            NetLabelColors.light,
        );
        const bbox = gfx.end_bbox();
        gfx.end_layer();
        expect(bbox.valid).to.equal(true);
        expect(bbox.h).to.be.greaterThan(0.5);
        expect(bbox.h).to.be.lessThan(1.5);
        expect(bbox.center.x).to.be.closeTo(10, 0.3);
        expect(bbox.center.y).to.be.closeTo(10, 0.3);
    });

    test("a rotated label lands its line offsets across the rotation", () => {
        const gfx = new NullRenderer();
        const at = (angle: number, y: number) => {
            gfx.start_layer("test");
            gfx.start_bbox();
            draw_label(
                gfx,
                {
                    position: new Vec2(0, 0),
                    angle: Angle.from_degrees(angle),
                    lines: [
                        { text: "8", size: new Vec2(0.9, 1), stroke: 0.1, y },
                    ],
                },
                NetLabelColors.light,
            );
            const bbox = gfx.end_bbox();
            gfx.end_layer();
            return bbox.center;
        };
        const below = at(0, 1);
        expect(below.y).to.be.closeTo(1, 0.3);
        expect(below.x).to.be.closeTo(0, 0.3);
        // At +90° (KiCad's counter-clockwise on screen) "below" is +x.
        const rotated = at(90, 1);
        expect(rotated.x).to.be.closeTo(1, 0.3);
        expect(rotated.y).to.be.closeTo(0, 0.3);
    });
});

suite("net labels: layers", () => {
    let board: KicadPCB;
    suiteSetup(async () => {
        board = await fixture_board();
    });

    test("label layers exist, are non-interactive and follow copper visibility", () => {
        const layers = new LayerSet(board, themes.default.board);
        const names = Array.from(layers.netname_layers()).map((l) => l.name);
        expect(names).to.include(LayerNames.pad_netnames);
        expect(names).to.include(LayerNames.via_netnames);
        expect(names).to.include(F_CU_LABELS);
        expect(names).to.include(
            virtual_layer_for("In1.Cu", CopperVirtualLayerNames.netnames),
        );
        expect(names).to.include(B_CU_LABELS);
        for (const layer of layers.netname_layers()) {
            expect(layer.interactive, layer.name).to.equal(false);
        }

        layers.by_name(LayerNames.f_cu)!.visible = false;
        expect(layers.by_name(F_CU_LABELS)!.visible).to.equal(false);
        expect(layers.by_name(LayerNames.pad_netnames)!.visible).to.equal(true);
        for (const copper of layers.copper_layers()) copper.visible = false;
        expect(layers.by_name(LayerNames.pad_netnames)!.visible).to.equal(
            false,
        );
        expect(layers.by_name(LayerNames.via_netnames)!.visible).to.equal(
            false,
        );

        // Not user-managed, not affected by the object opacity groups.
        const ui = Array.from(layers.in_ui_order()).map((l) => l.name);
        expect(ui).to.not.include(LayerNames.pad_netnames);
        expect(ui).to.not.include(F_CU_LABELS);
        for (const group of [
            layers.copper_layers(),
            layers.pad_layers(),
            layers.via_layers(),
            layers.zone_layers(),
        ]) {
            for (const layer of group) {
                expect(layer.name).to.not.match(/NetNames/);
            }
        }
    });

    test("label layers draw above the pads, holes and copper they annotate", () => {
        const layers = new LayerSet(board, themes.default.board);
        const order = Array.from(layers.in_display_order()).map((l) => l.name);
        const idx = (name: string) => {
            const i = order.indexOf(name);
            expect(i, name).to.be.greaterThan(-1);
            return i;
        };
        // Later in display order = drawn later = on top.
        expect(idx(LayerNames.pad_netnames)).to.be.greaterThan(
            idx(LayerNames.pad_holes),
        );
        expect(idx(LayerNames.via_netnames)).to.be.greaterThan(
            idx(LayerNames.via_holes),
        );
        expect(idx(F_CU_LABELS)).to.be.greaterThan(
            idx(
                virtual_layer_for(
                    LayerNames.f_cu,
                    CopperVirtualLayerNames.pads,
                ),
            ),
        );
        expect(idx(F_CU_LABELS)).to.be.greaterThan(
            idx(
                virtual_layer_for(
                    LayerNames.f_cu,
                    CopperVirtualLayerNames.zones,
                ),
            ),
        );
        expect(idx(F_CU_LABELS)).to.be.greaterThan(idx(LayerNames.f_cu));
        expect(idx(LayerNames.dnp)).to.be.greaterThan(
            idx(LayerNames.pad_netnames),
        );
    });

    test("label colour inverts over bright copper", () => {
        const layers = new LayerSet(board, themes.default.board);
        const theme = themes.default.board;
        const brightness = (c: { r: number; g: number; b: number }) =>
            c.r * 0.299 + c.g * 0.587 + c.b * 0.117;
        const expected = (copper: { r: number; g: number; b: number }) =>
            brightness(copper) > 0.5
                ? NetLabelColors.dark
                : NetLabelColors.light;
        expect(layers.by_name(F_CU_LABELS)!.color.to_css()).to.equal(
            expected(theme.copper.f).to_css(),
        );
        expect(layers.by_name(B_CU_LABELS)!.color.to_css()).to.equal(
            expected(theme.copper.b).to_css(),
        );
        expect(layers.by_name(LayerNames.via_netnames)!.color.a).to.equal(1);
    });
});

suite("net labels: viewer integration", () => {
    let board: KicadPCB;
    suiteSetup(async () => {
        board = await fixture_board();
    });

    async function viewer_on(canvas: HTMLCanvasElement) {
        const viewer = new BoardViewer(canvas, false, themes.default.board);
        await viewer.setup();
        await viewer.load(board);
        return viewer;
    }

    function label_layers(viewer: BoardViewer) {
        return Array.from((viewer.layers as LayerSet).netname_layers());
    }

    function drawn(viewer: BoardViewer) {
        return label_layers(viewer)
            .filter((l) => l.graphics !== undefined)
            .map((l) => l.name)
            .sort();
    }

    test("labels appear only once the zoom passes the item gates", async () => {
        const canvas = document.createElement("canvas");
        canvas.width = 800;
        canvas.height = 600;
        document.body.append(canvas);
        const viewer = await viewer_on(canvas);
        try {
            // Far out: even the largest pad is under a screen pixel.
            viewer.viewport.camera.zoom = 0.6;
            viewer.viewport.camera.center = new Vec2(20, 20);
            viewer.draw();
            expect(drawn(viewer)).to.deep.equal([]);

            // Pads legible, tracks (0.5 mm) still under 14 px.
            viewer.viewport.camera.zoom = 20;
            viewer.draw();
            expect(drawn(viewer)).to.include(LayerNames.pad_netnames);
            expect(drawn(viewer)).to.include(F_CU_LABELS);
            expect(drawn(viewer)).to.include(B_CU_LABELS);
            expect(drawn(viewer)).to.not.include(LayerNames.via_netnames);

            // Tracks and vias too (0.8 mm via needs 35.8/0.8 ≈ 45 px/mm).
            viewer.viewport.camera.zoom = 60;
            viewer.viewport.camera.center = new Vec2(25, 10);
            viewer.draw();
            expect(drawn(viewer)).to.include(LayerNames.via_netnames);
        } finally {
            viewer.dispose();
            canvas.remove();
        }
    });

    test("option toggles drive the host view state and repaint the labels", async () => {
        const canvas = document.createElement("canvas");
        canvas.width = 800;
        canvas.height = 600;
        document.body.append(canvas);
        const viewer = await viewer_on(canvas);
        try {
            viewer.viewport.camera.zoom = 60;
            viewer.viewport.camera.center = new Vec2(20, 12);
            viewer.draw();
            const state = viewer.get_host_view_state().objectVisibility;
            expect(state.padNumbers).to.equal(true);
            expect(state.padNetNames).to.equal(true);
            expect(state.trackNetNames).to.equal(true);
            expect(drawn(viewer)).to.include(LayerNames.via_netnames);

            viewer.set_host_object_visibility("trackNetNames", false);
            expect(
                viewer.get_host_view_state().objectVisibility.trackNetNames,
            ).to.equal(false);
            // Through vias have nothing to show without their net name; the
            // blind via keeps its layer pair.
            viewer.draw();
            const by_layer = viewer.net_label_layouts();
            expect(by_layer.get(LayerNames.via_netnames)?.length ?? 0).to.equal(
                1,
            );
            expect(by_layer.get(F_CU_LABELS)?.length ?? 0).to.be.greaterThan(
                0,
                "SMD pad labels stay on the copper layer with track names off",
            );

            viewer.set_host_object_visibility("padNumbers", false);
            viewer.set_host_object_visibility("padNetNames", false);
            viewer.draw();
            const off = viewer.net_label_layouts();
            expect(off.get(LayerNames.pad_netnames)).to.equal(undefined);
            expect(off.get(F_CU_LABELS)).to.equal(undefined);
            expect(drawn(viewer)).to.not.include(LayerNames.pad_netnames);

            expect(
                viewer.set_host_object_visibility("padNumbers", true),
            ).to.equal(undefined);
            expect(viewer.set_net_label_option("padNumbers", true)).to.equal(
                false,
                "already on",
            );
        } finally {
            viewer.dispose();
            canvas.remove();
        }
    });

    test("labels survive a variant repaint and a cached-scene swap", async () => {
        const canvas = document.createElement("canvas");
        canvas.width = 800;
        canvas.height = 600;
        document.body.append(canvas);
        const viewer = await viewer_on(canvas);
        try {
            viewer.viewport.camera.zoom = 30;
            viewer.viewport.camera.center = new Vec2(15, 10);
            viewer.set_host_object_visibility("trackNetNames", false);
            viewer.draw();
            const first = viewer.layers as LayerSet;
            expect(drawn(viewer)).to.include(F_CU_LABELS);

            expect(viewer.set_variant("Alt")).to.equal(true);
            viewer.draw();
            expect(viewer.layers).to.not.equal(first);
            expect(drawn(viewer)).to.include(F_CU_LABELS);
            expect(
                viewer.get_host_view_state().objectVisibility.trackNetNames,
                "toggles outlive the repaint",
            ).to.equal(false);

            expect(viewer.set_variant(null)).to.equal(true);
            viewer.draw();
            expect(drawn(viewer)).to.include(F_CU_LABELS);
        } finally {
            viewer.dispose();
            canvas.remove();
        }
    });

    test("nothing is tessellated while every copper layer is hidden", async () => {
        const canvas = document.createElement("canvas");
        canvas.width = 800;
        canvas.height = 600;
        document.body.append(canvas);
        const viewer = await viewer_on(canvas);
        try {
            viewer.viewport.camera.zoom = 60;
            viewer.viewport.camera.center = new Vec2(20, 12);
            viewer.draw();
            expect(drawn(viewer).length).to.be.greaterThan(0);
            viewer.apply_host_layer_preset("none");
            viewer.draw();
            expect(drawn(viewer)).to.deep.equal([]);
            viewer.apply_host_layer_preset("all");
            viewer.draw();
            expect(drawn(viewer).length).to.be.greaterThan(0);
        } finally {
            viewer.dispose();
            canvas.remove();
        }
    });

    test("MIN_GLYPH_PX keeps illegible labels out of the display list", () => {
        // A 0.4 mm-wide track's label is 0.22 mm tall: at 10 px/mm that is
        // 2.2 px, under the floor, although KiCad's own 14.3 px gate passes
        // only at 35.75 px/mm anyway. The floor matters for pads: a 1 mm pad
        // with number + net has 0.34 mm glyphs, so labels start at ~8.8 px/mm
        // instead of KiCad's 1.8 px/mm.
        expect(MIN_GLYPH_PX / 0.34).to.be.greaterThan(PAD_LABEL_MIN_PX / 1);
    });
});

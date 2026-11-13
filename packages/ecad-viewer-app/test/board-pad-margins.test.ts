import { expect } from "@esm-bundle/chai";
import { BoardParser } from "kicad-parser";

import { Circle, Polygon, Polyline } from "../src/graphics";
import { NullRenderer, NullRenderLayer } from "../src/graphics/null-renderer";
import { KicadPCB } from "../src/kicad";
import themes from "../src/kicanvas/themes";
import { LayerNames, LayerSet } from "../src/viewers/board/layers";
import { pad_layer_margin } from "../src/viewers/board/pad-painter";
import { BoardPainter } from "../src/viewers/board/painter";

/**
 * Paste and mask openings, sized as KiCad sizes them.
 *
 * A pad's opening on a paste or mask layer is its copper grown or shrunk by
 * a margin set on the pad, else on its footprint, else in the board setup.
 * Imported boards lean on this: Altium marks a pad that gets no paste with a
 * huge negative paste margin.
 */

const BOARD = `
(kicad_pcb
  (version 20241229)
  (generator "pcbnew")
  (layers
    (0 "F.Cu" signal)
    (2 "B.Cu" signal)
    (1 "F.Mask" user)
    (3 "B.Mask" user)
    (13 "F.Paste" user)
    (15 "B.Paste" user)
  )
  (setup
    (pad_to_mask_clearance 0.05)
    (pad_to_paste_clearance 0.1)
  )
  (footprint "TP"
    (layer "B.Cu")
    (at 10 10)
    (pad "1" smd circle (at 0 0) (size 1.2 1.2)
      (layers "B.Cu" "B.Mask" "B.Paste")
      (solder_paste_margin -1)
      (uuid "00000000-0000-0000-0000-000000000001"))
  )
  (footprint "C_0805"
    (layer "F.Cu")
    (at 20 10)
    (pad "1" smd rect (at 0 0) (size 2 1)
      (layers "F.Cu" "F.Mask" "F.Paste")
      (solder_mask_margin 0)
      (solder_paste_margin -0.2)
      (uuid "00000000-0000-0000-0000-000000000002"))
    (pad "2" smd rect (at 3 0) (size 2 1)
      (layers "F.Cu" "F.Mask" "F.Paste")
      (uuid "00000000-0000-0000-0000-000000000003"))
  )
  (footprint "QFN"
    (layer "F.Cu")
    (at 30 10)
    (solder_paste_margin -0.25)
    (solder_paste_margin_ratio -0.1)
    (pad "1" smd rect (at 0 0) (size 4 2)
      (layers "F.Cu" "F.Paste")
      (uuid "00000000-0000-0000-0000-000000000004"))
    (pad "2" smd rect (at 5 0) (size 1 1)
      (layers "F.Paste")
      (uuid "00000000-0000-0000-0000-000000000005"))
  )
)
`;

const SHAPES = `
(kicad_pcb
  (version 20241229)
  (generator "pcbnew")
  (layers
    (0 "F.Cu" signal)
    (2 "B.Cu" signal)
    (1 "F.Mask" user)
    (3 "B.Mask" user)
    (13 "F.Paste" user)
    (15 "B.Paste" user)
  )
  (setup
    (pad_to_mask_clearance 0.1)
  )
  (footprint "EP"
    (layer "F.Cu")
    (at 10 10)
    (pad "1" smd custom (at 0 0) (size 1 1)
      (layers "F.Cu" "F.Paste")
      (solder_paste_margin -1000)
      (options (clearance outline) (anchor rect))
      (primitives
        (gr_poly (pts (xy -2 -1) (xy 2 -1) (xy 2 1) (xy -2 1))
          (width 0) (fill yes)))
      (uuid "00000000-0000-0000-0000-000000000011"))
  )
  (footprint "THT"
    (layer "F.Cu")
    (at 20 10)
    (pad "1" thru_hole circle (at 0 0) (size 1.6 1.6) (drill 0.8)
      (layers "*.Cu" "*.Mask" "*.Paste")
      (solder_paste_margin -0.1)
      (uuid "00000000-0000-0000-0000-000000000012"))
  )
  (footprint "TP"
    (layer "F.Cu")
    (at 30 10)
    (pad "1" smd circle (at 0 0) (size 1.2 1.2)
      (layers "F.Cu" "F.Paste")
      (solder_paste_margin -0.1)
      (solder_paste_margin_ratio -0.1)
      (uuid "00000000-0000-0000-0000-000000000013"))
  )
  (footprint "TRAP"
    (layer "B.Cu")
    (at 40 10)
    (pad "1" smd trapezoid (at 0 0) (size 2 1) (rect_delta 0 0.4)
      (layers "B.Cu" "B.Mask")
      (uuid "00000000-0000-0000-0000-000000000014"))
  )
)
`;

function board(source = BOARD): KicadPCB {
    return new KicadPCB(
        "margins.kicad_pcb",
        new BoardParser().parse(source) as never,
    );
}

function pad(b: KicadPCB, uuid: string) {
    for (const fp of b.footprints) {
        for (const p of fp.pads) {
            if (p.uuid.endsWith(uuid)) return p;
        }
    }
    throw new Error(`no pad ${uuid}`);
}

function shapes_on(name: string, source = BOARD) {
    const b = board(source);
    const layers = new LayerSet(b, themes.default.board);
    new BoardPainter(new NullRenderer(), layers, themes.default.board).paint(b);
    return (layers.by_name(name)!.graphics as NullRenderLayer).shapes;
}

suite("pad paste and mask margins", () => {
    test("a pad's own margin wins over the board's", () => {
        const m = pad_layer_margin(pad(board(), "02"), LayerNames.f_paste)!;
        expect(m.x).to.be.closeTo(-0.2, 1e-9);
        expect(m.y).to.be.closeTo(-0.2, 1e-9);

        const mask = pad_layer_margin(pad(board(), "02"), LayerNames.f_mask)!;
        expect(mask.x, "an explicit 0 still overrides").to.equal(0);
    });

    test("a pad with no margin of its own takes the board's", () => {
        const b = board();
        expect(
            pad_layer_margin(pad(b, "03"), LayerNames.f_paste)!.x,
        ).to.be.closeTo(0.1, 1e-9);
        expect(
            pad_layer_margin(pad(b, "03"), LayerNames.f_mask)!.x,
        ).to.be.closeTo(0.05, 1e-9);
    });

    test("then its footprint's, ratio included", () => {
        const m = pad_layer_margin(pad(board(), "04"), LayerNames.f_paste)!;
        expect(m.x).to.be.closeTo(-0.25 - 0.4, 1e-9);
        expect(m.y).to.be.closeTo(-0.25 - 0.2, 1e-9);
    });

    test("footprints still read the legacy solder_paste_ratio", () => {
        const legacy = board(
            BOARD.replace("solder_paste_margin_ratio", "solder_paste_ratio"),
        );
        const m = pad_layer_margin(pad(legacy, "04"), LayerNames.f_paste)!;
        expect(m.x).to.be.closeTo(-0.25 - 0.4, 1e-9);
    });

    test("a pad with no copper keeps its own shape", () => {
        const m = pad_layer_margin(pad(board(), "05"), LayerNames.f_paste)!;
        expect(m.x).to.equal(0);
        expect(m.y).to.equal(0);
    });

    test("only paste and mask layers have a margin", () => {
        expect(pad_layer_margin(pad(board(), "02"), LayerNames.f_cu)).to.equal(
            null,
        );
    });

    test("a pad whose margin leaves no opening is not drawn", () => {
        expect(shapes_on(LayerNames.b_paste)).to.have.length(0);
        // Its copper and mask are untouched.
        const mask = shapes_on(LayerNames.b_mask);
        expect(mask).to.have.length(1);
        expect((mask[0] as Circle).radius).to.be.closeTo(0.6 + 0.05, 1e-9);
    });

    test("openings are drawn at their margined size", () => {
        const paste = shapes_on(LayerNames.f_paste);
        const polygons = paste.filter(
            (s): s is Polygon => s instanceof Polygon,
        );
        const widths = polygons
            .map((p) => {
                const xs = p.points.map((v) => v.x);
                return Math.max(...xs) - Math.min(...xs);
            })
            .sort((a, b) => a - b);
        // The paste-only pad as drawn, C_0805 pad 1 shrunk by 0.2 a side,
        // pad 2 grown by the board's 0.1 (as a rounded outline around the
        // copper) and the QFN pad by 0.65 a side.
        expect(widths).to.have.length(4);
        [1, 1.6, 2, 2.7].forEach((w, i) =>
            expect(widths[i]).to.be.closeTo(w, 1e-9),
        );

        const outlines = paste.filter(
            (s): s is Polyline => s instanceof Polyline,
        );
        expect(outlines).to.have.length(1);
        expect(outlines[0]!.width).to.be.closeTo(0.2, 1e-9);
    });

    test("a custom pad keeps its copper outline, unclamped", () => {
        const custom = pad(board(SHAPES), "11");
        expect(pad_layer_margin(custom, LayerNames.f_paste)!.x).to.equal(-1000);

        const paste = shapes_on(LayerNames.f_paste, SHAPES).filter(
            (s): s is Polygon => s instanceof Polygon,
        );
        const extents = paste
            .map((p) => {
                const xs = p.points.map((v) => v.x);
                return Math.max(...xs) - Math.min(...xs);
            })
            .sort((a, b) => a - b);
        expect(extents).to.have.length(2);
        expect(extents[0], "anchor").to.be.closeTo(1, 1e-9);
        expect(extents[1], "primitive").to.be.closeTo(4, 1e-9);
    });

    test("a wildcard pad gets its margin on both sides", () => {
        for (const name of [LayerNames.f_mask, LayerNames.b_mask]) {
            const circles = shapes_on(name, SHAPES).filter(
                (s): s is Circle => s instanceof Circle,
            );
            expect(circles, name).to.have.length(1);
            expect(circles[0]!.radius, name).to.be.closeTo(0.8 + 0.1, 1e-9);
        }
        for (const name of [LayerNames.f_paste, LayerNames.b_paste]) {
            const circles = shapes_on(name, SHAPES).filter(
                (s): s is Circle => s instanceof Circle && s.center.x == 20,
            );
            expect(circles, name).to.have.length(1);
            expect(circles[0]!.radius, name).to.be.closeTo(0.8 - 0.1, 1e-9);
        }
    });

    test("a circle shrinks by its negative per-axis paste margin", () => {
        const m = pad_layer_margin(
            pad(board(SHAPES), "13"),
            LayerNames.f_paste,
        )!;
        expect(m.x).to.be.closeTo(-0.1 - 0.12, 1e-9);
        expect(m.y).to.be.closeTo(-0.1 - 0.12, 1e-9);

        const circles = shapes_on(LayerNames.f_paste, SHAPES).filter(
            (s): s is Circle => s instanceof Circle && s.center.x == 30,
        );
        expect(circles).to.have.length(1);
        expect(circles[0]!.radius).to.be.closeTo(0.6 - 0.22, 1e-9);
    });

    test("a trapezoid grown by a uniform margin gets rounded corners", () => {
        const mask = shapes_on(LayerNames.b_mask, SHAPES);
        const outlines = mask.filter(
            (s): s is Polyline => s instanceof Polyline,
        );
        expect(outlines).to.have.length(1);
        expect(outlines[0]!.width).to.be.closeTo(0.2, 1e-9);
    });
});

/**
 * The board body: Edge.Cuts chained into closed outlines, cutouts left open,
 * open outlines left unfilled, and the layer that paints it.
 *
 * Shapes are checked by the area of the triangles the painter draws, so a
 * wrong fill (a bridge outside the board, a missed hole) shows up as a wrong
 * area rather than passing on the outline alone.
 */
import { expect } from "@esm-bundle/chai";
import { BoardParser } from "kicad-parser";

import { polygon_signed_area } from "../src/base/math";
import { KicadPCB } from "../src/kicad";
import themes from "../src/kicanvas/themes";
import {
    BoardSubstrate,
    board_edge_loops,
} from "../src/viewers/board/board-substrate";
import { LayerNames, LayerSet } from "../src/viewers/board/layers";

function board(items: string): KicadPCB {
    return new KicadPCB(
        "substrate.kicad_pcb",
        new BoardParser().parse(`
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
  ${items}
)`) as never,
    );
}

const stroke = `(stroke (width 0.1) (type default)) (layer "Edge.Cuts")`;
const line = (x1: number, y1: number, x2: number, y2: number) =>
    `(gr_line (start ${x1} ${y1}) (end ${x2} ${y2}) ${stroke})`;
const rect = (x1: number, y1: number, x2: number, y2: number) =>
    `(gr_rect (start ${x1} ${y1}) (end ${x2} ${y2}) ${stroke} (fill none))`;
/** A closed outline as consecutive gr_lines. */
const outline = (...pts: [number, number][]) =>
    pts
        .map(([x, y], i) => {
            const [x2, y2] = pts[(i + 1) % pts.length]!;
            return line(x, y, x2, y2);
        })
        .join("\n");

/** Area covered by the body's triangles. */
function filled_area(substrate: BoardSubstrate) {
    const v = substrate.triangles;
    let sum = 0;
    for (let i = 0; i < v.length; i += 6) {
        sum += Math.abs(
            (v[i + 2]! - v[i]!) * (v[i + 5]! - v[i + 1]!) -
                (v[i + 4]! - v[i]!) * (v[i + 3]! - v[i + 1]!),
        );
    }
    return sum / 2;
}

const body = (items: string) => BoardSubstrate.from_board(board(items));

suite("board substrate", () => {
    test("chains loose lines drawn in any direction into one outline", () => {
        const s = body(
            [
                line(0, 0, 40, 0),
                line(40, 30, 40, 0), // reversed
                line(0, 30, 40, 30),
                line(0, 0, 0, 30),
            ].join("\n"),
        );
        expect(s.outlines).to.have.length(1);
        expect(s.open_chains).to.equal(0);
        expect(filled_area(s)).to.be.closeTo(1200, 1e-3);
    });

    // A 5 mm rounded corner removes (1 - pi/4) * 25 from the box. The arc
    // is drawn once in each direction: the chain must follow either.
    for (const [name, arc] of [
        ["counterclockwise", "(start 35 0) (mid 38.5355 1.4645) (end 40 5)"],
        ["clockwise", "(start 40 5) (mid 38.5355 1.4645) (end 35 0)"],
    ]) {
        test(`follows a ${name} arc corner`, () => {
            const s = body(
                [
                    line(0, 0, 35, 0),
                    `(gr_arc ${arc} ${stroke})`,
                    line(40, 5, 40, 30),
                    line(40, 30, 0, 30),
                    line(0, 30, 0, 0),
                ].join("\n"),
            );
            expect(s.outlines).to.have.length(1);
            expect(filled_area(s)).to.be.closeTo(
                1200 - (1 - Math.PI / 4) * 25,
                0.1,
            );
        });
    }

    test("closes an outline through a gr_curve edge", () => {
        // The bottom edge bows out by a cubic Bezier.
        const s = body(
            [
                line(0, 30, 0, 0),
                line(0, 0, 40, 0),
                line(40, 0, 40, 30),
                `(gr_curve (pts (xy 40 30) (xy 40 40) (xy 0 40) (xy 0 30)) ${stroke})`,
            ].join("\n"),
        );
        expect(s.outlines).to.have.length(1);
        // Past its chord, a cubic with both control points 10 mm out over a
        // 40 mm span encloses 3/10 * 40 * (10 + 10) = 240; the 32-segment
        // polyline falls short of that by under 0.5.
        expect(filled_area(s)).to.be.closeTo(1440, 0.5);
    });

    test("leaves an outline with a gap unfilled and counts it", () => {
        const s = body(
            [line(0, 0, 40, 0), line(40, 0, 40, 30), line(40, 30, 0, 30)].join(
                "\n",
            ),
        );
        expect(s.outlines).to.have.length(0);
        expect(s.open_chains).to.equal(1);
        expect(s.triangles.length).to.equal(0);
    });

    test("leaves a cutout open", () => {
        const s = body([rect(0, 0, 40, 30), rect(10, 10, 20, 20)].join("\n"));
        expect(s.outlines).to.have.length(1);
        expect(s.outlines[0]!.holes).to.have.length(1);
        expect(filled_area(s)).to.be.closeTo(1200 - 100, 1e-3);
    });

    test("leaves two cutouts open", () => {
        const s = body(
            [rect(0, 0, 40, 30), rect(5, 5, 15, 15), rect(25, 15, 35, 25)].join(
                "\n",
            ),
        );
        expect(s.outlines[0]!.holes).to.have.length(2);
        expect(filled_area(s)).to.be.closeTo(1200 - 200, 1e-3);
    });

    test("keeps a cutout in a concave outline inside the board", () => {
        // A U: two 100 mm arms with a 1 mm notch between them. The right
        // arm's inner edge has a vertex level with a cutout in the left arm,
        // nearer to it than any vertex of the left arm, so joining the cutout
        // to its nearest outline vertex would bridge across the notch.
        const s = body(
            [
                outline(
                    [0, 0],
                    [30, 0],
                    [30, 100],
                    [11, 100],
                    [11, 53],
                    [11, 10],
                    [10, 10],
                    [10, 100],
                    [0, 100],
                ),
                rect(8, 50, 9.5, 56),
            ].join("\n"),
        );
        expect(s.outlines).to.have.length(1);
        expect(filled_area(s)).to.be.closeTo(3000 - 90 - 9, 1e-3);
    });

    test("fills an island inside a cutout", () => {
        const s = body(
            [rect(0, 0, 40, 30), rect(5, 5, 35, 25), rect(10, 10, 20, 20)].join(
                "\n",
            ),
        );
        expect(s.outlines).to.have.length(2);
        expect(filled_area(s)).to.be.closeTo(1200 - 600 + 100, 1e-3);
    });

    test("cuts a slot drawn inside a placed, rotated footprint", () => {
        const s = body(
            [
                rect(0, 0, 40, 30),
                `(footprint "Test:Slot" (layer "F.Cu") (at 20 15 90)
                  (fp_rect (start -1 -3) (end 1 3) ${stroke} (fill none)))`,
            ].join("\n"),
        );
        expect(s.outlines[0]!.holes).to.have.length(1);
        const hole = s.outlines[0]!.holes[0]!;
        const xs = hole.map((p) => p.x);
        const ys = hole.map((p) => p.y);
        // Turned a quarter: 6 mm across, 2 mm high, centred on (20, 15).
        expect(Math.max(...xs) - Math.min(...xs)).to.be.closeTo(6, 1e-4);
        expect(Math.max(...ys) - Math.min(...ys)).to.be.closeTo(2, 1e-4);
        expect((Math.max(...xs) + Math.min(...xs)) / 2).to.be.closeTo(20, 1e-4);
        expect(filled_area(s)).to.be.closeTo(1200 - 12, 1e-3);
    });

    test("joins a footprint's edge into the board's own outline", () => {
        const s = body(
            [
                line(0, 30, 0, 0),
                line(0, 0, 40, 0),
                line(40, 0, 40, 30),
                // The fourth side, in footprint coordinates.
                `(footprint "Test:Edge" (layer "F.Cu") (at 20 30)
                  (fp_line (start 20 0) (end -20 0) ${stroke}))`,
            ].join("\n"),
        );
        expect(s.outlines).to.have.length(1);
        expect(s.open_chains).to.equal(0);
        expect(filled_area(s)).to.be.closeTo(1200, 1e-3);
    });

    test("loops come back as rings with no closing repeat", () => {
        const { loops } = board_edge_loops(
            board(outline([0, 0], [40, 0], [40, 30], [0, 30])),
        );
        expect(loops).to.have.length(1);
        expect(loops[0]).to.have.length(4);
        expect(Math.abs(polygon_signed_area(loops[0]!))).to.equal(1200);
    });

    test("is built once per board", () => {
        const pcb = board(rect(0, 0, 40, 30));
        expect(BoardSubstrate.for_board(pcb)).to.equal(
            BoardSubstrate.for_board(pcb),
        );
    });

    test("paints on its own layer, below the board and tied to Edge.Cuts", () => {
        const pcb = board(rect(0, 0, 40, 30));
        const layers = new LayerSet(pcb, themes.default.board);
        const substrate = layers.by_name(LayerNames.board_substrate)!;
        expect(substrate).to.exist;
        expect(substrate.interactive).to.equal(false);
        // Its own theme colour, not the canvas background.
        expect(substrate.color.to_css()).to.equal(
            themes.default.board.board_substrate.with_alpha(1).to_css(),
        );
        expect(substrate.color.to_css()).not.to.equal(
            themes.default.board.background.with_alpha(1).to_css(),
        );

        // Not a user layer: hosts and the layer panel never see it.
        expect(
            Array.from(layers.in_ui_order()).map((l) => l.name),
        ).not.to.include(LayerNames.board_substrate);

        const order = Array.from(layers.in_display_order()).map((l) => l.name);
        expect(order.indexOf(LayerNames.board_substrate)).to.be.lessThan(
            order.indexOf(LayerNames.b_cu),
        );

        expect(substrate.visible).to.equal(true);
        layers.by_name(LayerNames.edge_cuts)!.visible = false;
        expect(substrate.visible).to.equal(false);
    });
});

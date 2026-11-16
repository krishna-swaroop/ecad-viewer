/**
 * gr_curve and fp_curve: parsed as cubic Beziers, kept apart from polygons
 * (which also carry `pts`), and sampled from their first to their last
 * control point.
 */
import { expect } from "@esm-bundle/chai";
import { BoardParser } from "kicad-parser";

import { FpCurve, GrCurve, GrPoly, KicadPCB } from "../src/kicad/board";

const BOARD = `
(kicad_pcb
  (version 20240108)
  (generator "pcbnew")
  (paper "A4")
  (layers
    (0 "F.Cu" signal)
    (31 "B.Cu" signal)
    (37 "F.SilkS" user)
    (44 "Edge.Cuts" user)
  )
  (net 0 "")
  (footprint "Test:Curve"
    (layer "F.Cu")
    (at 10 20)
    (fp_curve (pts (xy 0 0) (xy 1 2) (xy 3 2) (xy 4 0))
      (stroke (width 0.12) (type solid)) (layer "F.SilkS"))
  )
  (gr_curve (pts (xy 0 0) (xy 0 10) (xy 10 10) (xy 10 0))
    (stroke (width 0.1) (type default)) (layer "Edge.Cuts"))
  (gr_poly (pts (xy 0 0) (xy 1 0) (xy 1 1))
    (stroke (width 0.1) (type default)) (fill none) (layer "F.SilkS"))
)`;

suite("board curves", () => {
    const pcb = new KicadPCB(
        "curve.kicad_pcb",
        new BoardParser().parse(BOARD) as never,
    );

    test("gr_curve is a curve and gr_poly is still a polygon", () => {
        const curves = pcb.drawings.filter((d) => d instanceof GrCurve);
        expect(curves).to.have.length(1);
        expect(pcb.drawings.filter((d) => d instanceof GrPoly)).to.have.length(
            1,
        );

        const curve = curves[0] as GrCurve;
        expect(curve.layer).to.equal("Edge.Cuts");
        expect(curve.width).to.equal(0.1);
        const points = curve.points;
        expect(points[0]!.x).to.equal(0);
        expect(points[points.length - 1]!.x).to.equal(10);
        // The midpoint of this symmetric curve is (5, 7.5).
        const mid = curve.curve.getPoint(0.5);
        expect(mid.x).to.be.closeTo(5, 1e-9);
        expect(mid.y).to.be.closeTo(7.5, 1e-9);
    });

    test("fp_curve belongs to its footprint", () => {
        const fp = pcb.footprints[0]!;
        const curves = fp.drawings.filter((d) => d instanceof FpCurve);
        expect(curves).to.have.length(1);
        expect((curves[0] as FpCurve).end.x).to.equal(4);
    });
});

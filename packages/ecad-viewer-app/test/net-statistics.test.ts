/**
 * Per-net routing summary (`net_statistics`), the numbers a host shows when a
 * net is selected: routed length over straight and arc tracks, the copper
 * layers those tracks use, and track / via counts.
 */
import { expect } from "@esm-bundle/chai";
import { BoardParser } from "kicad-parser";

import { KicadPCB } from "../src/kicad";
import { BoardBBoxVisitor } from "../src/kicad/board_bbox_visitor";
import { net_statistics } from "../src/kicad/net_statistics";

// Net 1 (SIG): a 10 mm track on F.Cu, a 5 mm track on In1.Cu, a quarter
// circle of radius 4 on B.Cu (2π mm, centre 14,5), and two vias. Net 2 (GND): one 3 mm
// track and no vias. Layers are declared bottom-first so stack order and
// alphabetical order disagree.
const BOARD = `
(kicad_pcb
  (version 20240108)
  (generator "pcbnew")
  (paper "A4")
  (layers
    (0 "F.Cu" signal)
    (1 "In1.Cu" signal)
    (31 "B.Cu" signal)
  )
  (net 0 "")
  (net 1 "SIG")
  (net 2 "GND")
  (segment (start 0 0) (end 10 0) (width 0.2) (layer "F.Cu") (net 1) (uuid "s1"))
  (segment (start 10 0) (end 10 5) (width 0.2) (layer "In1.Cu") (net 1) (uuid "s2"))
  (arc (start 10 5) (mid 11.171573 7.828427) (end 14 9) (width 0.2) (layer "B.Cu") (net 1) (uuid "a1"))
  (via (at 10 0) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "v1"))
  (via (at 10 5) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "v2"))
  (segment (start 0 20) (end 3 20) (width 0.2) (layer "F.Cu") (net 2) (uuid "s3"))
)
`;

function board(): KicadPCB {
    return new KicadPCB(
        "fixture.kicad_pcb",
        new BoardParser().parse(BOARD) as never,
    );
}

const QUARTER_CIRCLE = (Math.PI * 4) / 2;

suite("net_statistics", () => {
    test("sums straight and arc tracks, counts vias, orders layers by stack", () => {
        const stats = net_statistics(board(), { name: "SIG" });
        expect(stats).to.not.equal(null);
        expect(stats!.net).to.equal("SIG");
        expect(stats!.netCode).to.equal(1);
        expect(stats!.routedLength).to.be.closeTo(15 + QUARTER_CIRCLE, 1e-4);
        expect(stats!.layers).to.deep.equal(["F.Cu", "In1.Cu", "B.Cu"]);
        expect(stats!.trackCount).to.equal(3);
        expect(stats!.viaCount).to.equal(2);
    });

    test("a net with a single track and no vias", () => {
        const stats = net_statistics(board(), { name: "GND" });
        expect(stats).to.deep.equal({
            net: "GND",
            netCode: 2,
            routedLength: 3,
            layers: ["F.Cu"],
            trackCount: 1,
            viaCount: 0,
        });
    });

    test("resolves by net code when the name is unknown", () => {
        const stats = net_statistics(board(), {
            name: "NOT_ON_BOARD",
            netCode: 2,
        });
        expect(stats?.net).to.equal("GND");
    });

    test("prefers the name over a stale net code", () => {
        const stats = net_statistics(board(), { name: "GND", netCode: 1 });
        expect(stats?.net).to.equal("GND");
    });

    test("returns null for unknown nets and for net 0", () => {
        expect(net_statistics(board(), { name: "VCC" })).to.equal(null);
        expect(net_statistics(board(), { netCode: 0 })).to.equal(null);
        expect(net_statistics(board(), { name: "" })).to.equal(null);
        expect(net_statistics(board(), {})).to.equal(null);
    });
});

suite("BoardBBoxVisitor net info", () => {
    test("includes arc tracks in routed length and layers", () => {
        const visitor = new BoardBBoxVisitor();
        visitor.visit(board());
        const info = visitor.net_info.get(1)!;
        expect(info.routed_length).to.be.closeTo(15 + QUARTER_CIRCLE, 1e-4);
        expect([...info.layers].sort()).to.deep.equal([
            "B.Cu",
            "F.Cu",
            "In1.Cu",
        ]);
    });
});

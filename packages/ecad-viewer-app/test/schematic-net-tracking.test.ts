import { expect } from "@esm-bundle/chai";
import { SchematicParser } from "kicad-parser";

import { BBox, Vec2 } from "../src/base/math";
import {
    flow_starts,
    overbar_text,
    world_layout,
} from "../src/ecad-viewer/net-tracking/geometry";
import { normalize_schematic_selection } from "../src/ecad-viewer/host-adapter";
import {
    net_closure,
    net_instance_at,
    net_instances,
    wire_instance,
    wired_instances,
    type NetInstancePage,
} from "../src/ecad-viewer/net-tracking/net-graph";
import { KicadSch } from "../src/kicad/schematic";
import { HighlightMotion } from "../src/viewers/schematic/highlight-motion";
import {
    NET_HIGHLIGHT_CHANNEL,
    local_trace_scene,
    members_on_page,
    net_highlight_scene,
} from "../src/viewers/schematic/net-highlight";

const WIRE = "00000000-0000-0000-0000-0000000000a1";
const OTHER_WIRE = "00000000-0000-0000-0000-0000000000a2";
const JUNCTION = "00000000-0000-0000-0000-0000000000b1";
const ENTRY = "00000000-0000-0000-0000-0000000000c1";

const ROOT = `
(kicad_sch
  (version 20250114)
  (generator "eeschema")
  (uuid "00000000-0000-0000-0000-000000000001")
  (wire (pts (xy 10 10) (xy 20 10)) (stroke (width 0) (type default)) (uuid "${WIRE}"))
  (wire (pts (xy 10 30) (xy 20 30)) (stroke (width 0) (type default)) (uuid "${OTHER_WIRE}"))
  (junction (at 20 10) (diameter 0) (color 0 0 0 0) (uuid "${JUNCTION}"))
  (sheet (at 40 0) (size 20 20)
    (uuid "00000000-0000-0000-0000-0000000000d1")
    (property "Sheetname" "Child" (at 40 -1 0) (effects (font (size 1.27 1.27))))
    (property "Sheetfile" "child.kicad_sch" (at 40 21 0) (effects (font (size 1.27 1.27))))
    (pin "SDA" input (at 40 10 180) (uuid "${ENTRY}") (effects (font (size 1.27 1.27))))
  )
)
`;

const root = () =>
    new KicadSch("root.kicad_sch", new SchematicParser().parse(ROOT));

suite("schematic net tracking", () => {
    test("a sheet entry is reported as a sheet pin, not a hierarchical label", () => {
        const doc = root();
        const [entry] = doc.sheets[0]!.hierarchicalSheetPins;
        const selection = normalize_schematic_selection(entry, doc);
        expect(selection?.itemType).to.equal("sheet-pin");
        expect(selection?.net).to.equal("SDA");
        expect(selection?.uuid).to.equal(ENTRY);
    });

    test("only the open sheet instance's members are drawn", () => {
        const nets = [
            {
                name: "SDA",
                pages: [
                    { sheetPath: "/root", uuids: [WIRE, JUNCTION, ENTRY] },
                    { sheetPath: "/root/child", uuids: ["elsewhere"] },
                ],
            },
        ];
        expect(members_on_page(nets, "/root")[0]!.uuids.size).to.equal(3);
        expect(members_on_page(nets, "/nowhere")).to.deep.equal([]);
    });

    test("wires are lit, junctions are dots and labels or entries are outlined", () => {
        const doc = root();
        const scene = net_highlight_scene(
            [
                {
                    name: "SDA",
                    pages: [
                        { sheetPath: "/root", uuids: [WIRE, JUNCTION, ENTRY] },
                    ],
                },
            ],
            "/root",
            doc,
            {
                bbox: (uuid) =>
                    uuid === ENTRY ? new BBox(38, 9, 4, 2) : undefined,
                pin_stem: () => undefined,
            },
        );
        expect(scene.channelId).to.equal(NET_HIGHLIGHT_CHANNEL);
        expect(scene.visible).to.equal(true);
        const ids = scene.primitives.map((primitive) => primitive.id);
        expect(ids).to.deep.equal([
            `halo:${WIRE}`,
            `glow:${WIRE}`,
            `core:${WIRE}`,
            `halo:${JUNCTION}`,
            `dot:${JUNCTION}`,
            `wash:${ENTRY}`,
            `edge:${ENTRY}`,
        ]);
        expect(ids.some((id) => id.includes(OTHER_WIRE))).to.equal(false);
    });

    test("no members on the open sheet draws nothing", () => {
        const scene = net_highlight_scene(
            [
                {
                    name: "SDA",
                    pages: [{ sheetPath: "/root/child", uuids: [WIRE] }],
                },
            ],
            "/root",
            root(),
            { bbox: () => undefined, pin_stem: () => undefined },
        );
        expect(scene.visible).to.equal(false);
        expect(scene.primitives).to.deep.equal([]);
    });
});

const CHILD_LABEL = "00000000-0000-0000-0000-0000000000e1";
const GLOBAL_A = "00000000-0000-0000-0000-0000000000f1";
const GLOBAL_B = "00000000-0000-0000-0000-0000000000f2";

const CHILD = `
(kicad_sch
  (version 20250114)
  (generator "eeschema")
  (uuid "00000000-0000-0000-0000-000000000002")
  (hierarchical_label "SDA" (shape input) (at 10 10 180) (effects (font (size 1.27 1.27))) (uuid "${CHILD_LABEL}"))
  (global_label "VBUS" (shape input) (at 30 10 0) (effects (font (size 1.27 1.27))) (uuid "${GLOBAL_B}"))
)
`;

const ROOT_WITH_GLOBAL = ROOT.replace(
    "  (sheet",
    `  (global_label "VBUS" (shape input) (at 5 50 0) (effects (font (size 1.27 1.27))) (uuid "${GLOBAL_A}"))\n  (sheet`,
);

function hierarchy(): NetInstancePage[] {
    const parser = new SchematicParser();
    return [
        {
            key: "root",
            name: "Root",
            document: new KicadSch(
                "root.kicad_sch",
                parser.parse(ROOT_WITH_GLOBAL),
            ),
        },
        {
            key: "child",
            name: "Child",
            document: new KicadSch("child.kicad_sch", parser.parse(CHILD)),
            parent_key: "root",
            sheet_uuid: "00000000-0000-0000-0000-0000000000d1",
        },
    ];
}

suite("net instances", () => {
    test("a sheet entry leads into its child sheet's hierarchical label", () => {
        const pages = hierarchy();
        const from = net_instance_at(pages, "root", ENTRY)!;
        expect(from.kind).to.equal("sheet-pin");
        expect(net_instances(pages, from)).to.deep.equal([
            {
                page: "child",
                uuid: CHILD_LABEL,
                name: "SDA",
                kind: "hierarchical",
            },
        ]);
    });

    test("a hierarchical label leads up to the entry that instantiates its sheet", () => {
        const pages = hierarchy();
        const from = net_instance_at(pages, "child", CHILD_LABEL)!;
        expect(
            net_instances(pages, from).map((it) => [it.page, it.uuid]),
        ).to.deep.equal([["root", ENTRY]]);
    });

    test("a global label leads to every other global label of its name", () => {
        const pages = hierarchy();
        const from = net_instance_at(pages, "root", GLOBAL_A)!;
        expect(net_instances(pages, from).map((it) => it.uuid)).to.deep.equal([
            GLOBAL_B,
        ]);
    });
});

suite("local trace", () => {
    test("~ on a local label joins its namesakes on the sheet", () => {
        const doc = new KicadSch(
            "local.kicad_sch",
            new SchematicParser().parse(`
(kicad_sch
  (version 20250114)
  (generator "eeschema")
  (uuid "00000000-0000-0000-0000-000000000003")
  (label "CLK" (at 10 10 0) (effects (font (size 1.27 1.27))) (uuid "00000000-0000-0000-0000-000000000101"))
  (label "CLK" (at 80 40 0) (effects (font (size 1.27 1.27))) (uuid "00000000-0000-0000-0000-000000000102"))
)
`),
        );
        const boxes: Record<string, BBox> = {
            "00000000-0000-0000-0000-000000000101": new BBox(10, 9, 4, 2),
            "00000000-0000-0000-0000-000000000102": new BBox(80, 39, 4, 2),
        };
        const scene = local_trace_scene("CLK", doc, {
            bbox: (uuid) => boxes[uuid],
        });
        const line = scene.primitives.find((p) => p.id.startsWith("line:"));
        expect(line?.kind).to.equal("polyline");
        expect((line as { points: number[][] }).points).to.deep.equal([
            [12, 10],
            [82, 40],
        ]);
    });
});

suite("world view", () => {
    test("a sheet entry's reach points outward, a hop deeper each time", () => {
        const pages = hierarchy();
        const closure = net_closure(
            pages,
            net_instance_at(pages, "root", ENTRY)!,
        );
        expect(closure.links.map(([a, b]) => [a.uuid, b.uuid])).to.deep.equal([
            [ENTRY, CHILD_LABEL],
        ]);
        expect(closure.depth.get(`child#${CHILD_LABEL}`)).to.equal(1);
    });

    test("a global label fans out to each of its namesakes", () => {
        const pages = hierarchy();
        const closure = net_closure(
            pages,
            net_instance_at(pages, "root", GLOBAL_A)!,
        );
        expect(closure.links.map(([a, b]) => [a.uuid, b.uuid])).to.deep.equal([
            [GLOBAL_A, GLOBAL_B],
        ]);
    });

    test("sheets are laid out in rows with a gap", () => {
        const offsets = world_layout(
            [
                new BBox(0, 0, 100, 50),
                new BBox(0, 0, 80, 70),
                new BBox(0, 0, 60, 40),
            ],
            10,
        );
        expect(offsets.map((v) => [v.x, v.y])).to.deep.equal([
            [0, 0],
            [110, 0],
            [0, 80],
        ]);
    });
});

suite("wired instances", () => {
    test("labels and entries joined by wires on one sheet are one net", () => {
        const doc = new KicadSch(
            "wired.kicad_sch",
            new SchematicParser().parse(`
(kicad_sch
  (version 20250114)
  (generator "eeschema")
  (uuid "00000000-0000-0000-0000-000000000004")
  (wire (pts (xy 10 10) (xy 30 10)) (stroke (width 0) (type default)) (uuid "00000000-0000-0000-0000-000000000201"))
  (wire (pts (xy 30 10) (xy 30 40)) (stroke (width 0) (type default)) (uuid "00000000-0000-0000-0000-000000000202"))
  (global_label "A" (shape input) (at 10 10 180) (effects (font (size 1.27 1.27))) (uuid "00000000-0000-0000-0000-000000000211"))
  (global_label "B" (shape input) (at 30 40 0) (effects (font (size 1.27 1.27))) (uuid "00000000-0000-0000-0000-000000000212"))
  (global_label "C" (shape input) (at 80 80 0) (effects (font (size 1.27 1.27))) (uuid "00000000-0000-0000-0000-000000000213"))
)
`),
        );
        const pages = [{ key: "w", name: "W", document: doc }];
        const from = net_instance_at(
            pages,
            "w",
            "00000000-0000-0000-0000-000000000211",
        )!;
        expect(wired_instances(pages, from).map((it) => it.name)).to.deep.equal(
            ["B"],
        );
        // A wire traces from a label it carries.
        expect(
            wire_instance(pages, "w", "00000000-0000-0000-0000-000000000202")
                ?.name,
        ).to.equal("A");
    });
});

suite("world view flow", () => {
    test("added sheets join the end without moving the ones shown", () => {
        const first = world_layout(
            [new BBox(0, 0, 100, 50), new BBox(0, 0, 80, 70)],
            10,
            2,
        );
        const more = world_layout(
            [
                new BBox(0, 0, 100, 50),
                new BBox(0, 0, 80, 70),
                new BBox(0, 0, 60, 40),
            ],
            10,
            2,
        );
        expect(more.slice(0, 2).map((v) => [v.x, v.y])).to.deep.equal(
            first.map((v) => [v.x, v.y]),
        );
        expect([more[2]!.x, more[2]!.y]).to.deep.equal([0, 80]);
    });

    test("KiCad overbar markup becomes a bar over the inverted part", () => {
        expect(overbar_text("~{FPGA_SELF_PROGRAM}")).to.deep.equal({
            text: "FPGA_SELF_PROGRAM",
            over: [[0, 17]],
        });
        expect(overbar_text("RX_~{EN}")).to.deep.equal({
            text: "RX_EN",
            over: [[3, 5]],
        });
        expect(overbar_text("SDA").over).to.deep.equal([]);
    });

    test("the dash and name pattern repeats along the run and moves with time", () => {
        expect(flow_starts(100, 40, 0)).to.deep.equal([-40, 0, 40, 80]);
        expect(flow_starts(100, 40, 10)).to.deep.equal([-30, 10, 50, 90]);
    });
});

const power_sheet = (uuid: string, symbols: Array<[string, number]>) => `
(kicad_sch
  (version 20250114)
  (generator "eeschema")
  (uuid "${uuid}")
  (lib_symbols
    (symbol "power:+5V" (power) (pin_names (offset 0)) (exclude_from_sim no) (in_bom yes) (on_board yes)
      (property "Reference" "#PWR" (at 0 -3.81 0) (effects (font (size 1.27 1.27)) (hide yes)))
      (property "Value" "+5V" (at 0 3.556 0) (effects (font (size 1.27 1.27))))
      (symbol "+5V_0_1" (polyline (pts (xy 0 0) (xy 0 2.54)) (stroke (width 0) (type default)) (fill (type none))))
      (symbol "+5V_1_1" (pin power_in line (at 0 0 90) (length 0) (hide yes)
        (name "+5V" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27))))))
    )
  )
${symbols
    .map(
        ([
            id,
            x,
        ]) => `  (symbol (lib_id "power:+5V") (at ${x} 10 0) (unit 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no)
    (uuid "${id}")
    (property "Reference" "#PWR0${x}" (at ${x} 14 0) (effects (font (size 1.27 1.27)) (hide yes)))
    (property "Value" "+5V" (at ${x} 6 0) (effects (font (size 1.27 1.27)))))`,
    )
    .join("\n")}
)
`;

suite("power rails", () => {
    test("a power symbol leads to one symbol of its rail on each other sheet", () => {
        const parser = new SchematicParser();
        const pages: NetInstancePage[] = [
            {
                key: "a",
                name: "A",
                document: new KicadSch(
                    "a.kicad_sch",
                    parser.parse(
                        power_sheet("00000000-0000-0000-0000-000000000301", [
                            ["00000000-0000-0000-0000-000000000311", 10],
                        ]),
                    ),
                ),
            },
            {
                key: "b",
                name: "B",
                document: new KicadSch(
                    "b.kicad_sch",
                    parser.parse(
                        power_sheet("00000000-0000-0000-0000-000000000302", [
                            ["00000000-0000-0000-0000-000000000321", 20],
                            ["00000000-0000-0000-0000-000000000322", 30],
                            ["00000000-0000-0000-0000-000000000323", 40],
                        ]),
                    ),
                ),
            },
        ];
        const from = net_instance_at(
            pages,
            "a",
            "00000000-0000-0000-0000-000000000311",
        )!;
        expect([from.kind, from.name]).to.deep.equal(["power", "+5V"]);
        const reached = net_instances(pages, from);
        expect(reached.map((it) => it.page)).to.deep.equal(["b"]);
        // The view links the rail once into each other sheet.
        const closure = net_closure(pages, from);
        expect(closure.links.map(([a, b]) => [a.page, b.page])).to.deep.equal([
            ["a", "b"],
        ]);
    });
});

const lib_power = (name: string) => `
    (symbol "power:${name}" (power) (pin_names (offset 0)) (exclude_from_sim no) (in_bom yes) (on_board yes)
      (property "Reference" "#PWR" (at 0 -3.81 0) (effects (font (size 1.27 1.27)) (hide yes)))
      (property "Value" "${name}" (at 0 3.556 0) (effects (font (size 1.27 1.27))))
      (symbol "${name}_0_1" (polyline (pts (xy 0 0) (xy 0 2.54)) (stroke (width 0) (type default)) (fill (type none))))
      (symbol "${name}_1_1" (pin power_in line (at 0 0 90) (length 0) (hide yes)
        (name "${name}" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))))`;

const placed = (name: string, uuid: string, x: number, y: number) => `
  (symbol (lib_id "power:${name}") (at ${x} ${y} 0) (unit 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no)
    (uuid "${uuid}")
    (property "Reference" "#PWR${x}${y}" (at ${x} ${y + 4} 0) (effects (font (size 1.27 1.27)) (hide yes)))
    (property "Value" "${name}" (at ${x} ${y - 4} 0) (effects (font (size 1.27 1.27)))))`;

const flagged_sheet = (uuid: string, body: string) => `
(kicad_sch
  (version 20250114)
  (generator "eeschema")
  (uuid "${uuid}")
  (lib_symbols ${lib_power("+5V")} ${lib_power("GND")} ${lib_power("PWR_FLAG")})
${body}
)
`;

suite("PWR_FLAG", () => {
    test("a PWR_FLAG on a rail joins no other rail to it", () => {
        const parser = new SchematicParser();
        const pages: NetInstancePage[] = [
            {
                key: "a",
                name: "A",
                document: new KicadSch(
                    "a.kicad_sch",
                    parser.parse(
                        flagged_sheet(
                            "00000000-0000-0000-0000-000000000401",
                            [
                                placed(
                                    "+5V",
                                    "00000000-0000-0000-0000-000000000411",
                                    10,
                                    10,
                                ),
                                placed(
                                    "PWR_FLAG",
                                    "00000000-0000-0000-0000-000000000412",
                                    30,
                                    10,
                                ),
                                `  (wire (pts (xy 10 10) (xy 30 10)) (stroke (width 0) (type default)) (uuid "00000000-0000-0000-0000-000000000413"))`,
                            ].join("\n"),
                        ),
                    ),
                ),
            },
            {
                key: "b",
                name: "B",
                document: new KicadSch(
                    "b.kicad_sch",
                    parser.parse(
                        flagged_sheet(
                            "00000000-0000-0000-0000-000000000402",
                            [
                                placed(
                                    "GND",
                                    "00000000-0000-0000-0000-000000000421",
                                    50,
                                    50,
                                ),
                                placed(
                                    "PWR_FLAG",
                                    "00000000-0000-0000-0000-000000000422",
                                    70,
                                    50,
                                ),
                                `  (wire (pts (xy 50 50) (xy 70 50)) (stroke (width 0) (type default)) (uuid "00000000-0000-0000-0000-000000000423"))`,
                            ].join("\n"),
                        ),
                    ),
                ),
            },
        ];
        const from = net_instance_at(
            pages,
            "a",
            "00000000-0000-0000-0000-000000000411",
        )!;
        const closure = net_closure(pages, from);
        expect(closure.instances.map((it) => it.name)).to.deep.equal(["+5V"]);
        expect(
            net_instance_at(pages, "a", "00000000-0000-0000-0000-000000000412"),
        ).to.equal(null);
    });
});

suite("highlight motion", () => {
    test("a net's pins are lit along their line, and a faded scene is not drawn", () => {
        const doc = root();
        const stem: [Vec2, Vec2] = [new Vec2(0, 0), new Vec2(2.54, 0)];
        const nets = [
            { name: "SDA", pages: [{ sheetPath: "/root", uuids: ["pin-1"] }] },
        ];
        const sheet = {
            bbox: () => undefined,
            pin_stem: (uuid: string) => (uuid === "pin-1" ? stem : undefined),
        };
        const lit = net_highlight_scene(nets, "/root", doc, sheet);
        expect(lit.primitives.map((p) => p.id)).to.deep.equal([
            "halo:pin-1",
            "glow:pin-1",
            "core:pin-1",
        ]);
        const dark = net_highlight_scene(nets, "/root", doc, sheet, {
            intensity: 0,
        });
        expect(dark.visible).to.equal(false);
    });

    test("lighting eases in, a new net swells once, and both settle", () => {
        const motion = new HighlightMotion();
        motion.retarget(true, ["SDA"], 0);
        const start = motion.sample(0);
        expect(start.intensity).to.equal(0);
        expect(start.swell.get("SDA")).to.equal(1);
        const mid = motion.sample(110);
        expect(mid.intensity).to.be.within(0.5, 1);
        const end = motion.sample(2000);
        expect([end.intensity, end.swell.size, end.settled]).to.deep.equal([
            1,
            0,
            true,
        ]);
        motion.retarget(false, [], 2000);
        expect(motion.sample(2000 + 400).intensity).to.equal(0);
    });

    test("without motion every change lands at once", () => {
        const motion = new HighlightMotion(false);
        motion.retarget(true, ["SDA"], 0);
        const now = motion.sample(0);
        expect([now.intensity, now.swell.size, now.settled]).to.deep.equal([
            1,
            0,
            true,
        ]);
    });
});

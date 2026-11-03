import { expect } from "@esm-bundle/chai";
import { SchematicParser } from "kicad-parser";

import { BBox } from "../src/base/math";
import { world_layout } from "../src/ecad-viewer/insets/world-view";
import { normalize_schematic_selection } from "../src/ecad-viewer/host-adapter";
import {
    net_closure,
    net_instance_at,
    net_instances,
    wired_instances,
    type NetInstancePage,
} from "../src/ecad-viewer/insets/net-instances";
import { KicadSch } from "../src/kicad/schematic";
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

    test("wires glow, junctions are dots and other members are outlined", () => {
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
            (uuid) => (uuid === ENTRY ? new BBox(38, 9, 4, 2) : undefined),
        );
        expect(scene.channelId).to.equal(NET_HIGHLIGHT_CHANNEL);
        expect(scene.visible).to.equal(true);
        const ids = scene.primitives.map((primitive) => primitive.id);
        expect(ids).to.deep.equal([
            `glow:${WIRE}`,
            `wire:${WIRE}`,
            `junction:${JUNCTION}`,
            `item:${ENTRY}`,
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
            () => undefined,
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
        const scene = local_trace_scene("CLK", doc, (uuid) => boxes[uuid]);
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
    });
});

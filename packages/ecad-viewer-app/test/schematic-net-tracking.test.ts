import { expect } from "@esm-bundle/chai";
import { SchematicParser } from "kicad-parser";

import { BBox } from "../src/base/math";
import { normalize_schematic_selection } from "../src/ecad-viewer/host-adapter";
import { KicadSch } from "../src/kicad/schematic";
import {
    NET_HIGHLIGHT_CHANNEL,
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

import { expect } from "@esm-bundle/chai";
import { BoardParser } from "kicad-parser";
import { KicadPCB } from "../src/kicad";
import { custom_layer_names } from "../src/viewers/board/layers";

const BOARD = `(kicad_pcb
(version 20240108)
(generator "pcbnew")
(layers
(0 "F.Cu" signal)
(31 "B.Cu" signal)
(37 "F.SilkS" user "F.Silkscreen")
(40 "Dwgs.User" user "User.Drawings")
(44 "Edge.Cuts" user)
(47 "F.CrtYd" user "F.Courtyard")
(54 "User.8" user)
(55 "User.9" user "Script.Cobre")
(41 "Cmts.User" user "Notes")
)
)`;

suite("custom layer names", () => {
    test("reports the board's custom layer names by canonical name", () => {
        const board = new KicadPCB(
            "layers.kicad_pcb",
            new BoardParser().parse(BOARD) as never,
        );

        expect(
            Object.fromEntries(custom_layer_names(board.layers)),
        ).to.deep.equal({
            "User.9": "Script.Cobre",
            "Cmts.User": "Notes",
        });
    });

    test("ignores missing, identical and KiCad default user names", () => {
        const names = custom_layer_names([
            { canonical_name: "User.1" },
            { canonical_name: "User.2", user_name: "User.2" },
            { canonical_name: "B.SilkS", user_name: "B.Silkscreen" },
            { canonical_name: "Eco1.User", user_name: "User.Eco1" },
        ]);

        expect(names.size).to.equal(0);
    });
});

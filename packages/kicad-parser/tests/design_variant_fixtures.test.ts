/**
 * Design-variant oracle fixtures (VAR-01).
 *
 * The files under fixtures/design-variants are a byte-identical copy of the
 * KiCAD-Prism set (backend/tests/fixtures/design_variants); manifest.json
 * records the KiCad 10.0.6 executable that produced the native evidence and
 * the SHA-256 of every file.  This test pins the copy to the manifest, proves
 * the TypeScript side can load the shared expectations, and records what the
 * current parser does with the sources: today it must at least accept every
 * file KiCad accepts.  Round-tripping the variant records is VAR-02/03.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import { BoardParser } from "../src/board_parser";
import { SchematicParser } from "../src/schematic_parser";

const root = path.resolve(__dirname, "fixtures", "design-variants");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

function sha256(file: string): string {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

describe("design-variant fixture manifest", () => {
    test("was produced by KiCad 10.0.6 against contract packet v1.0", () => {
        expect(manifest.kicad.version).toBe("10.0.6");
        expect(manifest.contract).toEqual({ packet: "CONTRACT_PACKET_v1.md", version: "1.0" });
    });

    test("every recorded file is present with the recorded hash", () => {
        const recorded: Record<string, string> = { ...manifest.expected };
        for (const fixture of Object.values<any>(manifest.fixtures)) {
            Object.assign(recorded, fixture.files);
            for (const command of fixture.commands) {
                if (command.output) recorded[command.output] = command.sha256;
            }
        }
        expect(Object.keys(recorded).length).toBeGreaterThan(50);
        for (const [relative, digest] of Object.entries(recorded)) {
            expect({ file: relative, sha256: sha256(path.join(root, relative)) }).toEqual({ file: relative, sha256: digest });
        }
    });
});

describe("shared expectations", () => {
    const names = Object.keys(manifest.fixtures).sort();

    test.each(names)("%s.json loads with the frozen vocabulary", (name) => {
        const expected = JSON.parse(fs.readFileSync(path.join(root, "expected", `${name}.json`), "utf8"));
        expect(expected.schema).toBe("prism.variant_fixture_expectations_a0");
        expect(expected.contract.version).toBe("1.0");
        const catalogNames = expected.catalog.map((entry: any) => entry.name);
        expect(expected.variants.map((variant: any) => variant.name)).toEqual(catalogNames);
        for (const variant of expected.variants) {
            for (const map of ["occurrences", "components", "footprints"]) {
                for (const override of Object.values<any>(variant[map])) {
                    for (const [key, value] of Object.entries(override)) {
                        if (key === "fields") {
                            for (const text of Object.values(value as Record<string, string>)) expect(typeof text).toBe("string");
                        } else {
                            expect(["dnp", "excludeFromBom", "excludeFromBoard", "excludeFromSim", "excludeFromPosFiles"]).toContain(key);
                            expect(typeof value).toBe("boolean");
                        }
                    }
                }
            }
            for (const cls of Object.values(variant.physical)) {
                expect(["visible", "hidden", "ambiguous", "absent"]).toContain(cls);
            }
        }
    });
});

describe("current parser against the fixture sources", () => {
    const schematicParser = new SchematicParser();
    const boardParser = new BoardParser();
    const sources: Array<[string, string]> = [];
    for (const fixture of Object.keys(manifest.fixtures)) {
        for (const relative of Object.keys(manifest.fixtures[fixture].files)) {
            if (relative.endsWith(".kicad_sch") || relative.endsWith(".kicad_pcb")) sources.push([fixture, relative]);
        }
    }

    test.each(sources)("%s: %s parses without throwing", (fixture, relative) => {
        const text = fs.readFileSync(path.join(root, relative), "utf8");
        const nativelyRefused = manifest.fixtures[fixture].commands.some(
            (command: any) => command.exitCode !== 0 && command.argv.includes(path.basename(relative)),
        );
        const parse = () => (relative.endsWith(".kicad_sch") ? schematicParser.parse(text) : boardParser.parse(text));
        if (nativelyRefused && fixture === "malformed") {
            // The unbalanced record is a genuine syntax error; the parser may reject it.
            try {
                parse();
            } catch (error) {
                expect(error).toBeInstanceOf(Error);
            }
            return;
        }
        // KiCad 11 tokens are refused natively (packet N22) but must be tolerated here.
        expect(parse).not.toThrow();
    });
});

import { SchematicParser } from "../src/schematic_parser";

/**
 * `fields_autoplaced` is a flag KiCad writes only when it is set.
 *
 * The parser reads it with `P.atom`, which matches on the token name and
 * handed the whole `(fields_autoplaced no)` list to `T.boolean` — where a
 * non-empty array is truthy. So an explicit `no` came back as `true`.
 *
 * That never showed against KiCad's own files: across the sampled projects
 * there are 134,113 `(fields_autoplaced yes)` and not one `no`, because KiCad
 * omits the token instead of writing `no`. The only thing producing the `no`
 * form was this serializer, which wrote it unconditionally — so the flag
 * inverted on the way back in and flipped to `yes` on the next save.
 *
 * Both halves are fixed: the parser reads the pair form, and the serializer
 * omits the flag when false the way KiCad does, matching what this file
 * already did for `hide`, `bold`, `show_name` and the rest.
 */
function schematic_with(symbol_flag: string, label_flag: string): string {
    return `
(kicad_sch
  (version 20250114)
  (generator "eeschema")
  (uuid "00000000-0000-0000-0000-000000000001")
  (label "NET1" (at 120 100 0) (effects (font (size 1.27 1.27))) ${label_flag}
    (uuid "00000000-0000-0000-0000-0000000000b1")
  )
  (symbol
    (lib_id "Device:R")
    (at 100 100 0)
    (unit 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) ${symbol_flag}
    (uuid "00000000-0000-0000-0000-0000000000a1")
    (property "Reference" "R1" (at 102 98 0) (effects (font (size 1.27 1.27))))
  )
)
`;
}

const parser = new SchematicParser();

function parse(symbol_flag: string, label_flag = "") {
    const sch = parser.parse(schematic_with(symbol_flag, label_flag));
    return {
        symbol: sch.symbols?.[0],
        // Plain labels land under `net_labels`, not `labels`.
        label: sch.net_labels?.[0],
        sch,
    };
}

describe("fields_autoplaced parsing", () => {
    it("reads the bare atom as true", () => {
        expect(parse("(fields_autoplaced)").symbol?.fields_autoplaced).toBe(
            true,
        );
    });

    it("reads (fields_autoplaced yes) as true", () => {
        expect(parse("(fields_autoplaced yes)").symbol?.fields_autoplaced).toBe(
            true,
        );
    });

    it("reads (fields_autoplaced no) as false", () => {
        // The bug: this came back `true`, because the whole list was handed to
        // the boolean coercion and a non-empty array is truthy.
        expect(parse("(fields_autoplaced no)").symbol?.fields_autoplaced).toBe(
            false,
        );
    });

    it("reads an absent flag as false", () => {
        expect(parse("").symbol?.fields_autoplaced).toBeFalsy();
    });

    it("applies to labels too, not only symbols", () => {
        expect(
            parse("", "(fields_autoplaced no)").label?.fields_autoplaced,
        ).toBe(false);
        expect(
            parse("", "(fields_autoplaced yes)").label?.fields_autoplaced,
        ).toBe(true);
    });
});

describe("fields_autoplaced serialization", () => {
    function round_trip(symbol_flag: string, label_flag = ""): string {
        return parser.save(
            parser.parse(schematic_with(symbol_flag, label_flag)),
        );
    }

    it("omits the flag when false, the way KiCad does", () => {
        expect(round_trip("")).not.toContain("fields_autoplaced");
    });

    it("writes the flag when set", () => {
        expect(round_trip("(fields_autoplaced yes)")).toContain(
            "(fields_autoplaced yes)",
        );
    });

    it("never writes the no form KiCad does not produce", () => {
        for (const flag of [
            "",
            "(fields_autoplaced)",
            "(fields_autoplaced yes)",
            "(fields_autoplaced no)",
        ]) {
            expect(round_trip(flag)).not.toContain("fields_autoplaced no");
        }
    });

    it("keeps a false flag false across two round-trips", () => {
        // The regression this issue is about: absent -> `(fields_autoplaced
        // no)` -> parsed true -> `(fields_autoplaced yes)`. The flag inverted
        // itself by being written down.
        const once = round_trip("");
        const twice = parser.save(parser.parse(once));

        expect(parser.parse(twice).symbols?.[0]?.fields_autoplaced).toBeFalsy();
        expect(twice).toBe(once);
    });

    it("is byte-stable across two round-trips with the flag set", () => {
        const once = round_trip(
            "(fields_autoplaced yes)",
            "(fields_autoplaced yes)",
        );
        const twice = parser.save(parser.parse(once));

        expect(twice).toBe(once);
    });
});

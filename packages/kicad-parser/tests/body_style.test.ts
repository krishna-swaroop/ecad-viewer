import { SchematicParser } from "../src/schematic_parser";

/**
 * KiCad renamed the symbol body-style token. `convert` is the legacy spelling;
 * `body_style` is what a current KiCad writes, and its own parser accepts both.
 * Issue #94 was that this parser read only `convert`, and `parse_expr` drops
 * tokens it has no definition for without a word — so a modern file silently
 * lost its De Morgan body style.
 */
function schematic_with(body_style_token: string): string {
    return `
(kicad_sch
  (version 20250114)
  (generator "eeschema")
  (uuid "00000000-0000-0000-0000-000000000001")
  (symbol
    (lib_id "Device:DEMORGAN")
    (at 100 100 0)
    (unit 1) ${body_style_token} (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no)
    (uuid "00000000-0000-0000-0000-0000000000a1")
    (property "Reference" "U1" (at 102 98 0) (effects (font (size 1.27 1.27))))
  )
)
`;
}

function first_symbol(source: string) {
    const parsed = new SchematicParser().parse(source);
    const symbol = parsed.symbols?.[0];
    if (!symbol) {
        throw new Error("fixture parsed to no symbols");
    }
    return symbol;
}

describe("schematic symbol body style", () => {
    it("reads the modern (body_style N) token", () => {
        expect(first_symbol(schematic_with("(body_style 2)")).body_style).toBe(
            2,
        );
    });

    it("reads the legacy (convert N) token", () => {
        expect(first_symbol(schematic_with("(convert 2)")).convert).toBe(2);
    });

    it("leaves both undefined when the file declares neither", () => {
        const symbol = first_symbol(schematic_with(""));

        // The default belongs to the model, not the parser: reporting "absent"
        // is what lets a caller tell a file that said nothing from one that
        // explicitly said style 1.
        expect(symbol.body_style).toBeUndefined();
        expect(symbol.convert).toBeUndefined();
    });
});

/**
 * The serializer used to write `(convert N)` unconditionally, and only when
 * `convert` was set. A KiCad 9 file populates `body_style` instead, so it
 * round-tripped with no body-style token at all and lost the value outright.
 *
 * Round-tripping the file's own spelling — rather than normalising to either
 * one — is what keeps a serialized file byte-comparable with what KiCad wrote.
 * That matters here more than in a plain viewer: this parser also feeds design
 * comparison, where a rewritten token reads as a change nobody made.
 */
describe("schematic symbol body style round-trip", () => {
    const parser = new SchematicParser();

    function round_trip(token: string): string {
        return parser.save(parser.parse(schematic_with(token)));
    }

    it("preserves (body_style N) rather than rewriting it as convert", () => {
        const output = round_trip("(body_style 2)");

        expect(output).toContain("(body_style 2)");
        expect(output).not.toContain("(convert");
    });

    it("preserves the legacy (convert N) spelling", () => {
        const output = round_trip("(convert 2)");

        expect(output).toContain("(convert 2)");
        expect(output).not.toContain("(body_style");
    });

    it("writes no body-style token when the file declared none", () => {
        const output = round_trip("");

        expect(output).not.toContain("(body_style");
        expect(output).not.toContain("(convert");
    });

    it("keeps the token stable across a second round-trip", () => {
        const once = round_trip("(body_style 2)");
        const twice = parser.save(parser.parse(once));

        // Scoped to the body-style line rather than the whole document: the
        // serializer is not yet byte-stable across two round-trips for an
        // unrelated reason. `fields_autoplaced` is parsed as a bare atom but
        // written as a pair, so an absent flag comes back `(fields_autoplaced
        // no)` and reparses as *true*. Tracked separately; asserting whole-file
        // equality here would tie this test to that bug.
        const line = (text: string) =>
            text
                .split("\n")
                .find((l) => l.includes("body_style"))
                ?.trim();

        expect(line(once)).toBe("(body_style 2)");
        expect(line(twice)).toBe("(body_style 2)");
    });
});

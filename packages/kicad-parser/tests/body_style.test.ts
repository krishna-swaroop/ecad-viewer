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

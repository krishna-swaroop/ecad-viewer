import { parseEffects } from "../src/common";

describe("common KiCad parser", () => {
    it("preserves an explicit schematic text font color", () => {
        const effects = parseEffects(`
            (effects
                (font
                    (size 7.62 7.62)
                    (thickness 1.524)
                    (bold yes)
                    (italic yes)
                    (color 255 0 0 1)
                )
            )
        `);

        expect(effects.font.color).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    });

    it("captures an embedded hyperlink on text effects", () => {
        const effects = parseEffects(`
            (effects
                (font (size 1.27 1.27) (color 255 0 0 1))
                (justify left bottom)
                (href "https://example.com/datasheet.pdf")
            )
        `);

        expect(effects.href).toBe("https://example.com/datasheet.pdf");
    });

    it("omits href when the font has no hyperlink", () => {
        const effects = parseEffects(`
            (effects (font (size 1.27 1.27)))
        `);

        expect(effects.href).toBeUndefined();
    });
});

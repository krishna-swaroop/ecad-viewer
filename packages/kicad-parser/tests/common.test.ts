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
});

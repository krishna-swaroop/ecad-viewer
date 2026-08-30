import { expect } from "@esm-bundle/chai";

import { Angle, Vec2 } from "../src/base/math";
import { TextStyle } from "../src/kicad/text/font";
import type { StrokeGlyph } from "../src/kicad/text/glyph";
import { StrokeFont } from "../src/kicad/text/stroke-font";

/**
 * get_text_as_glyphs shapes each distinct text once at the origin and
 * translates the cached result into place, instead of shaping it again at
 * every position it is painted at.
 *
 * That is only sound because translation commutes with the mirror and
 * rotation _shape_text applies about `origin` -- and it does, but only for
 * the painted strokes, which are already mirrored and rotated. A glyph's own
 * bbox is left in unrotated space, so it tracks the plain position instead,
 * and a tab measures its stop from the absolute cursor, so tabbed text cannot
 * be translated at all.
 *
 * These compare the cached path against _shape_text called directly at the
 * real position, which is what the code did before the cache existed.
 */

type Shaped = ReturnType<StrokeFont["get_text_as_glyphs"]>;

/** Calls the uncached shaper the cache is supposed to be equivalent to. */
function shape_directly(
    font: StrokeFont,
    ...args: Parameters<StrokeFont["get_text_as_glyphs"]>
): Shaped {
    return (
        font as unknown as { _shape_text: StrokeFont["get_text_as_glyphs"] }
    )._shape_text(...args);
}

function style_of(mods: Partial<TextStyle> = {}): TextStyle {
    const style = new TextStyle();
    Object.assign(style, mods);
    return style;
}

function expect_same_shaping(label: string, cached: Shaped, direct: Shaped) {
    const cached_glyphs = cached.glyphs as StrokeGlyph[];
    const direct_glyphs = direct.glyphs as StrokeGlyph[];

    expect(cached_glyphs.length, `${label}: glyph count`).to.equal(
        direct_glyphs.length,
    );

    for (let g = 0; g < cached_glyphs.length; g++) {
        const a = cached_glyphs[g]!;
        const b = direct_glyphs[g]!;

        for (const k of ["x", "y", "w", "h"] as const) {
            expect(a.bbox[k], `${label}: glyph ${g} bbox.${k}`).to.be.closeTo(
                b.bbox[k],
                1e-6,
            );
        }

        expect(a.strokes.length, `${label}: glyph ${g} stroke count`).to.equal(
            b.strokes.length,
        );

        for (let s = 0; s < a.strokes.length; s++) {
            const a_pts = a.strokes[s]!;
            const b_pts = b.strokes[s]!;
            expect(
                a_pts.length,
                `${label}: glyph ${g} stroke ${s} points`,
            ).to.equal(b_pts.length);

            for (let p = 0; p < a_pts.length; p++) {
                expect(
                    a_pts[p]!.x,
                    `${label}: glyph ${g} stroke ${s} point ${p}.x`,
                ).to.be.closeTo(b_pts[p]!.x, 1e-6);
                expect(
                    a_pts[p]!.y,
                    `${label}: glyph ${g} stroke ${s} point ${p}.y`,
                ).to.be.closeTo(b_pts[p]!.y, 1e-6);
            }
        }
    }

    for (const k of ["x", "y", "w", "h"] as const) {
        expect(cached.bbox[k], `${label}: bbox.${k}`).to.be.closeTo(
            direct.bbox[k],
            1e-6,
        );
    }
    expect(cached.cursor.x, `${label}: cursor.x`).to.be.closeTo(
        direct.cursor.x,
        1e-6,
    );
    expect(cached.cursor.y, `${label}: cursor.y`).to.be.closeTo(
        direct.cursor.y,
        1e-6,
    );
}

suite("stroke font shaped-text cache", function () {
    test("shapes every placement the way shaping in place would", function () {
        this.timeout(120000);

        const font = StrokeFont.default();
        const size = new Vec2(1.27, 1.27);

        // Reference designators, net names, values and pin labels -- what a
        // schematic actually spends its text budget on.
        const texts = [
            "R1",
            "GND",
            "+3V3",
            "VDD_1V8_LPDDR4",
            "100nF 16V",
            "U5A",
        ];
        const positions = [
            new Vec2(0, 0),
            new Vec2(12.7, 0),
            new Vec2(0, -25.4),
            new Vec2(133.35, 88.9),
            new Vec2(-50.8, 76.2),
        ];
        // Schematic text is axis-aligned; the odd angles keep the translation
        // honest for anything that is not.
        const angles = [0, 30, 45, 90, 180, 270];
        const origins = [new Vec2(0, 0), new Vec2(133.35, 88.9)];
        const styles = [
            style_of(),
            style_of({ italic: true }),
            style_of({ overbar: true }),
            style_of({ underline: true }),
            style_of({ subscript: true }),
            style_of({ superscript: true }),
        ];

        let cases = 0;

        for (const text of texts) {
            for (const position of positions) {
                for (const degrees of angles) {
                    for (const mirror of [false, true]) {
                        for (const origin of origins) {
                            for (const style of styles) {
                                const angle = new Angle(
                                    (degrees * Math.PI) / 180,
                                );
                                const args = [
                                    text,
                                    size,
                                    position,
                                    angle,
                                    mirror,
                                    origin,
                                    style,
                                ] as const;

                                expect_same_shaping(
                                    `"${text}" at (${position.x},${position.y}) ${degrees}deg mirror=${mirror} origin=(${origin.x},${origin.y})`,
                                    font.get_text_as_glyphs(...args),
                                    shape_directly(font, ...args),
                                );
                                cases++;
                            }
                        }
                    }
                }
            }
        }

        expect(cases).to.be.greaterThan(1000);
    });

    test("puts a tab stop where shaping in place would", function () {
        const font = StrokeFont.default();
        const size = new Vec2(1.27, 1.27);

        // A tab measures its stop from the absolute cursor, so the same
        // string shapes differently depending on where it starts. Translating
        // an origin-shaped copy would drag every stop along with it.
        for (const position of [
            new Vec2(0, 0),
            new Vec2(12.7, 0),
            new Vec2(3.81, -25.4),
        ]) {
            const args = [
                "A\tB\tC",
                size,
                position,
                new Angle(0),
                false,
                new Vec2(0, 0),
                new TextStyle(),
            ] as const;

            expect_same_shaping(
                `tabbed text at (${position.x},${position.y})`,
                font.get_text_as_glyphs(...args),
                shape_directly(font, ...args),
            );
        }
    });

    test("never hands a caller the geometry it cached", function () {
        const font = StrokeFont.default();
        const args = [
            "SHARED",
            new Vec2(1.27, 1.27),
            new Vec2(0, 0),
            new Angle(0),
            false,
            new Vec2(0, 0),
            new TextStyle(),
        ] as const;

        // The font is a process-wide singleton, so anything shared here
        // outlives the caller that mutates it and corrupts every later paint.
        const first = font.get_text_as_glyphs(...args);
        const second = font.get_text_as_glyphs(...args);

        expect(first.bbox, "bbox is shared").to.not.equal(second.bbox);
        expect(first.cursor, "cursor is shared").to.not.equal(second.cursor);
        expect(first.glyphs, "glyph array is shared").to.not.equal(
            second.glyphs,
        );

        for (let i = 0; i < first.glyphs.length; i++) {
            const a = first.glyphs[i] as StrokeGlyph;
            const b = second.glyphs[i] as StrokeGlyph;
            expect(a, `glyph ${i} is shared`).to.not.equal(b);
            expect(a.bbox, `glyph ${i} bbox is shared`).to.not.equal(b.bbox);
            for (let s = 0; s < a.strokes.length; s++) {
                expect(
                    a.strokes[s],
                    `glyph ${i} stroke ${s} is shared`,
                ).to.not.equal(b.strokes[s]);
            }
        }

        // Mutating what came out must not change what comes out next.
        (first.glyphs[0] as StrokeGlyph).strokes[0]![0]!.x += 1000;
        const third = font.get_text_as_glyphs(...args);
        expect(
            (third.glyphs[0] as StrokeGlyph).strokes[0]![0]!.x,
        ).to.be.closeTo(
            (second.glyphs[0] as StrokeGlyph).strokes[0]![0]!.x,
            1e-6,
        );
    });
});

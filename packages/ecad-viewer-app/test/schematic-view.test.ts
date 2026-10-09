/**
 * Schematic insets (IN-03): each inset renders from its own sheet instance's
 * scene, never the live viewer, so a reused sheet file shows the right
 * references per instance.
 */
import { expect } from "@esm-bundle/chai";
import { SchematicParser } from "kicad-parser";

import { Vec2 } from "../src/base/math";
import { KicadSch, SchematicInstanceContext } from "../src/kicad/schematic";
import kicad_default_theme from "../src/kicanvas/themes/kicad-default";
import {
    SchematicInsetProvider,
    type InsetCamera,
    type InsetTarget,
    type SchematicInsetPage,
} from "../src/ecad-viewer/insets";

const SYMBOL_UUID = "00000000-0000-0000-0000-0000000000aa";
const INSTANCE_A = "/root/sheet-a";
const INSTANCE_B = "/root/sheet-b";

const REUSED_CHILD = `
(kicad_sch
  (version 20250114)
  (generator "eeschema")
  (uuid "00000000-0000-0000-0000-000000000001")
  (lib_symbols
    (symbol "Device:DUAL"
      (pin_numbers (hide yes))
      (pin_names (offset 0.254) (hide yes))
      (exclude_from_sim no) (in_bom yes) (on_board yes)
      (symbol "DUAL_1_1"
        (rectangle (start -1.27 -1.27) (end 1.27 1.27)
          (stroke (width 0.254) (type default)) (fill (type none)))
        (pin input line (at -5.08 0 0) (length 3.81)
          (name "A" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27)))))
      )
      (symbol "DUAL_2_1"
        (rectangle (start -2.54 -2.54) (end 2.54 2.54)
          (stroke (width 0.254) (type default)) (fill (type none)))
        (pin output line (at 5.08 0 180) (length 3.81)
          (name "B" (effects (font (size 1.27 1.27))))
          (number "2" (effects (font (size 1.27 1.27)))))
      )
    )
  )
  (symbol
    (lib_id "Device:DUAL") (at 100 100 0)
    (unit 1) (body_style 1)
    (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no)
    (uuid "${SYMBOL_UUID}")
    (property "Reference" "U7" (at 102 96 0)
      (effects (font (size 1.27 1.27))))
    (property "Value" "AUTHORED" (at 102 98 0)
      (effects (font (size 1.27 1.27))))
    (property "Footprint" "Pkg:Authored" (at 102 100 0)
      (effects (font (size 1.27 1.27)) (hide yes)))
    (property "Alias" "\${REFERENCE}-\${VALUE}-\${UNIT}" (at 102 102 0)
      (effects (font (size 1.27 1.27))))
    (pin "1" (uuid "00000000-0000-0000-0000-000000000011"))
    (pin "2" (uuid "00000000-0000-0000-0000-000000000012"))
    (instances
      (project "reuse"
        (path "${INSTANCE_A}" (reference "U51") (unit 1)
          (value "VALUE-A") (footprint "Pkg:A"))
        (path "${INSTANCE_B}" (reference "U38") (unit 2)
          (value "VALUE-B") (footprint "Pkg:B"))
      )
    )
  )
)
`;

function load_child(): KicadSch {
    return new KicadSch(
        "Subsheets/reused.kicad_sch",
        new SchematicParser().parse(REUSED_CHILD),
    );
}

function pages(child: KicadSch): SchematicInsetPage[] {
    return [
        {
            key: `reused:${INSTANCE_A}`,
            name: "Sheet A",
            document: child,
            context: new SchematicInstanceContext(child, INSTANCE_A),
        },
        {
            key: `reused:${INSTANCE_B}`,
            name: "Sheet B",
            document: child,
            context: new SchematicInstanceContext(child, INSTANCE_B),
        },
    ];
}

function provider(cap?: number) {
    const child = load_child();
    const list = pages(child);
    const container = document.createElement("div");
    document.body.append(container);
    const p = new SchematicInsetProvider(
        {
            pages: () => list,
            theme: () => kicad_default_theme.schematic,
            container: () => container,
        },
        cap,
    );
    return { p, container };
}

function canvas() {
    const c = document.createElement("canvas");
    Object.assign(c.style, {
        position: "fixed",
        left: "0px",
        top: "0px",
        width: "200px",
        height: "160px",
    });
    document.body.append(c);
    return c;
}

function camera_for(target: InsetTarget): InsetCamera {
    const f = target.focus;
    return {
        center: new Vec2(f.x + f.w / 2, f.y + f.h / 2),
        zoom: 8,
        rotation: 0,
        mirror: false,
    };
}

const pixels = (c: HTMLCanvasElement) =>
    c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;

function differing(a: Uint8ClampedArray, b: Uint8ClampedArray) {
    let n = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
    return n;
}

suite("schematic insets", () => {
    const cleanup: Array<() => void> = [];
    teardown(() => {
        while (cleanup.length) cleanup.pop()!();
    });

    function make(cap?: number) {
        const made = provider(cap);
        cleanup.push(() => {
            made.p.dispose();
            made.container.remove();
        });
        return made.p;
    }

    function surface() {
        const c = canvas();
        cleanup.push(() => c.remove());
        return c;
    }

    test("a reference resolves on its own sheet instance", async () => {
        const p = make();
        const a = (await p.resolve("U51", "1"))!;
        expect(a.kind).to.equal("sch");
        expect(a.side).to.equal("sch");
        expect(a.detail).to.equal("Sheet A");
        expect(a.mirror).to.equal(false);
        const b = (await p.resolve("U38", "2"))!;
        expect(b.detail).to.equal("Sheet B");
        expect(p.scene_keys).to.have.members([
            `reused:${INSTANCE_A}`,
            `reused:${INSTANCE_B}`,
        ]);
    });

    test("the pin anchors the leader; a pin the unit lacks falls back to the symbol", async () => {
        const p = make();
        // Instance A shows unit 1, which carries pin 1.
        const with_pin = (await p.resolve("U51", "1"))!;
        const f = with_pin.focus;
        expect(with_pin.anchor.x).to.be.lessThan(f.x + f.w / 2);
        // Unit 1 has no pin 2: anchor at the symbol centre.
        const without = (await p.resolve("U51", "2"))!;
        const g = without.focus;
        expect(without.anchor.x).to.be.closeTo(g.x + g.w / 2, 1e-6);
        expect(without.anchor.y).to.be.closeTo(g.y + g.h / 2, 1e-6);
    });

    test("pins inside a schematic inset are hit-tested with instance references", async () => {
        const p = make();
        const b = (await p.resolve("U38", "2"))!;
        expect(b.anchor_box).to.not.equal(undefined);
        const hit = p.hit_test(b, b.anchor)!;
        expect(hit.reference).to.equal("U38");
        expect(hit.number).to.equal("2");
        expect(p.hit_test(b, new Vec2(-500, -500))).to.equal(null);
    });

    test("a variant change reaches every scene and its listeners", async () => {
        const p = make();
        await p.resolve("U51", "1");
        await p.resolve("U38", "2");
        let heard = 0;
        p.subscribe(() => heard++);
        p.set_variant("Lite");
        expect(heard).to.equal(1);
        expect(p.scene_variants).to.deep.equal(["Lite", "Lite"]);
        p.set_variant(null);
        expect(p.scene_variants).to.deep.equal([null, null]);
    });

    test("an unknown reference resolves to null and holds no scene", async () => {
        const p = make();
        expect(await p.resolve("U99", "1")).to.equal(null);
        expect(p.scene_keys).to.deep.equal([]);
    });

    test("each inset keeps its own instance's scene", async () => {
        const p = make();
        const a = (await p.resolve("U51", "1"))!;
        const b = (await p.resolve("U38", "2"))!;
        const ca = surface();
        const cb = surface();
        p.render(a, camera_for(a), ca);
        const first_a = pixels(ca).slice();
        p.render(b, camera_for(a), cb);
        // Same file, same camera, different instance: references differ.
        expect(differing(first_a, pixels(cb))).to.be.greaterThan(0);
        // Rendering B did not disturb A.
        p.render(a, camera_for(a), ca);
        expect(differing(first_a, pixels(ca))).to.equal(0);
    });

    test("open insets pin their scenes; idle ones are evicted beyond the cap", async () => {
        const p = make(1);
        const a = (await p.resolve("U51", "1"))!;
        const b = (await p.resolve("U38", "2"))!;
        // Both in use: kept even over the cap.
        expect(p.scene_keys).to.have.length(2);
        p.release(a);
        expect(p.scene_keys).to.deep.equal([`reused:${INSTANCE_B}`]);
        p.release(b);
        expect(p.scene_keys).to.deep.equal([`reused:${INSTANCE_B}`]);
        await p.resolve("U51", "1");
        expect(p.scene_keys).to.deep.equal([`reused:${INSTANCE_A}`]);
    });

    test("rendering a released target draws nothing and does not throw", async () => {
        const p = make(0);
        const a = (await p.resolve("U51", "1"))!;
        p.release(a);
        const c = surface();
        p.render(a, camera_for(a), c);
        expect(c.width).to.equal(300);
    });

    test("a live schematic viewer is never used", async () => {
        const p = make();
        const a = (await p.resolve("U51", "1"))!;
        const c = surface();
        p.render(a, camera_for(a), c);
        // Only the provider's own hidden scene canvases exist.
        expect(p.scene_keys).to.deep.equal([`reused:${INSTANCE_A}`]);
    });
});

import { expect } from "@esm-bundle/chai";
import { SchematicParser } from "kicad-parser";

import { Vec2 } from "../src/base/math";
import { item_hyperlink, KicadSch, Label, Text } from "../src/kicad/schematic";
import kicad_default_theme from "../src/kicanvas/themes/kicad-default";
import { LayerNames } from "../src/viewers/schematic/layers";
import {
    KiCanvasSelectEvent,
    LinkClickEvent,
} from "../src/viewers/base/events";
import { SchematicViewer } from "../src/viewers/schematic/viewer";

/**
 * Clicking KiCad's embedded hyperlinks.
 *
 * KiCad authors hyperlinks as `(href "...")` on a text item's effects. The
 * item under a click has to resolve to that link, the click has to follow it
 * rather than select the item, and the pointer cursor advertises the target.
 * These cover all three on whole schematics, plus a project-relative file
 * link (an "open the referenced schematic" link).
 */

const SCH = `
(kicad_sch
  (version 20250114)
  (generator "eeschema")
  (uuid "00000000-0000-0000-0000-000000000001")
  (paper "A4")
  (text "Design notes" (exclude_from_sim no) (at 100 100 0)
    (effects (font (size 1.27 1.27)) (href "../overview/design.kicad_sch"))
    (uuid "00000000-0000-0000-0000-0000000000e1"))
  (text "Plain note" (exclude_from_sim no) (at 100 130 0)
    (effects (font (size 1.27 1.27)))
    (uuid "00000000-0000-0000-0000-0000000000e2"))
  (label "SPEC" (at 160 80 0)
    (effects (font (size 1.27 1.27)) (href "https://example.com/spec"))
    (uuid "00000000-0000-0000-0000-0000000000e3"))
  (label "NET" (at 160 110 0)
    (effects (font (size 1.27 1.27)))
    (uuid "00000000-0000-0000-0000-0000000000e4"))
)
`;

const WITH_LINKED_FIELD = `
(kicad_sch
  (version 20250114)
  (generator "eeschema")
  (uuid "00000000-0000-0000-0000-000000000001")
  (paper "A4")
  (lib_symbols
    (symbol "Device:R"
      (symbol "R_0_1"
        (rectangle (start -1.016 -2.54) (end 1.016 2.54)
          (stroke (width 0.254) (type default)) (fill (type none))))
      (symbol "R_1_1"
        (pin passive line (at 0 3.81 270) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27)))))
        (pin passive line (at 0 -3.81 90) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "2" (effects (font (size 1.27 1.27))))))))
  (symbol (lib_id "Device:R") (at 100 100 0) (unit 1)
    (uuid "00000000-0000-0000-0000-0000000000f1")
    (property "Reference" "R1" (at 103 99 0) (effects (font (size 1.27 1.27))))
    (property "Datasheet" "https://example.com/ds/R"
      (at 90 118 0)
      (effects (font (size 1.27 1.27)) (href "https://example.com/ds/R")))
    (pin "1" (uuid "00000000-0000-0000-0000-0000000000f2"))
    (pin "2" (uuid "00000000-0000-0000-0000-0000000000f3")))
)
`;

function load(fixture: string) {
    return new KicadSch(
        "links.kicad_sch",
        new SchematicParser().parse(fixture),
    );
}

suite("embedded schematic hyperlinks", () => {
    let viewer: SchematicViewer;
    let sch: KicadSch;
    let canvas: HTMLCanvasElement;

    setup(async () => {
        sch = load(SCH);
        canvas = document.createElement("canvas");
        canvas.style.width = "800px";
        canvas.style.height = "600px";
        document.body.append(canvas);
        viewer = new SchematicViewer(
            canvas,
            true,
            kicad_default_theme.schematic,
        );
        await viewer.setup();
        await viewer.load(sch);
    });

    teardown(() => {
        viewer.dispose();
        canvas.remove();
    });

    const link_target = (item: unknown) => {
        const [bbox] = viewer.layers.query_item_bboxes(item);
        if (!bbox) throw new Error("item was not painted");
        return bbox.center.copy();
    };

    const item_by_text = <T>(ctor: new () => T, text: string) => {
        for (const item of sch.items()) {
            if (item instanceof ctor && item.text === text) return item;
        }
        throw new Error(`no ${ctor.name} with text ${text}`);
    };

    test("free text exposes the hyperlink it was authored with", () => {
        const linked = item_by_text(Text, "Design notes");
        expect(item_hyperlink(linked)).to.equal("../overview/design.kicad_sch");
        expect(item_hyperlink(item_by_text(Text, "Plain note"))).to.be
            .undefined;

        expect(item_hyperlink(item_by_text(Label, "SPEC"))).to.equal(
            "https://example.com/spec",
        );
        expect(item_hyperlink(item_by_text(Label, "NET"))).to.be.undefined;
    });

    test("hyperlinked free text is painted on the interactive layer", () => {
        const linked = item_by_text(Text, "Design notes");
        const interactive = viewer.layers
            .by_name(LayerNames.interactive)!
            .bboxes.get(linked);
        expect(interactive).to.not.equal(undefined);

        // The link's click target is its painted text box, not something
        // far away.
        expect(interactive!.w).to.be.greaterThan(0);

        const plain = item_by_text(Text, "Plain note");
        expect(
            viewer.layers.by_name(LayerNames.interactive)!.bboxes.get(plain),
        ).to.equal(undefined);
    });

    test("clicking hyperlinked text fires LinkClickEvent instead of selecting", () => {
        const linked = item_by_text(Text, "Design notes");
        const center = link_target(linked);

        let link_url: string | undefined;
        viewer.addEventListener(LinkClickEvent.type, (e) => {
            link_url = e.detail;
        });
        let selected: unknown = "unset";
        viewer.addEventListener(KiCanvasSelectEvent.type, (e) => {
            selected = e.detail.item;
        });

        viewer.on_click(center);

        expect(link_url).to.equal("../overview/design.kicad_sch");
        // Following the link and selecting the item are mutually exclusive:
        // the click is consumed by the link.
        expect(selected).to.equal("unset");
    });

    test("clicking a hyperlinked label also follows the link", () => {
        const label = item_by_text(Label, "SPEC");
        const center = link_target(label);

        let link_url: string | undefined;
        viewer.addEventListener(LinkClickEvent.type, (e) => {
            link_url = e.detail;
        });

        viewer.on_click(center);
        expect(link_url).to.equal("https://example.com/spec");
    });

    test("clicking plain text does not follow a link", () => {
        const plain = item_by_text(Text, "Plain note");
        const center = link_target(plain);

        let link_url: string | undefined;
        viewer.addEventListener(LinkClickEvent.type, (e) => {
            link_url = e.detail;
        });

        // Plain free text is not a click target, so the click resolves to
        // the background just like it did before hyperlinks existed.
        viewer.on_click(center);
        expect(link_url).to.equal(undefined);
        expect(viewer.find_item(center).item).to.equal(null);
    });

    test("hovering a link sets the pointer cursor and clears it elsewhere", () => {
        const linked = item_by_text(Text, "Design notes");
        const center = link_target(linked);

        viewer.on_hover(center);
        expect(canvas.style.cursor).to.equal("pointer");

        viewer.on_hover(new Vec2(center.x + 300, center.y + 300));
        expect(canvas.style.cursor).to.equal("");
    });

    test("a visible linked field is a click target", async () => {
        viewer.dispose();
        canvas.remove();

        const field_sch = load(WITH_LINKED_FIELD);
        const field_canvas = document.createElement("canvas");
        field_canvas.style.width = "800px";
        field_canvas.style.height = "600px";
        document.body.append(field_canvas);
        viewer = new SchematicViewer(
            field_canvas,
            true,
            kicad_default_theme.schematic,
        );
        await viewer.setup();
        await viewer.load(field_sch);

        const symbol = field_sch.symbols.values().next().value!;
        const datasheet = [...symbol.properties.values()].find(
            (p) => p.name === "Datasheet",
        )!;
        expect(item_hyperlink(datasheet)).to.equal("https://example.com/ds/R");

        const [bbox] = viewer.layers.query_item_bboxes(datasheet);
        expect(bbox, "datasheet field is painted and pickable").to.exist;

        let link_url: string | undefined;
        viewer.addEventListener(LinkClickEvent.type, (e) => {
            link_url = e.detail;
        });

        viewer.on_click(bbox!.center.copy());
        expect(link_url).to.equal("https://example.com/ds/R");
    });
});

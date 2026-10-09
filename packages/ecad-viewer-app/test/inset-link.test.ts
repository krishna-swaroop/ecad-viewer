/**
 * Insets wired to viewers and elements (IN-04): probe events carry the
 * designator and anchor, a hover opens a preview of the other document, and
 * two <ecad-viewer> elements linked with setInsetPeer serve each other.
 */
import { expect } from "@esm-bundle/chai";

import "../build/ecad-viewer.js";

import { BBox, Vec2 } from "../src/base/math";
import {
    HOVER_CLOSE_DELAY_MS,
    HOVER_OPEN_DELAY_MS,
    InsetLink,
    type InsetKind,
    type InsetProvider,
    type InsetTarget,
} from "../src/ecad-viewer/insets";
import {
    KiCanvasProbeEvent,
    type KiCanvasProbeDetail,
} from "../src/viewers/base/events";
import type { Viewer } from "../src/viewers/base/viewer";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- InsetLink with fakes ---------------------------------------------------

class FakeViewer extends EventTarget {
    canvas = document.createElement("canvas");
    viewport = {
        camera: { world_to_screen: (p: Vec2) => new Vec2(p.x * 2, p.y * 2) },
    };

    constructor() {
        super();
        Object.assign(this.canvas.style, {
            position: "fixed",
            left: "10px",
            top: "20px",
            width: "600px",
            height: "400px",
        });
        document.body.append(this.canvas);
    }

    override addEventListener(type: string, listener: EventListener) {
        super.addEventListener(type, listener);
        return { dispose: () => super.removeEventListener(type, listener) };
    }

    probe(detail: KiCanvasProbeDetail) {
        this.dispatchEvent(new KiCanvasProbeEvent(detail));
    }
}

function provider(kind: InsetKind, known: string[]): InsetProvider {
    return {
        kind,
        async resolve(reference: string, number: string) {
            if (!known.includes(reference)) return null;
            const target: InsetTarget = {
                kind,
                reference,
                number,
                side: kind === "pcb" ? "top" : "sch",
                focus: new BBox(0, 0, 10, 10),
                anchor: new Vec2(5, 5),
                mirror: false,
            };
            return target;
        },
        render() {},
    };
}

const hover = (reference: string, number = "1"): KiCanvasProbeDetail => ({
    phase: "hover",
    source: "pin",
    number,
    index: `symbol_pin_${number}`,
    crossIndex: `pad_${number}`,
    reference,
    anchor: { x: 30, y: 40 },
});

suite("inset link", () => {
    let overlay: HTMLDivElement;
    let viewer: FakeViewer;
    let link: InsetLink;
    let modes: boolean[];

    setup(() => {
        overlay = document.createElement("div");
        Object.assign(overlay.style, {
            position: "fixed",
            left: "0px",
            top: "0px",
            width: "1200px",
            height: "800px",
        });
        document.body.append(overlay);
        viewer = new FakeViewer();
        const own = provider("sch", ["R1"]);
        link = new InsetLink({
            insetProvider: (kind) => (kind === "sch" ? own : null),
            overlay_parent: () => overlay,
            source_viewers: () => ({ sch: viewer as unknown as Viewer }),
            mode_changed: (on) => modes.push(on),
        });
        const pcb = provider("pcb", ["R1", "U1"]);
        modes = [];
        link.peer = {
            insetProvider: (kind) => (kind === "pcb" ? pcb : null),
        };
        link.set_mode(true, true);
    });

    teardown(() => {
        link.dispose();
        viewer.canvas.remove();
        overlay.remove();
    });

    test("a pin hover opens a PCB preview after the delay", async () => {
        viewer.probe(hover("U1"));
        expect(link.session.count).to.equal(0);
        await wait(HOVER_OPEN_DELAY_MS + 50);
        expect(link.session.count).to.equal(1);
        const inset = link.session.preview!;
        expect(inset.target.kind).to.equal("pcb");
        expect(inset.target.reference).to.equal("U1");
        // The leader starts at the pin, through the source viewer's camera.
        link.session.flush();
        const d = inset.leader.getAttribute("d")!;
        expect(d.startsWith("M70,100 ")).to.equal(true);
    });

    test("virtual symbols (#PWR, #FLG) open nothing", async () => {
        viewer.probe(hover("#PWR01"));
        await wait(HOVER_OPEN_DELAY_MS + 50);
        expect(link.session.count).to.equal(0);
    });

    test("leaving the pin closes the preview unless the pointer is on it", async () => {
        viewer.probe(hover("U1"));
        await wait(HOVER_OPEN_DELAY_MS + 50);
        viewer.probe({ ...hover("U1"), phase: "leave" } as KiCanvasProbeDetail);
        await wait(HOVER_CLOSE_DELAY_MS + 50);
        expect(link.session.count).to.equal(0);
    });

    test("a quick pass over a pin opens nothing", async () => {
        viewer.probe(hover("U1"));
        viewer.probe({ ...hover("U1"), phase: "leave" } as KiCanvasProbeDetail);
        await wait(HOVER_OPEN_DELAY_MS + 50);
        expect(link.session.count).to.equal(0);
    });

    test("a designator missing from the board opens a header-only inset", async () => {
        viewer.probe(hover("J7", "3"));
        await wait(HOVER_OPEN_DELAY_MS + 50);
        const inset = link.session.preview!;
        expect(inset.missing).to.equal(true);
        expect(inset.panel.el.classList.contains("missing")).to.equal(true);
        link.session.flush();
        expect(inset.leader.style.display).to.equal("none");
    });

    test("without a peer, hovers do nothing", async () => {
        link.peer = null;
        viewer.probe(hover("U1"));
        await wait(HOVER_OPEN_DELAY_MS + 50);
        expect(link.session.count).to.equal(0);
    });

    test("unlinking closes open insets", async () => {
        viewer.probe(hover("U1"));
        await wait(HOVER_OPEN_DELAY_MS + 50);
        link.peer = null;
        expect(link.session.count).to.equal(0);
    });
    const key = (key: string, init: KeyboardEventInit = {}) =>
        new KeyboardEvent("keydown", { key, ...init });
    const click = () =>
        (viewer as unknown as Viewer).click_interceptor!(
            new MouseEvent("click"),
        );

    test("with the mode off, a hover opens nothing", async () => {
        link.set_mode(false, true);
        viewer.probe(hover("U1"));
        await wait(HOVER_OPEN_DELAY_MS + 50);
        expect(link.session.count).to.equal(0);
        expect(click()).to.equal(false);
    });

    test("I toggles the mode and tells the host; modifiers are ignored", () => {
        link.set_mode(false, true);
        expect(link.key_down(key("i"))).to.equal(true);
        expect(link.mode).to.equal(true);
        expect(link.key_down(key("I", { ctrlKey: true }))).to.equal(false);
        expect(link.key_down(key("i", { metaKey: true }))).to.equal(false);
        expect(link.key_down(key("i"))).to.equal(true);
        expect(link.mode).to.equal(false);
        expect(modes).to.deep.equal([true, false]);
        // No peer yet (the host loads the other document lazily): I still
        // toggles, so the host can react to the mode.
        link.peer = null;
        expect(link.key_down(key("i"))).to.equal(true);
        expect(link.mode).to.equal(true);
    });

    test("a provider still loading opens nothing rather than 'not on board'", async () => {
        const loading: InsetProvider = {
            ...provider("pcb", []),
            ready: () => false,
        };
        link.peer = {
            insetProvider: (kind) => (kind === "pcb" ? loading : null),
        };
        viewer.probe(hover("U1"));
        await wait(HOVER_OPEN_DELAY_MS + 50);
        expect(link.session.count).to.equal(0);
    });

    test("linking to a peer already in inset mode joins it", () => {
        link.set_mode(false, true);
        link.peer = {
            insetProvider: () => null,
            insetMode: true,
        };
        expect(link.mode).to.equal(true);
    });

    test("holding Alt peeks: it opens at once and closes on release", async () => {
        link.set_mode(false, true);
        viewer.probe(hover("U1"));
        link.key_down(key("Alt"));
        await wait(20);
        expect(link.peeking).to.equal(true);
        expect(link.session.count).to.equal(1);
        link.key_up(new KeyboardEvent("keyup", { key: "Alt" }));
        expect(link.session.count).to.equal(0);
    });

    test("a peek pinned before Alt is released stays", async () => {
        link.set_mode(false, true);
        link.key_down(key("Alt"));
        viewer.probe(hover("U1"));
        await wait(HOVER_OPEN_DELAY_MS + 50);
        expect(click()).to.equal(true);
        link.key_up(null);
        expect(link.session.count).to.equal(1);
        expect(link.session.insets[0]!.pinned).to.equal(true);
    });

    test("turning the mode on over a pin opens at once; off closes previews only", async () => {
        link.set_mode(false, true);
        viewer.probe(hover("U1"));
        link.set_mode(true, true);
        await wait(20);
        expect(link.session.count).to.equal(1);
        link.session.pin(link.session.insets[0]!);
        viewer.probe(hover("R1"));
        await wait(HOVER_OPEN_DELAY_MS + 50);
        expect(link.session.count).to.equal(2);
        link.set_mode(false, true);
        expect(link.session.count).to.equal(1);
        expect(link.session.insets[0]!.pinned).to.equal(true);
    });

    test("a click on the hovered pin pins its preview and is consumed", async () => {
        viewer.probe(hover("U1"));
        await wait(HOVER_OPEN_DELAY_MS + 50);
        expect(click()).to.equal(true);
        expect(link.session.insets[0]!.pinned).to.equal(true);
        expect(link.session.preview).to.equal(null);
    });

    test("a click inside the hover delay opens and pins at once", async () => {
        viewer.probe(hover("U1"));
        expect(click()).to.equal(true);
        await wait(20);
        expect(link.session.count).to.equal(1);
        expect(link.session.insets[0]!.pinned).to.equal(true);
    });

    test("a click away from any pin is left to the viewer", () => {
        expect(click()).to.equal(false);
    });

    test("toolbar keys act on the inset under the pointer", async () => {
        viewer.probe(hover("U1"));
        await wait(HOVER_OPEN_DELAY_MS + 50);
        const inset = link.session.preview!;
        const press = (k: string, init: KeyboardEventInit = {}) =>
            link.key_down(new KeyboardEvent("keydown", { key: k, ...init }));
        // Nothing hovered: keys fall through.
        expect(press("r")).to.equal(false);
        inset.panel.el.dispatchEvent(new PointerEvent("pointerenter"));
        expect(link.session.hovered).to.equal(inset);
        expect(press("r")).to.equal(true);
        expect(inset.camera.rotation).to.be.closeTo(Math.PI / 12, 1e-9);
        expect(press("R", { shiftKey: true })).to.equal(true);
        expect(press("R", { shiftKey: true })).to.equal(true);
        expect(inset.camera.rotation).to.be.closeTo(-Math.PI / 12, 1e-9);
        expect(press("m")).to.equal(true);
        expect(inset.camera.mirror).to.equal(true);
        expect(press("l")).to.equal(true);
        expect(inset.panel.lens).to.equal(true);
        inset.fit();
        const fitted = inset.camera.zoom;
        inset.camera.zoom *= 5;
        expect(press("Home")).to.equal(true);
        expect(inset.camera.zoom).to.be.closeTo(fitted, 1e-9);
        expect(press("r", { ctrlKey: true })).to.equal(false);
        expect(press("m", { shiftKey: true })).to.equal(false);
        expect(press("p")).to.equal(true);
        expect(inset.pinned).to.equal(true);
        expect(press("x")).to.equal(true);
        expect(link.session.count).to.equal(0);
        expect(link.session.hovered).to.equal(null);
    });

    test("I still toggles the mode while an inset is hovered", async () => {
        viewer.probe(hover("U1"));
        await wait(HOVER_OPEN_DELAY_MS + 50);
        link.session.preview!.panel.el.dispatchEvent(
            new PointerEvent("pointerenter"),
        );
        expect(
            link.key_down(new KeyboardEvent("keydown", { key: "i" })),
        ).to.equal(true);
        expect(link.mode).to.equal(false);
    });

    test("a preview under the pointer survives leaving its pin", async () => {
        viewer.probe(hover("U1"));
        await wait(HOVER_OPEN_DELAY_MS + 50);
        const inset = link.session.preview!;
        inset.panel.el.dispatchEvent(new PointerEvent("pointerenter"));
        viewer.probe({ ...hover("U1"), phase: "leave" } as KiCanvasProbeDetail);
        await wait(HOVER_CLOSE_DELAY_MS + 50);
        expect(link.session.count).to.equal(1);
        inset.panel.el.dispatchEvent(new PointerEvent("pointerleave"));
        expect(link.session.hovered).to.equal(null);
    });

    test("toolbar buttons show a styled tooltip with their key", async () => {
        viewer.probe(hover("U1"));
        await wait(HOVER_OPEN_DELAY_MS + 50);
        const inset = link.session.preview!;
        const tip = (action: Parameters<typeof inset.panel.button>[0]) => {
            const t = inset.panel.button(action).querySelector(".inset-tip")!;
            return [
                t.firstChild!.textContent,
                t.querySelector("kbd")!.textContent,
            ];
        };
        expect(tip("rotate-cw")).to.deep.equal(["Rotate +15°", "R"]);
        expect(tip("rotate-ccw")).to.deep.equal(["Rotate −15°", "⇧R"]);
        expect(tip("close")).to.deep.equal(["Close", "X"]);
        // No second, native tooltip; the accessible name stays the label.
        expect(inset.panel.button("close").title).to.equal("");
        expect(inset.panel.button("close").getAttribute("aria-label")).to.equal(
            "Close",
        );
    });
});

// --- Two real elements --------------------------------------------------------

const ROOT_UUID = "00000000-0000-0000-0000-00000000r001";

const SCHEMATIC = `
(kicad_sch
  (version 20250114)
  (generator "eeschema")
  (uuid "${ROOT_UUID}")
  (paper "A4")
  (lib_symbols
    (symbol "Device:R"
      (pin_numbers (hide yes))
      (exclude_from_sim no) (in_bom yes) (on_board yes)
      (property "Reference" "R" (at 2 0 90) (effects (font (size 1.27 1.27))))
      (symbol "R_0_1"
        (rectangle (start -1.016 -2.54) (end 1.016 2.54)
          (stroke (width 0.254) (type default)) (fill (type none))))
      (symbol "R_1_1"
        (pin passive line (at 0 3.81 270) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27)))))
        (pin passive line (at 0 -3.81 90) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "2" (effects (font (size 1.27 1.27)))))
      )
    )
  )
  (symbol
    (lib_id "Device:R") (at 100 100 0) (unit 1)
    (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no)
    (uuid "00000000-0000-0000-0000-0000000000r1")
    (property "Reference" "R1" (at 103 100 0) (effects (font (size 1.27 1.27))))
    (property "Value" "10k" (at 105 100 0) (effects (font (size 1.27 1.27))))
    (pin "1" (uuid "00000000-0000-0000-0000-0000000000p1"))
    (pin "2" (uuid "00000000-0000-0000-0000-0000000000p2"))
    (instances (project "insets" (path "/${ROOT_UUID}" (reference "R1") (unit 1))))
  )
)
`;

const BOARD = `
(kicad_pcb
  (version 20240108)
  (generator "pcbnew")
  (paper "A4")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (net 0 "")
  (net 1 "VBUS")
  (net 2 "GND")
  (gr_rect (start 0 0) (end 40 30) (layer "Edge.Cuts") (width 0.1))
  (footprint "R_0805" (layer "F.Cu") (at 10 10) (uuid "fp-r1")
    (property "Reference" "R1" (at 0 -2 0) (layer "F.SilkS") (uuid "r1-ref") (effects (font (size 1 1) (thickness 0.15))))
    (pad "1" smd rect (at -1 0) (size 1.2 1.2) (layers "F.Cu" "F.Paste" "F.Mask") (net 1 "VBUS") (uuid "r1-1"))
    (pad "2" smd rect (at 1 0) (size 1.2 1.2) (layers "F.Cu" "F.Paste" "F.Mask") (net 2 "GND") (uuid "r1-2"))
  )
  (footprint "C_0805" (layer "B.Cu") (at 30 20) (uuid "fp-c1")
    (property "Reference" "C1" (at 0 -2 0) (layer "B.SilkS") (uuid "c1-ref") (effects (font (size 1 1) (thickness 0.15))))
    (pad "1" smd rect (at -1 0) (size 1.2 1.2) (layers "B.Cu" "B.Paste" "B.Mask") (net 1 "VBUS") (uuid "c1-1"))
  )
)
`;

type Host = HTMLElement & {
    replaceSources(update: {
        revisionKey: string;
        sources: Array<{ filename: string; content: string }>;
    }): Promise<void>;
    setInsetPeer(peer: unknown): void;
    setInsetMode(on: boolean): void;
    enableInsets(): void;
    escapeInsets(): boolean;
    readonly insetMode: boolean;
    closeInsets(): boolean;
    readonly insetCount: number;
};

type AnyViewer = EventTarget & {
    canvas: HTMLCanvasElement;
    on_hover(pos: Vec2): void;
    on_pointer_leave?: () => void;
    layers: { query_item_bboxes(item: unknown): Iterator<BBox> };
    schematic?: {
        symbols: Map<string, { pins: Array<{ number: string }> }>;
    };
    board?: {
        footprints: Array<{
            reference: string;
            pad_by_number(n: string): { bbox: BBox };
        }>;
    };
};

async function mount(filename: string, content: string): Promise<Host> {
    const host = document.createElement("ecad-viewer") as Host;
    host.setAttribute("source-mode", "host");
    Object.assign(host.style, {
        position: "fixed",
        left: "0px",
        top: "0px",
        width: "900px",
        height: "600px",
    });
    document.body.append(host);
    await host.replaceSources({
        revisionKey: "r1",
        sources: [{ filename, content }],
    });
    return host;
}

function inner(host: Host, tag: string): AnyViewer {
    const app = host.shadowRoot!.querySelector(tag) as
        | (HTMLElement & { viewer?: AnyViewer })
        | null;
    expect(app?.viewer, tag).to.exist;
    return app!.viewer!;
}

const centre = (b: BBox) => new Vec2(b.x + b.w / 2, b.y + b.h / 2);

suite("inset elements", () => {
    let sch: Host;
    let pcb: Host;

    setup(async () => {
        sch = await mount("insets.kicad_sch", SCHEMATIC);
        pcb = await mount("insets.kicad_pcb", BOARD);
        sch.setInsetPeer(pcb);
        pcb.setInsetPeer(sch);
        sch.setInsetMode(true);
    });

    teardown(() => {
        sch.setInsetPeer(null);
        pcb.setInsetPeer(null);
        sch.remove();
        pcb.remove();
    });

    const titles = (host: Host) =>
        [...host.shadowRoot!.querySelectorAll(".inset-title")].map(
            (el) => el.textContent,
        );
    const sides = (host: Host) =>
        [...host.shadowRoot!.querySelectorAll(".inset-side")].map(
            (el) => el.textContent,
        );

    test("hovering a schematic pin opens the PCB around its footprint", async () => {
        const viewer = inner(sch, "kc-schematic-app");
        const symbol = [...viewer.schematic!.symbols.values()][0]!;
        const pin = symbol.pins.find((p) => p.number === "1")!;
        const box = viewer.layers.query_item_bboxes(pin).next().value as BBox;
        viewer.on_hover(centre(box));
        await wait(HOVER_OPEN_DELAY_MS + 100);
        expect(sch.insetCount).to.equal(1);
        expect(titles(sch)).to.deep.equal(["R1 · 1 · VBUS"]);
        expect(sides(sch)).to.deep.equal(["TOP"]);
        expect(pcb.insetCount).to.equal(0);
    });

    test("hovering a PCB pad opens the schematic around its symbol", async () => {
        const viewer = inner(pcb, "kc-board-app");
        const fp = viewer.board!.footprints.find((f) => f.reference === "R1")!;
        viewer.on_hover(centre(fp.pad_by_number("2").bbox));
        await wait(HOVER_OPEN_DELAY_MS + 100);
        expect(pcb.insetCount).to.equal(1);
        expect(sides(pcb)).to.deep.equal(["SCH"]);
        expect(titles(pcb)[0]).to.match(/^R1 · 2/);
    });

    test("a footprint with no symbol opens the header-only inset", async () => {
        const viewer = inner(pcb, "kc-board-app");
        const fp = viewer.board!.footprints.find((f) => f.reference === "C1")!;
        viewer.on_hover(centre(fp.pad_by_number("1").bbox));
        await wait(HOVER_OPEN_DELAY_MS + 100);
        expect(pcb.insetCount).to.equal(1);
        expect(pcb.shadowRoot!.querySelector(".inset.missing")).to.not.equal(
            null,
        );
        expect(sides(pcb)).to.deep.equal(["—"]);
    });

    test("closeInsets reports whether anything closed", async () => {
        expect(sch.closeInsets()).to.equal(false);
        const viewer = inner(sch, "kc-schematic-app");
        const symbol = [...viewer.schematic!.symbols.values()][0]!;
        const pin = symbol.pins.find((p) => p.number === "1")!;
        const box = viewer.layers.query_item_bboxes(pin).next().value as BBox;
        viewer.on_hover(centre(box));
        await wait(HOVER_OPEN_DELAY_MS + 100);
        expect(sch.closeInsets()).to.equal(true);
        expect(sch.insetCount).to.equal(0);
    });
    const hover_r1_pin = () => {
        const viewer = inner(sch, "kc-schematic-app");
        const symbol = [...viewer.schematic!.symbols.values()][0]!;
        const pin = symbol.pins.find((p) => p.number === "1")!;
        const box = viewer.layers.query_item_bboxes(pin).next().value as BBox;
        viewer.on_hover(centre(box));
        return viewer;
    };

    test("setInsetMode on one element is mirrored on its peer", () => {
        expect(sch.insetMode).to.equal(true);
        expect(pcb.insetMode).to.equal(true);
        pcb.setInsetMode(false);
        expect(sch.insetMode).to.equal(false);
    });

    test("one press of I toggles the mode once for both elements", () => {
        const seen: boolean[] = [];
        sch.addEventListener("ecad-viewer:inset-mode", (e) =>
            seen.push((e as CustomEvent<{ on: boolean }>).detail.on),
        );
        // Both elements listen on window; the first to handle the key marks
        // it handled, so the second does not toggle it back.
        const event = new KeyboardEvent("keydown", {
            key: "i",
            cancelable: true,
        });
        window.dispatchEvent(event);
        expect(event.defaultPrevented).to.equal(true);
        expect(sch.insetMode).to.equal(false);
        expect(pcb.insetMode).to.equal(false);
        expect(seen).to.deep.equal([false]);
    });

    test("I typed into an input is ignored", () => {
        const input = document.createElement("input");
        document.body.append(input);
        input.focus();
        input.dispatchEvent(
            new KeyboardEvent("keydown", {
                key: "i",
                bubbles: true,
                composed: true,
            }),
        );
        input.remove();
        expect(sch.insetMode).to.equal(true);
    });

    test("in inset mode a click on the hovered pin pins it instead of selecting", async () => {
        const viewer = hover_r1_pin();
        await wait(HOVER_OPEN_DELAY_MS + 100);
        let selects = 0;
        viewer.addEventListener("kicanvas:select", () => selects++);
        viewer.canvas.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        expect(selects).to.equal(0);
        expect(sch.insetCount).to.equal(1);
        expect(sch.shadowRoot!.querySelector(".inset.preview")).to.equal(null);
    });
});

suite("inset elements before a peer", () => {
    test("enableInsets lets I toggle the mode with no peer; linking keeps it", async () => {
        const sch = await mount("solo.kicad_sch", SCHEMATIC);
        const seen: boolean[] = [];
        sch.addEventListener("ecad-viewer:inset-mode", (e) =>
            seen.push((e as CustomEvent<{ on: boolean }>).detail.on),
        );
        try {
            sch.enableInsets();
            window.dispatchEvent(
                new KeyboardEvent("keydown", { key: "i", cancelable: true }),
            );
            expect(sch.insetMode).to.equal(true);
            expect(seen).to.deep.equal([true]);
            const pcb = await mount("solo.kicad_pcb", BOARD);
            try {
                pcb.setInsetPeer(sch);
                sch.setInsetPeer(pcb);
                expect(pcb.insetMode).to.equal(true);
                expect(sch.insetMode).to.equal(true);
            } finally {
                pcb.setInsetPeer(null);
                pcb.remove();
            }
        } finally {
            sch.setInsetPeer(null);
            sch.remove();
        }
    });

    test("escapeInsets closes the preview first, then everything", async () => {
        const sch = await mount("esc.kicad_sch", SCHEMATIC);
        const pcb = await mount("esc.kicad_pcb", BOARD);
        try {
            sch.setInsetPeer(pcb);
            pcb.setInsetPeer(sch);
            sch.setInsetMode(true);
            expect(sch.escapeInsets()).to.equal(false);
            const viewer = inner(sch, "kc-schematic-app");
            const symbol = [...viewer.schematic!.symbols.values()][0]!;
            const pin = symbol.pins.find((p) => p.number === "1")!;
            const box = viewer.layers.query_item_bboxes(pin).next()
                .value as BBox;
            viewer.on_hover(centre(box));
            await wait(HOVER_OPEN_DELAY_MS + 100);
            // Pin the first preview so the next hover opens a second inset.
            viewer.canvas.dispatchEvent(new MouseEvent("click"));
            const pin2 = symbol.pins.find((p) => p.number === "2")!;
            const box2 = viewer.layers.query_item_bboxes(pin2).next()
                .value as BBox;
            viewer.on_hover(centre(box2));
            await wait(HOVER_OPEN_DELAY_MS + 100);
            expect(sch.insetCount).to.equal(2);
            expect(sch.escapeInsets()).to.equal(true);
            expect(sch.insetCount).to.equal(1);
            expect(sch.escapeInsets()).to.equal(true);
            expect(sch.insetCount).to.equal(0);
            expect(sch.escapeInsets()).to.equal(false);
        } finally {
            sch.setInsetPeer(null);
            pcb.setInsetPeer(null);
            sch.remove();
            pcb.remove();
        }
    });
});

suite("inset elements follow the main view", () => {
    test("highlighting nets on the PCB re-renders the PCB inset on the schematic tab", async () => {
        const sch = await mount("follow.kicad_sch", SCHEMATIC);
        const pcb = await mount("follow.kicad_pcb", BOARD);
        const diagnostics = (
            customElements.get("ecad-viewer") as unknown as {
                insetDiagnostics: { board: { frames: number; reset(): void } };
            }
        ).insetDiagnostics;
        try {
            sch.setInsetPeer(pcb);
            pcb.setInsetPeer(sch);
            sch.setInsetMode(true);
            const viewer = inner(sch, "kc-schematic-app");
            const symbol = [...viewer.schematic!.symbols.values()][0]!;
            const pin = symbol.pins.find((p) => p.number === "1")!;
            const box = viewer.layers.query_item_bboxes(pin).next()
                .value as BBox;
            viewer.on_hover(centre(box));
            await wait(HOVER_OPEN_DELAY_MS + 150);
            expect(sch.insetCount).to.equal(1);
            diagnostics.board.reset();
            (
                pcb as unknown as {
                    setHighlightedNets(nets: Array<{ name: string }>): void;
                }
            ).setHighlightedNets([{ name: "VBUS" }]);
            await wait(100);
            expect(diagnostics.board.frames).to.be.greaterThan(0);
        } finally {
            sch.setInsetPeer(null);
            pcb.setInsetPeer(null);
            sch.remove();
            pcb.remove();
        }
    });
});

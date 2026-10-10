import { expect } from "@esm-bundle/chai";
import { BBox, Matrix3, Vec2 } from "../src/base/math";
import {
    MAX_INSETS,
    clamp_to_view,
    fit_camera,
    inset_matrix,
    inset_to_world,
    InsetSession,
    pan_by,
    world_to_inset,
    zoom_about,
    type InsetCamera,
    type InsetKind,
    type InsetProvider,
    type InsetSource,
    type InsetTarget,
} from "../src/ecad-viewer/insets";

// Matrix3 is Float32, so screen-space results carry ~1e-5 relative error.
const close_to = (a: Vec2, b: Vec2, eps = 1e-3) => {
    expect(a.x).to.be.closeTo(b.x, eps);
    expect(a.y).to.be.closeTo(b.y, eps);
};

const cameras: InsetCamera[] = [
    { center: new Vec2(10, 20), zoom: 4, rotation: 0, mirror: false },
    { center: new Vec2(10, 20), zoom: 4, rotation: Math.PI / 6, mirror: false },
    { center: new Vec2(-3, 7), zoom: 0.5, rotation: 0, mirror: true },
    { center: new Vec2(-3, 7), zoom: 12, rotation: -1.1, mirror: true },
];

suite("Canvas2D transforms", () => {
    test("to_DOMMatrix maps points like transform(), rotations included", () => {
        for (const camera of cameras) {
            const m = inset_matrix(camera, 300, 200);
            const dom = m.to_DOMMatrix();
            for (const p of [
                new Vec2(0, 0),
                new Vec2(3, -8),
                new Vec2(12, 5),
            ]) {
                const q = dom.transformPoint(new DOMPoint(p.x, p.y));
                close_to(new Vec2(q.x, q.y), m.transform(p));
            }
            // from_DOMMatrix is its inverse.
            const back = Matrix3.from_DOMMatrix(dom);
            close_to(
                back.transform(new Vec2(3, -8)),
                m.transform(new Vec2(3, -8)),
            );
        }
    });

    test("a rotated schematic view draws where the leader points", () => {
        // A Canvas2D layer drawn through a rotated inset camera lands where
        // world_to_inset (the leader and outlines) puts it.
        const canvas = document.createElement("canvas");
        canvas.width = 300;
        canvas.height = 200;
        const ctx = canvas.getContext("2d")!;
        const camera: InsetCamera = {
            center: new Vec2(0, 0),
            zoom: 10,
            rotation: Math.PI / 3,
            mirror: false,
        };
        const world = new Vec2(6, 2);
        ctx.setTransform(inset_matrix(camera, 300, 200).to_DOMMatrix());
        ctx.fillStyle = "#ff0000";
        ctx.fillRect(world.x - 0.3, world.y - 0.3, 0.6, 0.6);
        const at = world_to_inset(camera, 300, 200, world);
        const px = ctx.getImageData(
            Math.round(at.x),
            Math.round(at.y),
            1,
            1,
        ).data;
        expect([...px]).to.deep.equal([255, 0, 0, 255]);
    });
});

suite("inset camera", () => {
    test("world → inset → world round-trips with rotation and mirror", () => {
        for (const camera of cameras) {
            for (const p of [
                new Vec2(0, 0),
                new Vec2(10, 20),
                new Vec2(-5, 33),
            ]) {
                const screen = world_to_inset(camera, 300, 200, p);
                close_to(inset_to_world(camera, 300, 200, screen), p);
            }
        }
    });

    test("the camera centre lands at the canvas centre", () => {
        for (const camera of cameras) {
            close_to(
                world_to_inset(camera, 300, 200, camera.center),
                new Vec2(150, 100),
            );
        }
    });

    test("mirror flips the horizontal axis only", () => {
        const plain: InsetCamera = {
            center: new Vec2(0, 0),
            zoom: 2,
            rotation: 0,
            mirror: false,
        };
        const mirrored = { ...plain, mirror: true };
        const p = new Vec2(5, 3);
        const a = world_to_inset(plain, 100, 100, p);
        const b = world_to_inset(mirrored, 100, 100, p);
        expect(a.x).to.be.closeTo(60, 1e-9);
        expect(b.x).to.be.closeTo(40, 1e-9);
        expect(a.y).to.be.closeTo(b.y, 1e-9);
    });

    test("rotation is clockwise on screen", () => {
        const camera: InsetCamera = {
            center: new Vec2(0, 0),
            zoom: 1,
            rotation: Math.PI / 2,
            mirror: false,
        };
        // +x in the world points down (+y) on screen after a quarter turn.
        close_to(
            world_to_inset(camera, 100, 100, new Vec2(10, 0)),
            new Vec2(50, 60),
        );
    });

    test("fit centres the focus and frames twice its size, at least 4 units", () => {
        const camera: InsetCamera = {
            center: new Vec2(0, 0),
            zoom: 1,
            rotation: 0.3,
            mirror: true,
        };
        fit_camera(camera, new BBox(10, 10, 6, 2), 300, 200);
        close_to(camera.center, new Vec2(13, 11));
        // Extent 12 × 4 → min(300/12, 200/4) = 25.
        expect(camera.zoom).to.be.closeTo(25, 1e-9);
        expect(camera.rotation).to.equal(0.3);
        expect(camera.mirror).to.equal(true);

        fit_camera(camera, new BBox(0, 0, 0.5, 0.5), 300, 200);
        // Both extents clamp to 4 → min(75, 50).
        expect(camera.zoom).to.be.closeTo(50, 1e-9);
    });

    test("zoom keeps the world point under the cursor fixed", () => {
        for (const base of cameras) {
            const camera = { ...base, center: base.center.copy() };
            const cursor = new Vec2(70, 40);
            const before = inset_to_world(camera, 300, 200, cursor);
            zoom_about(camera, 300, 200, cursor, 1.7);
            close_to(inset_to_world(camera, 300, 200, cursor), before);
            expect(camera.zoom).to.be.closeTo(base.zoom * 1.7, 1e-9);
        }
    });

    test("pan moves the content with the pointer", () => {
        for (const base of cameras) {
            const camera = { ...base, center: base.center.copy() };
            const grabbed = inset_to_world(camera, 300, 200, new Vec2(100, 80));
            pan_by(camera, 25, -15);
            close_to(
                world_to_inset(camera, 300, 200, grabbed),
                new Vec2(125, 65),
            );
        }
    });
});

class FakeProvider implements InsetProvider {
    renders = 0;
    released: string[] = [];
    last_camera: InsetCamera | null = null;
    pending: Map<string, (t: InsetTarget | null) => void> = new Map();
    deferred = false;

    constructor(readonly kind: InsetKind) {}

    target(reference: string, number: string): InsetTarget {
        return {
            kind: this.kind,
            reference,
            number,
            detail: "VCC",
            side: this.kind === "pcb" ? "top" : "sch",
            focus: new BBox(0, 0, 10, 10),
            anchor: new Vec2(5, 5),
            mirror: false,
        };
    }

    resolve(reference: string, number: string) {
        if (reference === "MISSING") return Promise.resolve(null);
        if (!this.deferred)
            return Promise.resolve(this.target(reference, number));
        return new Promise<InsetTarget | null>((resolve) =>
            this.pending.set(reference, resolve),
        );
    }

    render(_target: InsetTarget, camera: InsetCamera) {
        this.renders += 1;
        this.last_camera = { ...camera };
    }

    release(target: InsetTarget) {
        this.released.push(target.reference);
    }
}

const source_at = (x: number, y: number): InsetSource => ({
    world_to_client: () => new Vec2(x, y),
});

const frame = () =>
    new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

suite("inset session", () => {
    let host: HTMLDivElement;
    let session: InsetSession;
    let pcb: FakeProvider;
    let sch: FakeProvider;

    setup(() => {
        host = document.createElement("div");
        Object.assign(host.style, {
            position: "fixed",
            left: "0px",
            top: "0px",
            width: "1200px",
            height: "800px",
        });
        document.body.append(host);
        session = new InsetSession();
        pcb = new FakeProvider("pcb");
        sch = new FakeProvider("sch");
        session.register(pcb);
        session.register(sch);
        session.mount(host);
    });

    teardown(() => {
        session.dispose();
        host.remove();
    });

    const open = (reference: string, extra: Record<string, unknown> = {}) =>
        session.open({
            kind: "pcb",
            reference,
            number: "1",
            source: source_at(200, 300),
            source_anchor: new Vec2(0, 0),
            ...extra,
        });

    test("a hover opens one preview; the next hover replaces it", async () => {
        const a = await open("U1");
        expect(session.count).to.equal(1);
        expect(session.preview).to.equal(a);
        expect(a!.panel.el.classList.contains("preview")).to.equal(true);
        const b = await open("U2");
        expect(session.count).to.equal(1);
        expect(session.preview).to.equal(b);
        expect(a!.panel.el.isConnected).to.equal(false);
    });

    test("a pinned inset survives the next preview", async () => {
        const a = (await open("U1"))!;
        session.pin(a);
        expect(a.panel.el.classList.contains("preview")).to.equal(false);
        await open("U2");
        expect(session.count).to.equal(2);
        expect(a.panel.el.isConnected).to.equal(true);
    });

    test("an unresolvable designator opens nothing", async () => {
        expect(await open("MISSING")).to.equal(null);
        expect(session.count).to.equal(0);
    });

    test("a slower, superseded hover never opens", async () => {
        pcb.deferred = true;
        const first = open("U1");
        const second = open("U2");
        pcb.pending.get("U2")!(pcb.target("U2", "1"));
        pcb.pending.get("U1")!(pcb.target("U1", "1"));
        expect(await second).to.not.equal(null);
        expect(await first).to.equal(null);
        expect(session.count).to.equal(1);
        expect(session.insets[0]!.target.reference).to.equal("U2");
    });

    test("superseded and closed targets are released to their provider", async () => {
        pcb.deferred = true;
        const first = open("U1");
        const second = open("U2");
        pcb.pending.get("U2")!(pcb.target("U2", "1"));
        pcb.pending.get("U1")!(pcb.target("U1", "1"));
        await Promise.all([first, second]);
        expect(pcb.released).to.deep.equal(["U1"]);
        session.close_all();
        expect(pcb.released).to.deep.equal(["U1", "U2"]);
    });

    test("children share the chain colour; closing a parent closes its subtree", async () => {
        const root = (await open("U1", { preview: false }))!;
        const child = (await session.open({
            kind: "sch",
            reference: "R9",
            number: "1",
            source: root,
            source_anchor: new Vec2(5, 5),
            parent: root,
            preview: false,
        }))!;
        const grandchild = (await session.open({
            kind: "pcb",
            reference: "R9",
            number: "2",
            source: child,
            source_anchor: new Vec2(5, 5),
            parent: child,
            preview: false,
        }))!;
        const other = (await open("Q1", { preview: false }))!;
        expect(child.color).to.equal(root.color);
        expect(grandchild.color).to.equal(root.color);
        expect(other.color).to.not.equal(root.color);
        expect(root.children).to.deep.equal([child]);

        session.close(root);
        expect(session.insets).to.deep.equal([other]);
        for (const gone of [root, child, grandchild])
            expect(gone.panel.el.isConnected).to.equal(false);
    });

    test("closing a child detaches it from its parent only", async () => {
        const root = (await open("U1", { preview: false }))!;
        const child = (await session.open({
            kind: "sch",
            reference: "R9",
            number: "1",
            source: root,
            source_anchor: new Vec2(5, 5),
            parent: root,
            preview: false,
        }))!;
        session.close(child);
        expect(root.children).to.deep.equal([]);
        expect(session.insets).to.deep.equal([root]);
    });

    test("Escape closes the preview first, then everything", async () => {
        await open("U1", { preview: false });
        await open("U2");
        const esc = () =>
            window.dispatchEvent(
                new KeyboardEvent("keydown", {
                    key: "Escape",
                    cancelable: true,
                }),
            );
        esc();
        expect(session.count).to.equal(1);
        expect(session.preview).to.equal(null);
        esc();
        expect(session.count).to.equal(0);
        expect(session.escape()).to.equal(false);
    });

    test("Escape typed into an input is left alone", async () => {
        await open("U1");
        const input = document.createElement("input");
        host.append(input);
        input.dispatchEvent(
            new KeyboardEvent("keydown", {
                key: "Escape",
                bubbles: true,
                composed: true,
                cancelable: true,
            }),
        );
        expect(session.count).to.equal(1);
    });

    test("the leader runs from the source point to the target anchor", async () => {
        const inset = (await open("U1"))!;
        session.flush();
        const d = inset.leader.getAttribute("d")!;
        expect(d.startsWith("M200,300 ")).to.equal(true);
        const end = inset.world_to_client(inset.target.anchor)!;
        expect(inset.ring.getAttribute("cx")).to.equal(`${end.x}`);
        expect(inset.ring.getAttribute("cy")).to.equal(`${end.y}`);
        // The fit centres the focus box; its centre is the anchor here.
        const rect = inset.panel.canvas.getBoundingClientRect();
        expect(end.x).to.be.closeTo(rect.left + rect.width / 2, 1e-3);
        expect(end.y).to.be.closeTo(rect.top + rect.height / 2, 1e-3);
    });

    test("a hidden source hides the leader", async () => {
        let visible = true;
        const inset = (await session.open({
            kind: "pcb",
            reference: "U1",
            number: "1",
            source: {
                world_to_client: () => (visible ? new Vec2(100, 100) : null),
            },
            source_anchor: new Vec2(0, 0),
        }))!;
        session.flush();
        expect(inset.leader.style.display).to.equal("");
        visible = false;
        session.sources_moved();
        session.flush();
        expect(inset.leader.style.display).to.equal("none");
    });

    test("renders happen once per change, on the next frame", async () => {
        const inset = (await open("U1"))!;
        await frame();
        await frame();
        await frame();
        const after_open = pcb.renders;
        // Opening renders once: the first layout's resize is not a change.
        expect(after_open).to.equal(1);
        await frame();
        expect(pcb.renders).to.equal(after_open);
        inset.rotate(0.1);
        inset.rotate(0.1);
        await frame();
        expect(pcb.renders).to.equal(after_open + 1);
        expect(pcb.last_camera!.rotation).to.be.closeTo(0.2, 1e-9);
    });

    test("header buttons receive their clicks (no drag capture)", async () => {
        const inset = (await open("U1", { preview: false }))!;
        const close = inset.panel.button("close");
        close.dispatchEvent(
            new PointerEvent("pointerdown", { bubbles: true, button: 0 }),
        );
        close.click();
        expect(session.count).to.equal(0);
    });

    test("toolbar: rotate, mirror, lens, refit", async () => {
        const inset = (await open("U1", { preview: false }))!;
        inset.panel.button("rotate-cw").click();
        expect(inset.camera.rotation).to.be.closeTo(Math.PI / 12, 1e-9);
        inset.panel.button("rotate-ccw").click();
        inset.panel.button("rotate-ccw").click();
        expect(inset.camera.rotation).to.be.closeTo(-Math.PI / 12, 1e-9);
        inset.panel.button("mirror").click();
        expect(inset.camera.mirror).to.equal(true);
        expect(inset.panel.button("mirror").classList.contains("on")).to.equal(
            true,
        );
        inset.panel.button("lens").click();
        expect(inset.panel.lens).to.equal(true);
        inset.camera.zoom *= 3;
        inset.camera.center = new Vec2(100, 100);
        inset.panel.button("refit").click();
        // The lens frees the header row, so refit uses the canvas as it is now.
        const { w, h } = inset.canvas_size;
        expect(inset.camera.zoom).to.be.closeTo(Math.min(w, h) / 20, 1e-6);
        close_to(inset.camera.center, new Vec2(5, 5));
    });

    test("the pin button shows the state and toggles it", async () => {
        const inset = (await open("U1"))!;
        const pin = inset.panel.button("pin");
        const label = () =>
            pin.querySelector(".inset-tip")!.firstChild!.textContent;
        // A preview offers to pin: outline icon, not pressed.
        expect(pin.querySelector("svg.inset-pin")).to.not.equal(null);
        expect(pin.classList.contains("on")).to.equal(false);
        expect(pin.getAttribute("aria-pressed")).to.equal("false");
        expect(label()).to.equal("Pin");
        pin.click();
        expect(inset.pinned).to.equal(true);
        expect(pin.classList.contains("on")).to.equal(true);
        expect(pin.getAttribute("aria-pressed")).to.equal("true");
        expect(label()).to.equal("Unpin");
        expect(getComputedStyle(pin.querySelector("path")!).fill).to.not.equal(
            "none",
        );
        // Unpinning makes it the preview again; another preview gives way.
        session.pin((await open("U2", { preview: false }))!);
        await open("U3");
        pin.click();
        expect(inset.pinned).to.equal(false);
        expect(session.preview).to.equal(inset);
        expect(session.insets.map((i) => i.target.reference)).to.deep.equal([
            "U1",
            "U2",
        ]);
        expect(pin.classList.contains("on")).to.equal(false);
        expect(label()).to.equal("Pin");
    });

    test("an inset anchoring a chain stays pinned", async () => {
        const root = (await open("U1", { preview: false }))!;
        await session.open({
            kind: "sch",
            reference: "R9",
            number: "1",
            source: root,
            source_anchor: new Vec2(5, 5),
            parent: root,
        });
        root.panel.button("pin").click();
        expect(root.pinned).to.equal(true);
    });

    test("a chained leader starts inside its parent inset", async () => {
        const root = (await open("U1", { preview: false }))!;
        const child = (await session.open({
            kind: "sch",
            reference: "R9",
            number: "1",
            source: root,
            source_anchor: new Vec2(5, 5),
            parent: root,
            preview: false,
        }))!;
        const start = () => {
            session.flush();
            return new Vec2(
                Number(child.origin.getAttribute("cx")),
                Number(child.origin.getAttribute("cy")),
            );
        };
        const inside = (p: Vec2, rect: DOMRect) => {
            expect(p.x).to.be.within(rect.left, rect.right);
            expect(p.y).to.be.within(rect.top, rect.bottom);
        };
        // In view: the leader starts at the pad.
        close_to(start(), root.world_to_client(new Vec2(5, 5))!);
        expect(child.origin.classList.contains("off-view")).to.equal(false);
        // Pan the parent so the pad leaves it: the start stays on its edge.
        root.camera.center = new Vec2(500, 500);
        inside(start(), root.panel.canvas.getBoundingClientRect());
        expect(child.origin.classList.contains("off-view")).to.equal(true);
        // A lens parent keeps it inside the circle.
        root.panel.lens = true;
        const rect = root.panel.el.getBoundingClientRect();
        const p = start();
        expect(
            Math.hypot(
                p.x - (rect.left + rect.width / 2),
                p.y - (rect.top + rect.height / 2),
            ),
        ).to.be.at.most(Math.min(rect.width, rect.height) / 2);
        const d = child.leader.getAttribute("d")!;
        expect(d.startsWith(`M${p.x},${p.y} `)).to.equal(true);
    });

    test("grabbing a preview pins it", async () => {
        const inset = (await open("U1"))!;
        inset.panel.canvas.dispatchEvent(
            new PointerEvent("pointerdown", { bubbles: true, button: 0 }),
        );
        expect(inset.pinned).to.equal(true);
        expect(session.preview).to.equal(null);
    });

    test("a bottom-side target opens mirrored", async () => {
        pcb.target = (reference, number) => ({
            kind: "pcb",
            reference,
            number,
            side: "bottom",
            focus: new BBox(0, 0, 2, 2),
            anchor: new Vec2(1, 1),
            mirror: true,
        });
        const inset = (await open("C1"))!;
        expect(inset.camera.mirror).to.equal(true);
        expect(inset.panel.button("mirror").classList.contains("on")).to.equal(
            true,
        );
    });

    test("the panel opens beside the source, flipping sides near the edge", async () => {
        const left = (await session.open({
            kind: "pcb",
            reference: "U1",
            number: "1",
            source: source_at(200, 300),
            source_anchor: new Vec2(0, 0),
            preview: false,
            size: { w: 320, h: 248 },
        }))!;
        expect(left.panel.el.offsetLeft).to.equal(260);
        const right = (await session.open({
            kind: "pcb",
            reference: "U2",
            number: "1",
            source: source_at(1100, 300),
            source_anchor: new Vec2(0, 0),
            preview: false,
            size: { w: 320, h: 248 },
        }))!;
        expect(right.panel.el.offsetLeft).to.equal(1100 - 60 - 320);
    });

    test("a child's header names its parent as a breadcrumb", async () => {
        const root = (await open("U1", { preview: false }))!;
        const child = (await session.open({
            kind: "sch",
            reference: "R9",
            number: "1",
            source: root,
            source_anchor: new Vec2(5, 5),
            parent: root,
            preview: false,
        }))!;
        const title = child.panel.el.querySelector(".inset-title")!;
        expect(title.querySelector(".inset-crumb")!.textContent).to.equal(
            "U1 · 1 › ",
        );
        expect(title.textContent).to.equal("U1 · 1 › R9 · 1 · VCC");
        expect(root.panel.el.querySelector(".inset-crumb")).to.equal(null);
    });

    test("at most MAX_INSETS stay open; the least recently used goes first", async () => {
        const opened = [];
        for (let i = 0; i < MAX_INSETS; i++)
            opened.push((await open(`U${i}`, { preview: false }))!);
        // Touch the oldest so the second-oldest becomes least recently used.
        opened[0]!.panel.el.dispatchEvent(new PointerEvent("pointerenter"));
        await open("U99", { preview: false });
        expect(session.count).to.equal(MAX_INSETS);
        expect(session.insets).to.include(opened[0]);
        expect(session.insets).to.not.include(opened[1]);
    });

    test("the cap never evicts the new inset's own ancestors", async () => {
        const root = (await open("U0", { preview: false }))!;
        let parent = root;
        for (let i = 1; i < MAX_INSETS; i++)
            parent = (await session.open({
                kind: "pcb",
                reference: `R${i}`,
                number: "1",
                source: parent,
                source_anchor: new Vec2(5, 5),
                parent,
                preview: false,
            }))!;
        // All 8 form one chain: a ninth in the chain has nothing to evict.
        const ninth = await session.open({
            kind: "pcb",
            reference: "R9",
            number: "1",
            source: parent,
            source_anchor: new Vec2(5, 5),
            parent,
            preview: false,
        });
        expect(ninth).to.equal(null);
        expect(session.count).to.equal(MAX_INSETS);
        expect(session.insets).to.include(root);
    });

    test("a child opens beside its parent without covering it", async () => {
        const root = (await open("U1", { preview: false }))!;
        const child = (await session.open({
            kind: "sch",
            reference: "R9",
            number: "1",
            source: root,
            source_anchor: new Vec2(5, 5),
            parent: root,
            preview: false,
        }))!;
        const a = root.panel.el.getBoundingClientRect();
        const b = child.panel.el.getBoundingClientRect();
        const overlaps =
            a.left < b.right &&
            b.left < a.right &&
            a.top < b.bottom &&
            b.top < a.bottom;
        expect(overlaps).to.equal(false);
    });

    test("a second root avoids an inset already open at the same spot", async () => {
        const first = (await open("U1", { preview: false }))!;
        const second = (await open("U2", { preview: false }))!;
        const a = first.panel.el.getBoundingClientRect();
        const b = second.panel.el.getBoundingClientRect();
        const overlaps =
            a.left < b.right &&
            b.left < a.right &&
            a.top < b.bottom &&
            b.top < a.bottom;
        expect(overlaps).to.equal(false);
    });

    test("the overlay moves between hosts and keeps its insets", async () => {
        await open("U1", { preview: false });
        const other = document.createElement("div");
        host.append(other);
        session.mount(other);
        expect(session.root.parentNode).to.equal(other);
        expect(session.count).to.equal(1);
    });
});

suite("inset leader end", () => {
    const view = { left: 100, top: 50, width: 200, height: 100 };

    test("a point inside the view is left alone", () => {
        const r = clamp_to_view(new Vec2(150, 80), view);
        expect(r.clipped).to.equal(false);
        close_to(r.point, new Vec2(150, 80));
    });

    test("a point outside moves to the edge along the line from the centre", () => {
        // Centre (200,100); straight up out of the top edge.
        const up = clamp_to_view(new Vec2(200, -500), view);
        expect(up.clipped).to.equal(true);
        close_to(up.point, new Vec2(200, 54));
        // Diagonal: hits the nearer edge first, keeping the direction.
        const diag = clamp_to_view(new Vec2(600, 300), view);
        expect(diag.clipped).to.equal(true);
        // Direction (400,200): the bottom edge (t = 46/200) comes first.
        expect(diag.point.x).to.be.closeTo(292, 1e-6);
        expect(diag.point.y).to.be.closeTo(146, 1e-6);
    });

    test("a lens clamps to its circle", () => {
        const square = { left: 0, top: 0, width: 200, height: 200 };
        // A corner of the square is outside the circle.
        const r = clamp_to_view(new Vec2(190, 190), square, true);
        expect(r.clipped).to.equal(true);
        expect(Math.hypot(r.point.x - 100, r.point.y - 100)).to.be.closeTo(
            96,
            1e-6,
        );
        expect(
            clamp_to_view(new Vec2(150, 100), square, true).clipped,
        ).to.equal(false);
    });
});

suite("inset leader with the pad out of view", () => {
    test("zooming past the pad ends the leader on the inset's edge", async () => {
        const host = document.createElement("div");
        Object.assign(host.style, {
            position: "fixed",
            left: "0px",
            top: "0px",
            width: "1200px",
            height: "800px",
        });
        document.body.append(host);
        const session = new InsetSession();
        const provider: InsetProvider = {
            kind: "pcb",
            resolve: async (reference, number) => ({
                kind: "pcb",
                reference,
                number,
                side: "top",
                focus: new BBox(0, 0, 10, 10),
                anchor: new Vec2(1, 1),
                mirror: false,
            }),
            render() {},
        };
        session.register(provider);
        session.mount(host);
        try {
            const inset = (await session.open({
                kind: "pcb",
                reference: "U1",
                number: "2",
                source: { world_to_client: () => new Vec2(100, 100) },
                source_anchor: new Vec2(0, 0),
            }))!;
            session.flush();
            expect(inset.ring.getAttribute("r")).to.equal("7");
            // Zoom far in about the centre: (1,1) leaves the view.
            inset.camera.zoom *= 40;
            session.flush();
            const rect = inset.panel.canvas.getBoundingClientRect();
            const cx = Number(inset.ring.getAttribute("cx"));
            const cy = Number(inset.ring.getAttribute("cy"));
            expect(cx).to.be.within(rect.left, rect.right);
            expect(cy).to.be.within(rect.top, rect.bottom);
            expect(inset.ring.getAttribute("r")).to.equal("4");
            expect(inset.ring.classList.contains("off-view")).to.equal(true);
            // Back in view: the ring returns.
            inset.fit();
            session.flush();
            expect(inset.ring.getAttribute("r")).to.equal("7");
        } finally {
            session.dispose();
            host.remove();
        }
    });
});

suite("inset hover outlines", () => {
    let host: HTMLDivElement;
    let session: InsetSession;
    let renders: number;
    let hit_at: Vec2 | null;

    setup(() => {
        host = document.createElement("div");
        Object.assign(host.style, {
            position: "fixed",
            left: "0px",
            top: "0px",
            width: "1200px",
            height: "800px",
        });
        document.body.append(host);
        session = new InsetSession();
        renders = 0;
        hit_at = null;
        const provider: InsetProvider = {
            kind: "pcb",
            resolve: async (reference, number) => ({
                kind: "pcb",
                reference,
                number,
                side: "top",
                focus: new BBox(0, 0, 10, 10),
                anchor: new Vec2(2, 2),
                anchor_box: new BBox(1, 1, 2, 2),
                mirror: false,
            }),
            render: () => {
                renders += 1;
            },
            hit_test: (_target, world) => {
                hit_at = world;
                // A pad occupying world x 6..8, y 6..8.
                return world.x >= 6 &&
                    world.x <= 8 &&
                    world.y >= 6 &&
                    world.y <= 8
                    ? {
                          reference: "R2",
                          number: "1",
                          box: new BBox(6, 6, 2, 2),
                      }
                    : null;
            },
        };
        session.register(provider);
        session.mount(host);
    });

    teardown(() => {
        session.dispose();
        host.remove();
    });

    const open_inset = () =>
        session.open({
            kind: "pcb",
            reference: "U1",
            number: "1",
            source: { world_to_client: () => new Vec2(100, 100) },
            source_anchor: new Vec2(0, 0),
        });

    const points = (el: SVGPolygonElement) =>
        el
            .getAttribute("points")!
            .split(" ")
            .map((p) => p.split(",").map(Number));

    test("the target pad is outlined through the inset's camera", async () => {
        const inset = (await open_inset())!;
        session.flush();
        const { w, h } = inset.canvas_size;
        const expected = world_to_inset(inset.camera, w, h, new Vec2(1, 1));
        const [first] = points(inset.target_outline);
        expect(first![0]).to.be.closeTo(expected.x, 1e-3);
        expect(first![1]).to.be.closeTo(expected.y, 1e-3);
        expect(points(inset.target_outline)).to.have.length(4);
        expect(inset.target_outline.style.display).to.equal("");
        expect(inset.hover_outline.style.display).to.equal("none");
        // Rotated insets rotate the outline with the scene.
        inset.rotate(Math.PI / 4);
        session.flush();
        const [a, b] = points(inset.target_outline);
        expect(Math.abs(a![1] - b![1])).to.be.greaterThan(1);
    });

    test("hovering a pad inside the inset outlines it without re-rendering", async () => {
        const inset = (await open_inset())!;
        await new Promise((r) => requestAnimationFrame(r));
        await new Promise((r) => requestAnimationFrame(r));
        const before = renders;
        const { w, h } = inset.canvas_size;
        const over = world_to_inset(inset.camera, w, h, new Vec2(7, 7));
        const rect = inset.panel.canvas.getBoundingClientRect();
        inset.panel.canvas.dispatchEvent(
            new PointerEvent("pointermove", {
                clientX: rect.left + over.x,
                clientY: rect.top + over.y,
            }),
        );
        close_to(hit_at!, new Vec2(7, 7));
        expect(inset.hit?.reference).to.equal("R2");
        session.flush();
        expect(inset.hover_outline.style.display).to.equal("");
        expect(renders).to.equal(before);
        // Off the pad: the outline goes away.
        inset.panel.canvas.dispatchEvent(new PointerEvent("pointerleave"));
        expect(inset.hit).to.equal(null);
        session.flush();
        expect(inset.hover_outline.style.display).to.equal("none");
        expect(renders).to.equal(before);
    });

    test("a pointer move while panning is not a hover", async () => {
        const inset = (await open_inset())!;
        hit_at = null;
        inset.panel.canvas.dispatchEvent(
            new PointerEvent("pointermove", {
                clientX: 10,
                clientY: 10,
                buttons: 1,
            }),
        );
        expect(hit_at).to.equal(null);
    });
});

import { expect } from "@esm-bundle/chai";
import { BBox, Vec2 } from "../src/base/math";
import {
    fit_camera,
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

    test("the overlay moves between hosts and keeps its insets", async () => {
        await open("U1", { preview: false });
        const other = document.createElement("div");
        host.append(other);
        session.mount(other);
        expect(session.root.parentNode).to.equal(other);
        expect(session.count).to.equal(1);
    });
});

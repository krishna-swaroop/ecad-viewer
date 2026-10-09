/*
    InsetSession: every inset open in one Visualizer.

    Insets form a tree. A root inset hangs off a pin or pad in a main viewer;
    a child hangs off a pad or pin inside its parent inset (chained insets).
    A chain shares one colour, and closing an inset closes its subtree.

    At most one inset is a preview: it follows the hover and is replaced by
    the next one. Pinning keeps it.

    Nothing here runs per frame on its own. Rendering and leader geometry are
    recomputed on the next animation frame after something changed: an inset's
    view, a panel move, or a source viewer's camera (`sources_moved()`).
*/

import { BBox, Vec2 } from "../../base/math";
import {
    fit_camera,
    inset_to_world,
    pan_by,
    world_to_inset,
    zoom_about,
    type InsetCamera,
} from "./camera";
import { INSET_STYLES, InsetPanel, type InsetAction } from "./panel";
import type {
    InsetHit,
    InsetKind,
    InsetProvider,
    InsetSource,
    InsetTarget,
} from "./types";

const SVG_NS = "http://www.w3.org/2000/svg";

export const CHAIN_COLORS = [
    "#8b5cf6",
    "#0ea5e9",
    "#f97316",
    "#10b981",
    "#ef4444",
    "#eab308",
];

const ROTATE_STEP = Math.PI / 12;
const WHEEL_ROTATE_STEP = Math.PI / 36;

export interface OpenInsetRequest {
    kind: InsetKind;
    reference: string;
    number: string;
    /** Where the leader starts. */
    source: InsetSource;
    /** World point in the source's document (the pin or pad hovered). */
    source_anchor: Vec2;
    /** Chained insets: the inset the source anchor lives in. */
    parent?: Inset;
    /** Previews follow the hover; defaults to true. */
    preview?: boolean;
    /**
     * When the designator is not in the target document, open a header-only
     * "not there" inset instead of nothing.
     */
    show_missing?: boolean;
    /** Panel size in CSS pixels (including the header). */
    size?: { w: number; h: number };
}

export class Inset implements InsetSource {
    readonly children: Inset[] = [];
    pinned = false;
    /** The designator is not in the target document: header only. */
    missing = false;
    /** The pin or pad under the pointer inside this inset (IN-20). */
    hit: InsetHit | null = null;
    readonly target_outline = document.createElementNS(SVG_NS, "polygon");
    readonly hover_outline = document.createElementNS(SVG_NS, "polygon");
    #dirty = true;
    #rendered_size = { w: 0, h: 0 };

    constructor(
        readonly session: InsetSession,
        readonly provider: InsetProvider,
        readonly target: InsetTarget,
        readonly source: InsetSource,
        readonly source_anchor: Vec2,
        readonly parent: Inset | null,
        readonly color: string,
        readonly panel: InsetPanel,
        readonly leader: SVGPathElement,
        readonly ring: SVGCircleElement,
        readonly origin: SVGCircleElement,
        readonly camera: InsetCamera,
    ) {}

    /** Hover at a canvas point (or none): find what is under it. */
    hover_at(cursor: Vec2 | null) {
        let hit: InsetHit | null = null;
        if (cursor && !this.missing && this.provider.hit_test) {
            const { w, h } = this.canvas_size;
            if (w && h)
                hit = this.provider.hit_test(
                    this.target,
                    inset_to_world(this.camera, w, h, cursor),
                );
        }
        const same =
            hit?.reference === this.hit?.reference &&
            hit?.number === this.hit?.number;
        this.hit = hit;
        if (!same) this.session.schedule();
    }

    /** Outline the target pad/pin and the hovered one over the canvas. */
    layout_marks() {
        const { w, h } = this.canvas_size;
        const polygon = (el: SVGPolygonElement, box: BBox | undefined) => {
            if (!box || !w || !h) {
                el.style.display = "none";
                return;
            }
            const corners = [
                new Vec2(box.x, box.y),
                new Vec2(box.x + box.w, box.y),
                new Vec2(box.x + box.w, box.y + box.h),
                new Vec2(box.x, box.y + box.h),
            ].map((p) => world_to_inset(this.camera, w, h, p));
            el.setAttribute(
                "points",
                corners.map((p) => `${p.x},${p.y}`).join(" "),
            );
            el.style.display = "";
        };
        polygon(this.target_outline, this.target.anchor_box);
        polygon(this.hover_outline, this.hit?.box);
    }

    get canvas_size() {
        return {
            w: this.panel.canvas.clientWidth,
            h: this.panel.canvas.clientHeight,
        };
    }

    world_to_client(point: Vec2): Vec2 | null {
        const { w, h } = this.canvas_size;
        if (!w || !h) return null;
        const p = world_to_inset(this.camera, w, h, point);
        const rect = this.panel.canvas.getBoundingClientRect();
        return new Vec2(rect.left + p.x, rect.top + p.y);
    }

    client_to_world(point: Vec2): Vec2 | null {
        const { w, h } = this.canvas_size;
        if (!w || !h) return null;
        const rect = this.panel.canvas.getBoundingClientRect();
        return inset_to_world(
            this.camera,
            w,
            h,
            new Vec2(point.x - rect.left, point.y - rect.top),
        );
    }

    fit() {
        if (this.missing) return;
        const { w, h } = this.canvas_size;
        fit_camera(this.camera, this.target.focus, w, h);
        this.invalidate();
    }

    rotate(delta: number) {
        this.camera.rotation += delta;
        this.invalidate();
    }

    set_mirror(value: boolean) {
        this.camera.mirror = value;
        this.panel.mirrored = value;
        this.invalidate();
    }

    invalidate() {
        this.#dirty = true;
        this.session.schedule();
    }

    /** Render if the view changed since the last frame. */
    render(force = false) {
        if (this.missing || (!this.#dirty && !force)) return;
        const { w, h } = this.canvas_size;
        if (!w || !h) return;
        this.#dirty = false;
        this.#rendered_size = { w, h };
        this.provider.render(this.target, this.camera, this.panel.canvas);
    }

    /** The canvas resized; only a real size change needs a new frame. */
    resized() {
        const { w, h } = this.canvas_size;
        if (w !== this.#rendered_size.w || h !== this.#rendered_size.h)
            this.invalidate();
    }
}

export class InsetSession {
    readonly #root: HTMLDivElement;
    readonly #svg: SVGSVGElement;
    readonly #providers = new Map<InsetKind, InsetProvider>();
    #insets: Inset[] = [];
    #preview: Inset | null = null;
    #hovered: Inset | null = null;
    #request = 0;
    #next_color = 0;
    #frame: number | null = null;
    #key_listening = false;

    constructor() {
        this.#root = document.createElement("div");
        this.#root.className = "inset-root";
        const style = document.createElement("style");
        style.textContent = INSET_STYLES;
        this.#svg = document.createElementNS(SVG_NS, "svg");
        this.#root.append(style, this.#svg);
    }

    /** The overlay element; for hosts and tests. */
    get root(): HTMLElement {
        return this.#root;
    }

    get insets(): readonly Inset[] {
        return this.#insets;
    }

    get count() {
        return this.#insets.length;
    }

    get preview(): Inset | null {
        return this.#preview;
    }

    /** The inset under the pointer; toolbar keys act on it. */
    get hovered(): Inset | null {
        return this.#hovered;
    }

    register(provider: InsetProvider) {
        this.#providers.set(provider.kind, provider);
        // The scene behind this provider changed: its insets re-render.
        provider.subscribe?.(() => {
            for (const inset of this.#insets)
                if (inset.provider === provider) inset.invalidate();
        });
    }

    provider(kind: InsetKind): InsetProvider | undefined {
        return this.#providers.get(kind);
    }

    /**
     * Host the overlay in `parent` (the shadow root of the viewer on screen).
     * Moving it between hosts keeps every inset.
     */
    mount(parent: Node) {
        if (this.#root.parentNode !== parent) parent.appendChild(this.#root);
        this.schedule();
    }

    /** A source viewer's camera or layout changed; leaders must follow. */
    sources_moved() {
        if (this.#insets.length) this.schedule();
    }

    async open(request: OpenInsetRequest): Promise<Inset | null> {
        const provider = this.#providers.get(request.kind);
        if (!provider) return null;
        const ticket = ++this.#request;
        const target = await provider.resolve(
            request.reference,
            request.number,
        );
        // Still loading is not the same as absent: open nothing yet.
        if (!target && provider.ready?.() === false) return null;
        const missing = !target;
        if (!target && !(request.show_missing && ticket === this.#request))
            return null;
        // A newer hover superseded this one while it resolved, or the parent
        // closed meanwhile.
        if (
            ticket !== this.#request ||
            (request.parent && !this.#insets.includes(request.parent))
        ) {
            if (target) provider.release?.(target);
            return null;
        }
        const shown: InsetTarget = target ?? {
            kind: request.kind,
            reference: request.reference,
            number: request.number,
            side: "none",
            focus: new BBox(0, 0, 0, 0),
            anchor: new Vec2(0, 0),
            mirror: false,
        };

        const preview = request.preview ?? true;
        if (preview && this.#preview) this.close(this.#preview);

        const color =
            request.parent?.color ??
            CHAIN_COLORS[this.#next_color++ % CHAIN_COLORS.length]!;
        const camera: InsetCamera = {
            center: new Vec2(0, 0),
            zoom: 1,
            rotation: 0,
            mirror: shown.mirror,
        };
        let inset!: Inset;
        const panel = new InsetPanel(color, {
            action: (action) => this.act(inset, action),
            moved: () => this.schedule(),
            resized: () => inset.resized(),
            pan: (dx, dy) => {
                pan_by(inset.camera, dx, dy);
                inset.invalidate();
            },
            wheel: (cursor, delta_y, shift) => {
                if (shift) {
                    inset.rotate(Math.sign(delta_y) * WHEEL_ROTATE_STEP);
                    return;
                }
                const { w, h } = inset.canvas_size;
                zoom_about(
                    inset.camera,
                    w,
                    h,
                    cursor,
                    Math.exp(-delta_y * 0.0015),
                );
                inset.invalidate();
            },
            touched: () => this.pin(inset),
            pointer: (cursor) => inset.hover_at(cursor),
            hover: (on) => {
                if (on) this.#hovered = inset;
                else if (this.#hovered === inset) this.#hovered = null;
            },
        });
        panel.title = shown;
        panel.side = shown.side;
        panel.mirrored = shown.mirror;
        panel.preview = preview;
        panel.el.classList.toggle("missing", missing);

        const leader = document.createElementNS(SVG_NS, "path");
        leader.setAttribute("fill", "none");
        leader.setAttribute("stroke", color);
        leader.setAttribute("stroke-width", "2");
        leader.setAttribute("stroke-dasharray", "6 4");
        leader.setAttribute("stroke-linecap", "round");
        const ring = document.createElementNS(SVG_NS, "circle");
        ring.setAttribute("r", "7");
        ring.setAttribute("fill", "none");
        ring.setAttribute("stroke", color);
        ring.setAttribute("stroke-width", "2");
        const origin = document.createElementNS(SVG_NS, "circle");
        origin.setAttribute("r", "3.5");
        origin.setAttribute("fill", color);

        inset = new Inset(
            this,
            provider,
            shown,
            request.source,
            request.source_anchor,
            request.parent ?? null,
            color,
            panel,
            leader,
            ring,
            origin,
            camera,
        );
        inset.pinned = !preview;
        inset.missing = missing;
        request.parent?.children.push(inset);
        this.#insets.push(inset);
        if (preview) this.#preview = inset;

        inset.target_outline.classList.add("target");
        inset.hover_outline.classList.add("hover");
        panel.marks.append(inset.target_outline, inset.hover_outline);
        this.#root.append(panel.el);
        this.#svg.append(leader, ring, origin);
        this.#place(inset, request.size ?? { w: 320, h: 248 });
        if (!missing) inset.fit();
        this.#listen_keys(true);
        return inset;
    }

    pin(inset: Inset) {
        if (inset.pinned) return;
        inset.pinned = true;
        inset.panel.preview = false;
        if (this.#preview === inset) this.#preview = null;
    }

    /** Close `inset` and everything chained from it. */
    close(inset: Inset) {
        for (const child of [...inset.children]) this.close(child);
        if (!inset.missing) inset.provider.release?.(inset.target);
        inset.panel.dispose();
        inset.leader.remove();
        inset.ring.remove();
        inset.origin.remove();
        this.#insets = this.#insets.filter((candidate) => candidate !== inset);
        if (inset.parent) {
            const siblings = inset.parent.children;
            const index = siblings.indexOf(inset);
            if (index >= 0) siblings.splice(index, 1);
        }
        if (this.#preview === inset) this.#preview = null;
        if (this.#hovered === inset) this.#hovered = null;
        if (!this.#insets.length) this.#listen_keys(false);
    }

    /** Close the preview, if any. Returns whether anything closed. */
    close_previews(): boolean {
        if (!this.#preview) return false;
        this.close(this.#preview);
        return true;
    }

    /** Returns whether anything closed. */
    close_all(): boolean {
        if (!this.#insets.length) return false;
        for (const inset of this.#insets.filter((i) => !i.parent))
            this.close(inset);
        return true;
    }

    /** Escape: previews first, then everything. */
    escape(): boolean {
        return this.close_previews() || this.close_all();
    }

    /** Re-render every inset (the shared scene changed). */
    refresh() {
        for (const inset of this.#insets) inset.invalidate();
    }

    schedule() {
        if (this.#frame !== null) return;
        this.#frame = requestAnimationFrame(() => {
            this.#frame = null;
            this.flush();
        });
    }

    /** Render dirty insets and lay out leaders now. */
    flush() {
        const root = this.#root.getBoundingClientRect();
        for (const inset of this.#insets) {
            inset.render();
            inset.layout_marks();
            this.#layout_leader(inset, root);
        }
    }

    dispose() {
        for (const inset of this.#insets.filter((i) => !i.parent))
            this.close(inset);
        if (this.#frame !== null) cancelAnimationFrame(this.#frame);
        this.#frame = null;
        this.#listen_keys(false);
        this.#root.remove();
    }

    /** Run a toolbar action on `inset` (buttons and keys). */
    act(inset: Inset, action: InsetAction) {
        switch (action) {
            case "rotate-ccw":
                inset.rotate(-ROTATE_STEP);
                break;
            case "rotate-cw":
                inset.rotate(ROTATE_STEP);
                break;
            case "mirror":
                inset.set_mirror(!inset.camera.mirror);
                break;
            case "lens":
                inset.panel.lens = !inset.panel.lens;
                inset.invalidate();
                break;
            case "refit":
                inset.fit();
                break;
            case "pin":
                this.pin(inset);
                break;
            case "close":
                this.close(inset);
                break;
        }
    }

    /** Beside the source anchor, on whichever side has room. */
    #place(inset: Inset, size: { w: number; h: number }) {
        const root = this.#root.getBoundingClientRect();
        const anchor = inset.source.world_to_client(inset.source_anchor);
        const sx = (anchor?.x ?? root.left + root.width / 2) - root.left;
        const sy = (anchor?.y ?? root.top + root.height / 2) - root.top;
        const gap = 60;
        const x =
            sx + gap + size.w <= root.width
                ? sx + gap
                : Math.max(8, sx - gap - size.w);
        const y = Math.min(
            Math.max(8, sy - size.h / 2),
            Math.max(8, root.height - size.h - 8),
        );
        inset.panel.place(x, y, size.w, size.h);
    }

    #layout_leader(inset: Inset, root: DOMRect) {
        const a = inset.source.world_to_client(inset.source_anchor);
        const raw = inset.missing
            ? null
            : inset.world_to_client(inset.target.anchor);
        const visible = !!a && !!raw;
        for (const el of [inset.leader, inset.ring, inset.origin])
            el.style.display = visible ? "" : "none";
        if (!a || !raw) return;
        // Panned or zoomed so the pad is out of view: end the leader at the
        // inset's edge, pointing at it, and mark the edge instead.
        const lens = inset.panel.lens;
        const view = (
            lens ? inset.panel.el : inset.panel.canvas
        ).getBoundingClientRect();
        const { point: b, clipped } = clamp_to_view(raw, view, lens);
        const ax = a.x - root.left;
        const ay = a.y - root.top;
        const bx = b.x - root.left;
        const by = b.y - root.top;
        const dx = (bx - ax) * 0.5;
        inset.leader.setAttribute(
            "d",
            `M${ax},${ay} C${ax + dx},${ay - 40} ${bx - dx},${by - 40} ${bx},${by}`,
        );
        inset.ring.setAttribute("cx", `${bx}`);
        inset.ring.setAttribute("cy", `${by}`);
        inset.ring.setAttribute("r", clipped ? "4" : "7");
        inset.ring.setAttribute("fill", clipped ? inset.color : "none");
        inset.ring.classList.toggle("off-view", clipped);
        inset.origin.setAttribute("cx", `${ax}`);
        inset.origin.setAttribute("cy", `${ay}`);
    }

    #on_key = (e: KeyboardEvent) => {
        if (e.key !== "Escape" || e.defaultPrevented) return;
        if (is_typing_target(e)) return;
        if (this.escape()) e.preventDefault();
    };

    #listen_keys(on: boolean) {
        if (on === this.#key_listening) return;
        this.#key_listening = on;
        if (on) window.addEventListener("keydown", this.#on_key);
        else window.removeEventListener("keydown", this.#on_key);
    }
}

function is_typing_target(e: Event) {
    const target = e.composedPath()[0];
    if (!(target instanceof HTMLElement)) return false;
    return (
        target.isContentEditable ||
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
    );
}

const EDGE_MARGIN = 4;

/**
 * Keep a leader end inside the inset's view: the canvas rectangle, or the
 * circle of a lens. A point outside moves to the edge along the line from
 * the view's centre, so the leader still points at the pad.
 */
export function clamp_to_view(
    point: Vec2,
    view: { left: number; top: number; width: number; height: number },
    circle = false,
): { point: Vec2; clipped: boolean } {
    const cx = view.left + view.width / 2;
    const cy = view.top + view.height / 2;
    const dx = point.x - cx;
    const dy = point.y - cy;
    if (circle) {
        const r = Math.max(
            0,
            Math.min(view.width, view.height) / 2 - EDGE_MARGIN,
        );
        const d = Math.hypot(dx, dy);
        if (d <= r) return { point, clipped: false };
        return {
            point: new Vec2(cx + (dx / d) * r, cy + (dy / d) * r),
            clipped: true,
        };
    }
    const hx = Math.max(0, view.width / 2 - EDGE_MARGIN);
    const hy = Math.max(0, view.height / 2 - EDGE_MARGIN);
    if (Math.abs(dx) <= hx && Math.abs(dy) <= hy)
        return { point, clipped: false };
    const t = Math.min(
        dx ? hx / Math.abs(dx) : Infinity,
        dy ? hy / Math.abs(dy) : Infinity,
    );
    return { point: new Vec2(cx + dx * t, cy + dy * t), clipped: true };
}

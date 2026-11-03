/*
    World view: every sheet a label's net reaches, side by side on one canvas.

    Each sheet is a live scene of its page instance, frame and border grid
    included, placed in one world and drawn through a single camera, so the
    view pans, zooms and drags like a sheet. The sheets stay interactive:
    hovering outlines items, a click selects (Shift+click highlights the
    net), and `~` on another label chains its net in. Everything a click
    picks is reported through the host as a selection on that sheet's page.

    A chain is one label's reach. The first opens the view; each later one
    is added in its own colour, linking sheets already shown and bringing in
    the ones that are not (they join the end of the layout, so nothing on
    screen moves). Sheets fade in a hop at a time from where their chain
    started; each connection then grows along a curve from the label it is
    reached from, ends in an arrowhead, and keeps flowing outward, its
    dashes alternating with the net's name.

    A double-click on a sheet opens it in the main view; Escape closes.
*/

import { BBox, Camera2, Matrix3, Vec2 } from "../../base/math";
import type { CameraViewportInsets } from "../../base/math/camera2";
import {
    MoveAndZoom,
    type MoveAndZoomOptions,
} from "../../base/dom/move-and-zoom";
import {
    instance_key,
    net_closure,
    type NetInstance,
    type NetInstancePage,
} from "./net-instances";
import type { SchematicPageView } from "./schematic-provider";

export interface WorldViewHost {
    /** Where the view mounts, over the schematic. */
    container(): ParentNode | null;
    pages(): NetInstancePage[];
    page_view(key: string): Promise<SchematicPageView | null>;
    /** The scenes changed (highlights, variant): call `listener`. */
    subscribe(listener: () => void): () => void;
    /** Show `page` in the main view, framing `uuid` when given. */
    open_page(page: string, uuid?: string): void;
    /** A click on a sheet: report it as a selection on that page. */
    select(
        view: SchematicPageView,
        item: unknown | null,
        modifiers: { shift: boolean },
    ): void;
    background(): string;
    /** The main view's navigation settings and fit insets, to match it. */
    navigation(): MoveAndZoomOptions | undefined;
    insets(): Partial<CameraViewportInsets> | null;
}

interface Sheet {
    view: SchematicPageView;
    /** World position of the sheet's top-left corner. */
    offset: Vec2;
    /** When it starts fading in (ms, `performance.now()`); 0 is at once. */
    appear_at: number;
}

interface Chain {
    from: NetInstance;
    links: Array<[NetInstance, NetInstance]>;
    reached: NetInstance[];
    color: string;
    opened_at: number;
    depth: Map<string, number>;
}

interface Tokens {
    card: string;
    border: string;
    muted: string;
    font: string;
}

/** The first chain's colour, then each added chain's in turn. */
export const CHAIN_COLORS = [
    "#ffb020",
    "#22d3ee",
    "#c084fc",
    "#34d399",
    "#f472b6",
    "#fb923c",
];

const GAP = 50;
const MIN_ZOOM = 0.02;
const MAX_ZOOM = 100;
/** One hop's sheets start this long after the previous hop's. */
const HOP_DELAY = 260;
/** A sheet fades in over this long; its connection then grows over this long. */
const SHEET_MS = 420;
const LINE_MS = 480;
/** A press that moves further than this is a drag, not a click. */
const CLICK_SLOP = 4;
/** The flowing pattern: a dash, a space, the name, a space (CSS pixels). */
const DASH = 10;
const SPACE = 6;
/** The dashes between two names: three dashes and their spaces. */
const RUN = 3 * DASH + 2 * SPACE;
const FLOW_SPEED = 1 / 35;
const NAME_FONT = "600 10px ui-monospace, SFMono-Regular, Menlo, monospace";
const CAPSULE_H = 14;
const CAPSULE_PAD = 6;
/** Dark text on the line's colour reads on light and dark sheets alike. */
const CAPSULE_INK = "#0f172a";

const ease = (t: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

/**
 * Rows of `cols` sheets, left to right. With `cols` fixed, adding sheets at
 * the end never moves the ones before them.
 */
export function world_layout(
    bounds: readonly BBox[],
    gap = GAP,
    cols = Math.max(1, Math.ceil(Math.sqrt(bounds.length))),
): Vec2[] {
    const offsets: Vec2[] = [];
    let y = 0;
    for (let row = 0; row * cols < bounds.length; row++) {
        const slice = bounds.slice(row * cols, row * cols + cols);
        let x = 0;
        for (const box of slice) {
            offsets.push(new Vec2(x, y));
            x += box.w + gap;
        }
        y += Math.max(...slice.map((box) => box.h)) + gap;
    }
    return offsets;
}

/** Where a pattern of `period` repeats along a run of `length`, shifted by `offset`. */
export function flow_starts(length: number, period: number, offset: number) {
    const starts: number[] = [];
    if (period <= 0) return starts;
    for (let s = (offset % period) - period; s < length; s += period)
        starts.push(s);
    return starts;
}

/** A cubic Bézier sampled by arc length. */
class Curve {
    readonly points: Vec2[] = [];
    readonly lengths: number[] = [0];

    constructor(a: Vec2, c1: Vec2, c2: Vec2, b: Vec2, samples = 64) {
        for (let i = 0; i <= samples; i++) {
            const t = i / samples;
            const u = 1 - t;
            this.points.push(
                new Vec2(
                    u * u * u * a.x +
                        3 * u * u * t * c1.x +
                        3 * u * t * t * c2.x +
                        t * t * t * b.x,
                    u * u * u * a.y +
                        3 * u * u * t * c1.y +
                        3 * u * t * t * c2.y +
                        t * t * t * b.y,
                ),
            );
            if (i)
                this.lengths.push(
                    this.lengths[i - 1]! +
                        this.points[i]!.sub(this.points[i - 1]!).magnitude,
                );
        }
    }

    get length() {
        return this.lengths.at(-1)!;
    }

    #index(s: number) {
        let i = 1;
        while (i < this.lengths.length - 1 && this.lengths[i]! < s) i++;
        return i;
    }

    at(s: number): { point: Vec2; angle: number } {
        const clamped = Math.min(Math.max(s, 0), this.length);
        const i = this.#index(clamped);
        const a = this.points[i - 1]!;
        const b = this.points[i]!;
        const span = this.lengths[i]! - this.lengths[i - 1]!;
        const t = span ? (clamped - this.lengths[i - 1]!) / span : 0;
        return {
            point: new Vec2(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t),
            angle: Math.atan2(b.y - a.y, b.x - a.x),
        };
    }

    /** Trace the part between `from` and `to` (arc lengths) into the current path. */
    trace(
        ctx: Pick<CanvasRenderingContext2D, "moveTo" | "lineTo">,
        from: number,
        to: number,
    ) {
        const s0 = Math.max(0, from);
        const s1 = Math.min(this.length, to);
        if (s1 <= s0) return;
        const start = this.at(s0).point;
        ctx.moveTo(start.x, start.y);
        for (let i = 1; i < this.points.length; i++) {
            const s = this.lengths[i]!;
            if (s <= s0) continue;
            if (s >= s1) break;
            ctx.lineTo(this.points[i]!.x, this.points[i]!.y);
        }
        const end = this.at(s1).point;
        ctx.lineTo(end.x, end.y);
    }
}

export class WorldView {
    #root: HTMLElement | null = null;
    #sheets_canvas: HTMLCanvasElement | null = null;
    #marks_canvas: HTMLCanvasElement | null = null;
    #camera = new Camera2();
    #pan: MoveAndZoom | null = null;
    #observer: ResizeObserver | null = null;
    #unsubscribe: (() => void) | null = null;
    #sheets = new Map<string, Sheet>();
    #order: string[] = [];
    #cols = 1;
    #chains: Chain[] = [];
    #tokens: Tokens | null = null;
    #frame: number | null = null;
    #sheets_dirty = true;
    #ticket = 0;
    #touched = false;
    #hover: { sheet: Sheet; box: BBox } | null = null;
    #selected: { sheet: Sheet; box: BBox } | null = null;
    #press: Vec2 | null = null;

    constructor(private readonly host: WorldViewHost) {}

    get open() {
        return this.#root !== null;
    }

    /** The label the view was opened from. */
    get start(): NetInstance | null {
        return this.#chains[0]?.from ?? null;
    }

    /** Whether `at` already starts or is reached by a chain. */
    traced(at: NetInstance) {
        const key = instance_key(at);
        return this.#chains.some(
            (chain) =>
                instance_key(chain.from) === key ||
                chain.reached.some((it) => instance_key(it) === key),
        );
    }

    /** The scene of `page`, while the view shows it. */
    view(page: string): SchematicPageView | null {
        return this.#sheets.get(page)?.view ?? null;
    }

    /** Something drawn on the sheets changed: redraw them. */
    invalidate() {
        this.#sheets_dirty = true;
        this.#schedule();
    }

    /** Open on the net of the label or sheet entry `from`. */
    async show(from: NetInstance) {
        this.close();
        this.#touched = false;
        const container = this.host.container();
        if (!container) return false;
        const ticket = ++this.#ticket;

        const root = document.createElement("div");
        root.className = "world-view";
        Object.assign(root.style, {
            position: "absolute",
            inset: "0",
            zIndex: "20",
            background: this.host.background(),
        });
        const sheets_canvas = document.createElement("canvas");
        const marks_canvas = document.createElement("canvas");
        for (const canvas of [sheets_canvas, marks_canvas])
            Object.assign(canvas.style, {
                position: "absolute",
                inset: "0",
                width: "100%",
                height: "100%",
            });
        marks_canvas.style.pointerEvents = "none";
        root.append(sheets_canvas, marks_canvas);
        container.append(root);
        this.#root = root;
        this.#sheets_canvas = sheets_canvas;
        this.#marks_canvas = marks_canvas;
        this.#tokens = read_tokens(root);

        const added = await this.#add_chain(from, ticket, true);
        if (!added || ticket !== this.#ticket) {
            if (ticket === this.#ticket) this.close();
            return false;
        }

        this.#camera.fit_insets = this.host.insets();
        this.#resize();
        this.#fit();
        this.#pan = new MoveAndZoom(
            sheets_canvas,
            this.#camera,
            () => {
                this.#touched = true;
                this.invalidate();
            },
            MIN_ZOOM,
            MAX_ZOOM,
            undefined,
            () => true,
            this.host.navigation(),
        );
        this.#listen(sheets_canvas);
        this.#unsubscribe = this.host.subscribe(() => this.invalidate());
        this.#observer = new ResizeObserver(() => {
            this.#resize();
            // Until the view is moved by hand, it keeps every sheet framed
            // as the panels around it open and close.
            if (!this.#touched) {
                this.#camera.fit_insets = this.host.insets();
                this.#fit();
            }
            this.invalidate();
        });
        this.#observer.observe(root);
        this.invalidate();
        return true;
    }

    /**
     * Chain in the net of `from`, a label on a sheet already shown: its
     * connections are drawn in the next colour, and sheets it reaches that
     * are not shown yet join the end of the layout. Nothing happens for a
     * label already traced.
     */
    async chain(from: NetInstance) {
        if (!this.open || this.traced(from)) return false;
        const added = await this.#add_chain(from, this.#ticket, false);
        if (added) this.invalidate();
        return added;
    }

    close() {
        this.#ticket++;
        if (this.#frame !== null) cancelAnimationFrame(this.#frame);
        this.#frame = null;
        this.#pan?.dispose();
        this.#pan = null;
        this.#observer?.disconnect();
        this.#observer = null;
        this.#unsubscribe?.();
        this.#unsubscribe = null;
        for (const sheet of this.#sheets.values()) sheet.view.release();
        this.#sheets.clear();
        this.#order = [];
        this.#chains = [];
        this.#hover = null;
        this.#selected = null;
        this.#root?.remove();
        this.#root = null;
        this.#sheets_canvas = null;
        this.#marks_canvas = null;
    }

    // --- Chains --------------------------------------------------------

    async #add_chain(from: NetInstance, ticket: number, first: boolean) {
        const pages = this.host.pages();
        const { instances, links, depth } = net_closure(pages, from);
        const keys = pages
            .map((page) => page.key)
            .filter((key) => instances.some((it) => it.page === key));
        // The first chain needs somewhere to go; a later one may stay on
        // sheets already shown.
        if (first && keys.length < 2) return false;
        const fresh = keys.filter((key) => !this.#sheets.has(key));
        const views = await Promise.all(
            fresh.map((key) => this.host.page_view(key)),
        );
        if (ticket !== this.#ticket) {
            for (const view of views) view?.release();
            return false;
        }
        const now = performance.now();
        const color = CHAIN_COLORS[this.#chains.length % CHAIN_COLORS.length]!;
        const sheet_depth = (key: string) =>
            Math.min(
                ...instances
                    .filter((it) => it.page === key)
                    .map((it) => depth.get(instance_key(it)) ?? 0),
            );
        const added = views.filter((view): view is SchematicPageView => !!view);
        if (first) this.#cols = Math.max(1, Math.ceil(Math.sqrt(added.length)));
        for (const view of added) {
            const d = sheet_depth(view.key);
            this.#sheets.set(view.key, {
                view,
                offset: new Vec2(0, 0),
                appear_at:
                    first && d === 0 ? 0 : now + Math.max(0, d - 1) * HOP_DELAY,
            });
            this.#order.push(view.key);
        }
        const offsets = world_layout(
            this.#order.map((key) => this.#sheets.get(key)!.view.bounds),
            GAP,
            this.#cols,
        );
        this.#order.forEach((key, i) => {
            this.#sheets.get(key)!.offset = offsets[i]!;
        });
        const shown = links.filter(
            ([a, b]) =>
                a.page !== b.page &&
                this.#sheets.has(a.page) &&
                this.#sheets.has(b.page),
        );
        this.#chains.push({
            from,
            links: shown,
            reached: instances,
            color,
            opened_at: now,
            depth,
        });
        return true;
    }

    // --- Layout and drawing --------------------------------------------

    #fit() {
        const all = BBox.combine(
            [...this.#sheets.values()].map((sheet) => {
                const b = sheet.view.bounds;
                return new BBox(sheet.offset.x, sheet.offset.y, b.w, b.h);
            }),
        );
        this.#camera.bbox = all.grow(GAP / 2);
    }

    /** How far this sheet has faded in (0 to 1) at `now`. */
    #arrival(sheet: Sheet, now: number) {
        if (!sheet.appear_at) return 1;
        return ease((now - sheet.appear_at) / SHEET_MS);
    }

    /** Sheet coordinates → screen (CSS pixels). */
    #sheet_matrix(sheet: Sheet, now = performance.now()): Matrix3 {
        const b = sheet.view.bounds;
        // Arriving sheets settle from slightly smaller, about their centre.
        const s = 0.94 + 0.06 * this.#arrival(sheet, now);
        return this.#camera.matrix
            .multiply_self(
                Matrix3.translation(
                    sheet.offset.x + (b.w * (1 - s)) / 2,
                    sheet.offset.y + (b.h * (1 - s)) / 2,
                ),
            )
            .multiply_self(Matrix3.scaling(s, s))
            .multiply_self(Matrix3.translation(-b.x, -b.y));
    }

    #screen_rect(sheet: Sheet, matrix = this.#sheet_matrix(sheet)) {
        const b = sheet.view.bounds;
        return BBox.from_points([
            matrix.transform(new Vec2(b.x, b.y)),
            matrix.transform(new Vec2(b.x + b.w, b.y + b.h)),
        ]);
    }

    #screen_box(sheet: Sheet, box: BBox) {
        const matrix = this.#sheet_matrix(sheet);
        return BBox.from_points([
            matrix.transform(new Vec2(box.x, box.y)),
            matrix.transform(new Vec2(box.x + box.w, box.y + box.h)),
        ]);
    }

    #sheets_settling(now: number) {
        for (const sheet of this.#sheets.values())
            if (sheet.appear_at && now < sheet.appear_at + SHEET_MS)
                return true;
        return false;
    }

    /** The marks flow for as long as the view is open. */
    #schedule() {
        if (this.#frame !== null || !this.#root) return;
        this.#frame = requestAnimationFrame((now) => {
            this.#frame = null;
            if (!this.#root) return;
            if (this.#sheets_dirty || this.#sheets_settling(now)) {
                this.#sheets_dirty = false;
                this.#draw_sheets(now);
            }
            this.#draw_marks(now);
            this.#schedule();
        });
    }

    #resize() {
        const dpr = window.devicePixelRatio || 1;
        for (const canvas of [this.#sheets_canvas, this.#marks_canvas]) {
            if (!canvas) continue;
            const w = Math.round(canvas.clientWidth * dpr);
            const h = Math.round(canvas.clientHeight * dpr);
            if (canvas.width !== w) canvas.width = w;
            if (canvas.height !== h) canvas.height = h;
        }
        const canvas = this.#sheets_canvas;
        if (canvas)
            this.#camera.viewport_size = new Vec2(
                canvas.clientWidth,
                canvas.clientHeight,
            );
    }

    #draw_sheets(now: number) {
        const canvas = this.#sheets_canvas;
        const ctx = canvas?.getContext("2d");
        const tokens = this.#tokens;
        if (!canvas || !ctx || !tokens) return;
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.globalAlpha = 1;
        ctx.fillStyle = this.host.background();
        ctx.fillRect(0, 0, w, h);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        for (const key of this.#order) {
            const sheet = this.#sheets.get(key)!;
            const alpha = this.#arrival(sheet, now);
            if (alpha <= 0) continue;
            const matrix = this.#sheet_matrix(sheet, now);
            const r = this.#screen_rect(sheet, matrix);
            if (r.x2 < 0 || r.y2 < 0 || r.x > w || r.y > h) continue;
            ctx.save();
            ctx.globalAlpha = alpha;
            ctx.beginPath();
            ctx.rect(r.x, r.y, r.w, r.h);
            ctx.clip();
            sheet.view.render_into(ctx, matrix, dpr);
            ctx.restore();
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.globalAlpha = alpha;
            this.#title(ctx, tokens, sheet.view.name, new Vec2(r.x, r.y - 6));
            ctx.globalAlpha = 1;
        }
    }

    #draw_marks(now: number) {
        const canvas = this.#marks_canvas;
        const ctx = canvas?.getContext("2d");
        if (!canvas || !ctx) return;
        const dpr = window.devicePixelRatio || 1;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";

        const pulse = 0.5 + 0.5 * Math.sin(now / 300);
        for (const chain of this.#chains) {
            const arrived = new Set<string>();
            for (const [from, to] of chain.links) {
                const target = this.#sheets.get(to.page);
                if (!target) continue;
                // A connection grows once its sheet is there: right away for
                // a sheet already shown, else when it has faded in.
                const hop = chain.depth.get(instance_key(to)) ?? 1;
                const landed = Math.max(
                    chain.opened_at + Math.max(0, hop - 1) * HOP_DELAY,
                    target.appear_at ? target.appear_at + SHEET_MS : 0,
                );
                const grow = ease((now - landed) / LINE_MS);
                if (grow <= 0) continue;
                const a = this.#instance_point(from);
                const b = this.#instance_point(to);
                if (!a || !b) continue;
                const curve = connection(a, b);
                this.#draw_connection(
                    ctx,
                    curve,
                    chain.color,
                    to.name,
                    grow,
                    now,
                );
                if (grow < 1) continue;
                arrived.add(instance_key(to));
                const end = curve.at(curve.length);
                draw_arrowhead(ctx, end.point, end.angle, chain.color);
            }
            for (const at of [chain.from, ...chain.links.map(([, to]) => to)]) {
                const start = at === chain.from;
                if (!start && !arrived.has(instance_key(at))) continue;
                const p = this.#instance_point(at);
                if (!p) continue;
                ctx.beginPath();
                ctx.arc(p.x, p.y, (start ? 9 : 6) + 3 * pulse, 0, Math.PI * 2);
                ctx.strokeStyle = chain.color;
                ctx.globalAlpha = 0.5 + 0.4 * pulse;
                ctx.lineWidth = start ? 3 : 2;
                ctx.stroke();
                ctx.globalAlpha = 1;
                ctx.beginPath();
                ctx.arc(p.x, p.y, start ? 4.5 : 3, 0, Math.PI * 2);
                ctx.fillStyle = chain.color;
                ctx.fill();
            }
        }

        if (this.#selected) {
            const box = this.#screen_box(
                this.#selected.sheet,
                this.#selected.box,
            );
            ctx.fillStyle = "rgba(26, 51, 255, 0.18)";
            ctx.fillRect(box.x, box.y, box.w, box.h);
        }
        if (this.#hover) {
            const box = this.#screen_box(this.#hover.sheet, this.#hover.box);
            ctx.strokeStyle = "rgb(0, 255, 255)";
            ctx.lineWidth = 1.5;
            ctx.strokeRect(box.x, box.y, box.w, box.h);
        }
    }

    /**
     * One connection. While growing it is a solid line up to its tip; once
     * grown it flows outward: runs of dashes, then the net's name in a
     * capsule of the line's colour, repeating along the curve. A soft glow
     * follows the dashes, never the name.
     */
    #draw_connection(
        ctx: CanvasRenderingContext2D,
        curve: Curve,
        color: string,
        name: string,
        grow: number,
        now: number,
    ) {
        const reach = curve.length * grow;
        ctx.save();
        ctx.strokeStyle = color;
        if (grow < 1) {
            ctx.globalAlpha = 0.22;
            ctx.lineWidth = 9;
            ctx.beginPath();
            curve.trace(ctx, 0, reach);
            ctx.stroke();
            ctx.globalAlpha = 0.95;
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            curve.trace(ctx, 0, reach);
            ctx.stroke();
            ctx.restore();
            return;
        }
        const label = overbar_text(name);
        ctx.font = NAME_FONT;
        const text = ctx.measureText(label.text).width;
        const capsule = text + 2 * CAPSULE_PAD;
        const period = RUN + SPACE + capsule + SPACE;
        // Too short for the name: dashes only.
        const named = curve.length > period * 1.4;
        const step = named ? period : DASH + SPACE;
        const starts = flow_starts(curve.length, step, now * FLOW_SPEED);
        const dashes = new Path2D();
        for (const s of starts) {
            const run = named ? RUN : DASH;
            for (let d = 0; d + DASH <= run + 0.01; d += DASH + SPACE)
                curve.trace(dashes, s + d, s + d + DASH);
        }
        ctx.globalAlpha = 0.22;
        ctx.lineWidth = 9;
        ctx.stroke(dashes);
        ctx.globalAlpha = 0.95;
        ctx.lineWidth = 2.5;
        ctx.stroke(dashes);
        if (named) {
            ctx.globalAlpha = 1;
            for (const s of starts) {
                const mid = s + RUN + SPACE + capsule / 2;
                if (mid - capsule / 2 < 0 || mid + capsule / 2 > curve.length)
                    continue;
                const { point, angle } = curve.at(mid);
                // Keep the name upright whichever way the line runs.
                const upright = Math.cos(angle) < 0 ? angle + Math.PI : angle;
                ctx.save();
                ctx.translate(point.x, point.y);
                ctx.rotate(upright);
                ctx.fillStyle = color;
                ctx.beginPath();
                ctx.roundRect(
                    -capsule / 2,
                    -CAPSULE_H / 2,
                    capsule,
                    CAPSULE_H,
                    CAPSULE_H / 2,
                );
                ctx.fill();
                ctx.fillStyle = CAPSULE_INK;
                ctx.font = NAME_FONT;
                ctx.textAlign = "left";
                ctx.textBaseline = "middle";
                const left = -text / 2;
                ctx.fillText(label.text, left, 0.5);
                // KiCad's ~{…}: a line over the inverted part.
                ctx.strokeStyle = CAPSULE_INK;
                ctx.lineWidth = 1;
                for (const [from, to] of label.over) {
                    const x0 =
                        left + ctx.measureText(label.text.slice(0, from)).width;
                    const x1 =
                        left + ctx.measureText(label.text.slice(0, to)).width;
                    ctx.beginPath();
                    ctx.moveTo(x0, -4.5);
                    ctx.lineTo(x1, -4.5);
                    ctx.stroke();
                }
                ctx.restore();
            }
        }
        ctx.restore();
    }

    #instance_point(at: NetInstance): Vec2 | null {
        const sheet = this.#sheets.get(at.page);
        const box = sheet?.view.item_bbox(at.uuid);
        return sheet && box ? this.#screen_box(sheet, box).center : null;
    }

    /** A sheet's name above its frame, in Prism's badge style. */
    #title(
        ctx: CanvasRenderingContext2D,
        tokens: Tokens,
        text: string,
        at: Vec2,
    ) {
        ctx.font = `500 11px ${tokens.font}`;
        const w = ctx.measureText(text).width + 12;
        const h = 18;
        ctx.fillStyle = tokens.card;
        ctx.strokeStyle = tokens.border;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(at.x, at.y - h, w, h, 4);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = tokens.muted;
        ctx.textAlign = "start";
        ctx.textBaseline = "middle";
        ctx.fillText(text, at.x + 6, at.y - h / 2 + 0.5);
    }

    // --- Interaction ---------------------------------------------------

    #listen(canvas: HTMLCanvasElement) {
        canvas.addEventListener("pointerdown", (event) => {
            this.#press = new Vec2(event.clientX, event.clientY);
        });
        canvas.addEventListener("pointermove", (event) => {
            const hit = this.#hit(event);
            const box = hit?.found.bbox ?? null;
            if (box === (this.#hover?.box ?? null)) return;
            this.#hover = hit && box ? { sheet: hit.sheet, box } : null;
        });
        canvas.addEventListener("pointerleave", () => {
            this.#hover = null;
        });
        canvas.addEventListener("click", (event) => {
            const press = this.#press;
            this.#press = null;
            if (
                press &&
                Math.hypot(event.clientX - press.x, event.clientY - press.y) >
                    CLICK_SLOP
            )
                return;
            const hit = this.#hit(event);
            const item = hit?.found.item ?? null;
            const bbox = hit?.found.bbox ?? null;
            this.#selected =
                hit && item && bbox ? { sheet: hit.sheet, box: bbox } : null;
            if (hit)
                this.host.select(hit.sheet.view, item, {
                    shift: event.shiftKey,
                });
        });
        canvas.addEventListener("dblclick", (event) => {
            const hit = this.#hit(event);
            if (!hit) return;
            const key = hit.sheet.view.key;
            const here = this.#chains
                .flatMap((chain) => [chain.from, ...chain.links.flat()])
                .find((it) => it.page === key);
            this.close();
            this.host.open_page(key, here?.uuid);
        });
    }

    /** The sheet and item under a pointer event. */
    #hit(event: MouseEvent) {
        const canvas = this.#sheets_canvas;
        if (!canvas) return null;
        const rect = canvas.getBoundingClientRect();
        const screen = new Vec2(
            event.clientX - rect.left,
            event.clientY - rect.top,
        );
        for (const sheet of this.#sheets.values()) {
            const local = this.#sheet_matrix(sheet).inverse().transform(screen);
            if (!sheet.view.bounds.contains_point(local)) continue;
            return { sheet, found: sheet.view.item_at(local) };
        }
        return null;
    }
}

/** A connection's curve: out of `a` sideways, into `b` from the side. */
function connection(a: Vec2, b: Vec2) {
    const span = Math.hypot(b.x - a.x, b.y - a.y);
    const bend = Math.max(60, span * 0.3);
    const dir = b.x >= a.x ? 1 : -1;
    return new Curve(
        a,
        new Vec2(a.x + dir * bend, a.y),
        new Vec2(b.x - dir * bend, b.y),
        b,
    );
}

function draw_arrowhead(
    ctx: CanvasRenderingContext2D,
    tip: Vec2,
    angle: number,
    color: string,
) {
    const size = 10;
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(
        tip.x - size * Math.cos(angle - 0.45),
        tip.y - size * Math.sin(angle - 0.45),
    );
    ctx.lineTo(
        tip.x - size * Math.cos(angle + 0.45),
        tip.y - size * Math.sin(angle + 0.45),
    );
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
}

/** Prism's theme, from the CSS variables it sets on the viewer. */
function read_tokens(el: HTMLElement): Tokens {
    const style = getComputedStyle(el);
    const read = (name: string, fallback: string) =>
        style.getPropertyValue(name).trim() || fallback;
    return {
        card: read("--inset-bg", "#ffffff"),
        border: read("--inset-border", "#e2e8f0"),
        muted: read("--inset-muted", "#64748b"),
        font: read("--inset-font", "system-ui, sans-serif"),
    };
}

/**
 * A net name as drawn: KiCad's `~{…}` overbar markup removed, with the
 * character ranges the bar spans.
 */
export function overbar_text(name: string): {
    text: string;
    over: Array<[number, number]>;
} {
    let text = "";
    const over: Array<[number, number]> = [];
    const pattern = /~\{([^}]*)\}/g;
    let last = 0;
    for (const match of name.matchAll(pattern)) {
        text += name.slice(last, match.index);
        const start = text.length;
        text += match[1];
        over.push([start, text.length]);
        last = match.index! + match[0].length;
    }
    text += name.slice(last);
    return { text, over };
}

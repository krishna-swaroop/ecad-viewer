/*
    World view: every sheet a label's net reaches, side by side on one canvas.

    Each sheet is a live scene of its page instance, frame and border grid
    included, placed in one world and drawn through a single camera, so the
    view pans, zooms and drags like a sheet. The sheets stay interactive:
    hovering outlines items, a click selects (Shift+click highlights the
    net), and `~` on a label continues from there. Everything a click picks
    is reported through the host as a selection on that sheet's own page.

    Connections are drawn as plain right-angle runs through the gaps between
    sheets, from each label to where it leads, with the net's name on the run.
    On opening, the sheets fade in a hop at a time from the starting sheet
    and each run draws in once its sheet is there; after that the view only
    redraws when something changes.

    A double-click on a sheet opens it in the main view.
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
    /** Hops from the starting label to the nearest instance on this sheet. */
    depth: number;
}

interface Tokens {
    accent: string;
    fg: string;
    muted: string;
    card: string;
    border: string;
    font: string;
}

const GAP = 50;
const MIN_ZOOM = 0.02;
const MAX_ZOOM = 100;
/** One hop's sheets start this long after the previous hop's. */
const HOP_DELAY = 180;
/** A sheet fades in over this long; its run then draws in over this long. */
const SHEET_MS = 320;
const LINE_MS = 360;
/** A press that moves further than this is a drag, not a click. */
const CLICK_SLOP = 4;

const ease = (t: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

/** Rows of sheets, left to right, roughly square overall. */
export function world_layout(bounds: readonly BBox[], gap = GAP): Vec2[] {
    const cols = Math.max(1, Math.ceil(Math.sqrt(bounds.length)));
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

/**
 * A right-angle run from `a` on sheet `ra` to `b` on sheet `rb`, turning in
 * the gap between the two sheets (screen coordinates).
 */
export function world_route(a: Vec2, ra: BBox, b: Vec2, rb: BBox): Vec2[] {
    if (ra.x2 <= rb.x || rb.x2 <= ra.x) {
        const mx = ra.x2 <= rb.x ? (ra.x2 + rb.x) / 2 : (rb.x2 + ra.x) / 2;
        return [a, new Vec2(mx, a.y), new Vec2(mx, b.y), b];
    }
    // Stacked sheets: turn nearer the upper one, clear of the lower one's
    // title above its frame.
    const my =
        ra.y2 <= rb.y
            ? ra.y2 + (rb.y - ra.y2) * 0.35
            : rb.y2 + (ra.y - rb.y2) * 0.35;
    return [a, new Vec2(a.x, my), new Vec2(b.x, my), b];
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
    #links: Array<[NetInstance, NetInstance]> = [];
    #start: NetInstance | null = null;
    #tokens: Tokens | null = null;
    #frame: number | null = null;
    #sheets_dirty = true;
    #opened_at = 0;
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
        return this.#start;
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
        const pages = this.host.pages();
        const { instances, links, depth } = net_closure(pages, from);
        const keys = pages
            .map((page) => page.key)
            .filter((key) => instances.some((it) => it.page === key));
        if (keys.length < 2) return false;

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

        const views = await Promise.all(
            keys.map((key) => this.host.page_view(key)),
        );
        if (ticket !== this.#ticket) {
            for (const view of views) view?.release();
            return false;
        }
        const shown = views.filter((view): view is SchematicPageView => !!view);
        const offsets = world_layout(shown.map((view) => view.bounds));
        shown.forEach((view, i) =>
            this.#sheets.set(view.key, {
                view,
                offset: offsets[i]!,
                depth: Math.min(
                    ...instances
                        .filter((it) => it.page === view.key)
                        .map((it) => depth.get(instance_key(it)) ?? 0),
                ),
            }),
        );
        this.#start = from;
        this.#links = links.filter(
            ([a, b]) =>
                a.page !== b.page &&
                this.#sheets.has(a.page) &&
                this.#sheets.has(b.page),
        );

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
        this.#opened_at = performance.now();
        this.invalidate();
        return true;
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
        this.#links = [];
        this.#start = null;
        this.#hover = null;
        this.#selected = null;
        this.#root?.remove();
        this.#root = null;
        this.#sheets_canvas = null;
        this.#marks_canvas = null;
    }

    // --- Layout and drawing --------------------------------------------

    #fit() {
        const all = BBox.combine(
            [...this.#sheets.values()].map((sheet) => this.#world_rect(sheet)),
        );
        this.#camera.bbox = all.grow(GAP / 2);
    }

    #world_rect(sheet: Sheet) {
        const b = sheet.view.bounds;
        return new BBox(sheet.offset.x, sheet.offset.y, b.w, b.h);
    }

    /** How far this sheet has faded in (0 to 1) at `now`. */
    #arrival(sheet: Sheet, now: number) {
        if (!sheet.depth) return 1;
        const start = this.#opened_at + (sheet.depth - 1) * HOP_DELAY;
        return ease((now - start) / SHEET_MS);
    }

    /** Sheet coordinates → screen (CSS pixels). */
    #sheet_matrix(sheet: Sheet, now = performance.now()): Matrix3 {
        const b = sheet.view.bounds;
        // Arriving sheets settle from slightly smaller, about their centre.
        const s = 0.97 + 0.03 * this.#arrival(sheet, now);
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

    #animating(now: number) {
        let deepest = 0;
        for (const sheet of this.#sheets.values())
            deepest = Math.max(deepest, sheet.depth);
        return now < this.#opened_at + deepest * HOP_DELAY + SHEET_MS + LINE_MS;
    }

    #schedule() {
        if (this.#frame !== null || !this.#root) return;
        this.#frame = requestAnimationFrame((now) => {
            this.#frame = null;
            const animating = this.#animating(now);
            if (this.#sheets_dirty || animating) {
                this.#sheets_dirty = false;
                this.#draw_sheets(now);
            }
            this.#draw_marks(now);
            if (animating) this.#schedule();
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
        for (const sheet of this.#sheets.values()) {
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
            this.#chip(
                ctx,
                tokens,
                sheet.view.name,
                new Vec2(r.x, r.y - 6),
                "above",
            );
            ctx.globalAlpha = 1;
        }
    }

    #draw_marks(now: number) {
        const canvas = this.#marks_canvas;
        const ctx = canvas?.getContext("2d");
        const tokens = this.#tokens;
        if (!canvas || !ctx || !tokens) return;
        const dpr = window.devicePixelRatio || 1;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";

        for (const [from, to] of this.#links) {
            const target = this.#sheets.get(to.page);
            const source = this.#sheets.get(from.page);
            if (!target || !source) continue;
            const landed =
                this.#opened_at +
                Math.max(0, target.depth - 1) * HOP_DELAY +
                (target.depth ? SHEET_MS : 0);
            const progress = ease((now - landed) / LINE_MS);
            if (progress <= 0) continue;
            const a = this.#instance_box(from);
            const b = this.#instance_box(to);
            if (!a || !b) continue;
            const route = world_route(
                a.center,
                this.#screen_rect(source),
                b.center,
                this.#screen_rect(target),
            );
            ctx.strokeStyle = tokens.accent;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            draw_partial(ctx, route, progress);
            ctx.stroke();
            ctx.fillStyle = tokens.accent;
            for (const end of progress < 1
                ? [a.center]
                : [a.center, b.center]) {
                ctx.beginPath();
                ctx.arc(end.x, end.y, 3, 0, Math.PI * 2);
                ctx.fill();
            }
            if (progress < 1) continue;
            const mid = route[1]!.add(route[2]!).multiply(0.5);
            this.#chip(ctx, tokens, to.name, mid, "center");
        }

        // The label the view started from, and the ones it reached.
        const marked = [this.#start, ...this.#links.map(([, to]) => to)];
        for (const [index, at] of marked.entries()) {
            if (!at) continue;
            const box = this.#instance_box(at);
            if (!box) continue;
            ctx.strokeStyle = tokens.accent;
            ctx.lineWidth = index === 0 ? 2 : 1.25;
            ctx.beginPath();
            const r = box.grow(3);
            ctx.roundRect(r.x, r.y, r.w, r.h, 3);
            ctx.stroke();
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

    #instance_box(at: NetInstance): BBox | null {
        const sheet = this.#sheets.get(at.page);
        const box = sheet?.view.item_bbox(at.uuid);
        return sheet && box ? this.#screen_box(sheet, box) : null;
    }

    /** A small label in Prism's badge style. */
    #chip(
        ctx: CanvasRenderingContext2D,
        tokens: Tokens,
        text: string,
        at: Vec2,
        place: "above" | "center",
    ) {
        ctx.font = `500 11px ${tokens.font}`;
        const w = ctx.measureText(text).width + 12;
        const h = 18;
        const x = place === "center" ? at.x - w / 2 : at.x;
        const y = place === "center" ? at.y - h / 2 : at.y - h;
        ctx.fillStyle = tokens.card;
        ctx.strokeStyle = tokens.border;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, 4);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = place === "center" ? tokens.fg : tokens.muted;
        ctx.textBaseline = "middle";
        ctx.fillText(text, x + 6, y + h / 2 + 0.5);
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
            this.#schedule();
        });
        canvas.addEventListener("pointerleave", () => {
            this.#hover = null;
            this.#schedule();
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
            this.#schedule();
            if (hit)
                this.host.select(hit.sheet.view, item, {
                    shift: event.shiftKey,
                });
        });
        canvas.addEventListener("dblclick", (event) => {
            const hit = this.#hit(event);
            if (!hit) return;
            const key = hit.sheet.view.key;
            const here = [this.#start, ...this.#links.flat()].find(
                (it) => it?.page === key,
            );
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

/** Prism's theme, from the CSS variables it sets on the viewer. */
function read_tokens(el: HTMLElement): Tokens {
    const style = getComputedStyle(el);
    const read = (name: string, fallback: string) =>
        style.getPropertyValue(name).trim() || fallback;
    return {
        accent: read("--inset-bottom-fg", "#2563eb"),
        fg: read("--inset-fg", "#0f172a"),
        muted: read("--inset-muted", "#64748b"),
        card: read("--inset-bg", "#ffffff"),
        border: read("--inset-border", "#e2e8f0"),
        font: read("--inset-font", "system-ui, sans-serif"),
    };
}

/** The first `progress` (0 to 1) of a polyline, by length. */
function draw_partial(
    ctx: CanvasRenderingContext2D,
    points: readonly Vec2[],
    progress: number,
) {
    const lengths = points
        .slice(1)
        .map((p, i) => Math.hypot(p.x - points[i]!.x, p.y - points[i]!.y));
    let left = lengths.reduce((sum, l) => sum + l, 0) * progress;
    ctx.moveTo(points[0]!.x, points[0]!.y);
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1]!;
        const b = points[i]!;
        const l = lengths[i - 1]!;
        if (left >= l) {
            ctx.lineTo(b.x, b.y);
            left -= l;
            continue;
        }
        const t = l ? left / l : 0;
        ctx.lineTo(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
        return;
    }
}

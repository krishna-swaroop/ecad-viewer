/*
    World view: every sheet a label's net reaches, laid out on one canvas.

    The sheets are placed side by side in one world and drawn through a
    single camera, so the view pans, zooms and drags like a sheet does. Each
    sheet is its own scene (the inset provider's), drawn in place without the
    net highlight's dimming. A second canvas on top carries the connections:
    curves from each label to where it leads on another sheet, with marching
    dashes, redrawn every frame on their own so the sheets are only redrawn
    when the camera moves.

    It opens as a flow: the sheet holding the starting label is in place
    first, and each sheet one hop further glides out from it, fading and
    growing into its slot. When a sheet lands, the line to it grows from the
    label it is reached from, with the net's name on it and an arrowhead at
    the far end; its dashes then keep flowing outward. Everything reads away
    from the label you started on.

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
    /** Show `page` in the main view, framing `uuid` when given. */
    open_page(page: string, uuid?: string): void;
    background(): string;
    /** The main view's navigation settings and fit insets, to match it. */
    navigation(): MoveAndZoomOptions | undefined;
    insets(): Partial<CameraViewportInsets> | null;
    /** Called when the view closed itself (a sheet was opened). */
    closed?(): void;
}

interface Sheet {
    view: SchematicPageView;
    /** World position of the sheet's top-left corner. */
    offset: Vec2;
    /** Hops from the starting label to the nearest instance on this sheet. */
    depth: number;
}

const GAP = 40;
const LINE_COLOR = "#ffb020";
const MIN_ZOOM = 0.02;
const MAX_ZOOM = 100;
/** One hop's sheets start this long after the previous hop's. */
const HOP_DELAY = 260;
/** A sheet takes this long to glide into place; its line then this long to grow. */
const SHEET_MS = 520;
const LINE_MS = 480;

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

export class WorldView {
    #root: HTMLElement | null = null;
    #sheets_canvas: HTMLCanvasElement | null = null;
    #lines_canvas: HTMLCanvasElement | null = null;
    #camera = new Camera2();
    #pan: MoveAndZoom | null = null;
    #observer: ResizeObserver | null = null;
    #sheets = new Map<string, Sheet>();
    #links: Array<[NetInstance, NetInstance]> = [];
    #instances: NetInstance[] = [];
    #depth = new Map<string, number>();
    #origin: string | null = null;
    #dirty = true;
    #frame: number | null = null;
    #opened_at = 0;
    #ticket = 0;

    constructor(private readonly host: WorldViewHost) {}

    get open() {
        return this.#root !== null;
    }

    /** Open on the net of the label or sheet entry `uuid` on page `page`. */
    async show(from: NetInstance) {
        this.close();
        const container = this.host.container();
        if (!container) return false;
        const ticket = ++this.#ticket;
        const pages = this.host.pages();
        const { instances, links, depth } = net_closure(pages, from);
        this.#depth = depth;
        this.#origin = from.page;
        const keys = pages
            .map((page) => page.key)
            .filter((key) => instances.some((it) => it.page === key));
        if (keys.length < 2 && !links.length) return false;

        const root = document.createElement("div");
        Object.assign(root.style, {
            position: "absolute",
            inset: "0",
            zIndex: "20",
            background: this.host.background(),
        });
        const sheets_canvas = document.createElement("canvas");
        const lines_canvas = document.createElement("canvas");
        for (const canvas of [sheets_canvas, lines_canvas])
            Object.assign(canvas.style, {
                position: "absolute",
                inset: "0",
                width: "100%",
                height: "100%",
            });
        lines_canvas.style.pointerEvents = "none";
        root.append(sheets_canvas, lines_canvas);
        container.append(root);
        this.#root = root;
        this.#sheets_canvas = sheets_canvas;
        this.#lines_canvas = lines_canvas;

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
        this.#instances = instances.filter((it) => this.#sheets.has(it.page));
        this.#links = links.filter(
            ([a, b]) => this.#sheets.has(a.page) && this.#sheets.has(b.page),
        );

        this.#camera.fit_insets = this.host.insets();
        this.#resize();
        this.#camera.bbox = this.#world_bounds().grow(GAP / 2);
        this.#pan = new MoveAndZoom(
            sheets_canvas,
            this.#camera,
            () => {
                this.#dirty = true;
            },
            MIN_ZOOM,
            MAX_ZOOM,
            undefined,
            () => true,
            this.host.navigation(),
        );
        sheets_canvas.addEventListener("dblclick", (event) =>
            this.#open_at(event),
        );
        this.#observer = new ResizeObserver(() => {
            this.#resize();
            this.#dirty = true;
        });
        this.#observer.observe(root);
        this.#opened_at = performance.now();
        this.#loop();
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
        for (const sheet of this.#sheets.values()) sheet.view.release();
        this.#sheets.clear();
        this.#root?.remove();
        this.#root = null;
        this.#sheets_canvas = null;
        this.#lines_canvas = null;
    }

    #world_bounds() {
        return BBox.combine(
            [...this.#sheets.values()].map(
                ({ view, offset }) =>
                    new BBox(offset.x, offset.y, view.bounds.w, view.bounds.h),
            ),
        );
    }

    /** How far this sheet has come in (0 to 1) at `now`. */
    #arrival(sheet: Sheet, now: number) {
        if (!sheet.depth) return 1;
        const start = this.#opened_at + (sheet.depth - 1) * HOP_DELAY;
        return ease((now - start) / SHEET_MS);
    }

    /**
     * Sheet coordinates → screen. A sheet still arriving sits between the
     * starting sheet and its slot, scaled down about its centre.
     */
    #sheet_matrix(sheet: Sheet, now = this.#now): Matrix3 {
        const b = sheet.view.bounds;
        const t = this.#arrival(sheet, now);
        const origin = this.#origin ? this.#sheets.get(this.#origin) : null;
        const home = origin?.offset ?? sheet.offset;
        const x = home.x + (sheet.offset.x - home.x) * t;
        const y = home.y + (sheet.offset.y - home.y) * t;
        const s = 0.6 + 0.4 * t;
        return this.#camera.matrix
            .multiply_self(
                Matrix3.translation(
                    x + (b.w * (1 - s)) / 2,
                    y + (b.h * (1 - s)) / 2,
                ),
            )
            .multiply_self(Matrix3.scaling(s, s))
            .multiply_self(Matrix3.translation(-b.x, -b.y));
    }

    #now = 0;

    /** Whether any sheet or line is still coming in. */
    #animating(now: number) {
        let deepest = 0;
        for (const sheet of this.#sheets.values())
            deepest = Math.max(deepest, sheet.depth);
        return now < this.#opened_at + deepest * HOP_DELAY + SHEET_MS + LINE_MS;
    }

    #resize() {
        const dpr = window.devicePixelRatio || 1;
        for (const canvas of [this.#sheets_canvas, this.#lines_canvas]) {
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

    #loop() {
        this.#frame = requestAnimationFrame((now) => {
            this.#now = now;
            if (this.#dirty || this.#animating(now)) {
                this.#dirty = false;
                this.#draw_sheets();
            }
            this.#draw_lines(now);
            this.#loop();
        });
    }

    #draw_sheets() {
        const canvas = this.#sheets_canvas;
        const ctx = canvas?.getContext("2d");
        if (!canvas || !ctx) return;
        const dpr = window.devicePixelRatio || 1;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = this.host.background();
        ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        const order = [...this.#sheets.values()].sort(
            (a, b) => b.depth - a.depth,
        );
        for (const sheet of order) {
            const arrival = this.#arrival(sheet, this.#now);
            if (arrival <= 0) continue;
            ctx.globalAlpha = arrival;
            const matrix = this.#sheet_matrix(sheet);
            const b = sheet.view.bounds;
            const a = matrix.transform(new Vec2(b.x, b.y));
            const c = matrix.transform(new Vec2(b.x + b.w, b.y + b.h));
            if (
                c.x < 0 ||
                c.y < 0 ||
                a.x > canvas.clientWidth ||
                a.y > canvas.clientHeight
            )
                continue;
            ctx.save();
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.beginPath();
            ctx.rect(a.x, a.y, c.x - a.x, c.y - a.y);
            ctx.clip();
            sheet.view.render_into(ctx, matrix, dpr);
            ctx.restore();
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.strokeStyle = "rgba(148, 163, 184, 0.55)";
            ctx.lineWidth = 1;
            ctx.strokeRect(a.x, a.y, c.x - a.x, c.y - a.y);
            ctx.fillStyle = "rgba(226, 232, 240, 0.9)";
            ctx.font = "500 12px system-ui, sans-serif";
            ctx.textBaseline = "bottom";
            ctx.fillText(sheet.view.name, a.x, a.y - 4);
        }
        ctx.globalAlpha = 1;
    }

    #point(at: NetInstance): Vec2 | null {
        const sheet = this.#sheets.get(at.page);
        const box = sheet?.view.item_bbox(at.uuid);
        return sheet && box
            ? this.#sheet_matrix(sheet).transform(box.center)
            : null;
    }

    #draw_lines(now: number) {
        const canvas = this.#lines_canvas;
        const ctx = canvas?.getContext("2d");
        if (!canvas || !ctx) return;
        const dpr = window.devicePixelRatio || 1;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        const arrived = new Set<string>();
        for (const [from, to] of this.#links) {
            const target = this.#sheets.get(to.page);
            if (!target) continue;
            // The line follows its sheet in: it grows once the sheet landed.
            const landed =
                this.#opened_at + (target.depth - 1) * HOP_DELAY + SHEET_MS;
            const grow = ease((now - landed) / LINE_MS);
            if (grow <= 0) continue;
            const a = this.#point(from);
            const b = this.#point(to);
            if (!a || !b) continue;
            const span = Math.hypot(b.x - a.x, b.y - a.y);
            const bend = Math.max(60, span * 0.3);
            const dir = b.x >= a.x ? 1 : -1;
            const c1 = new Vec2(a.x + dir * bend, a.y);
            const c2 = new Vec2(b.x - dir * bend, b.y);
            const path = new Path2D();
            path.moveTo(a.x, a.y);
            path.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, b.x, b.y);
            const length = span * 1.35 + bend;
            ctx.save();
            ctx.strokeStyle = LINE_COLOR;
            ctx.globalAlpha = 0.22;
            ctx.lineWidth = 9;
            ctx.setLineDash([length * grow, length * 2]);
            ctx.stroke(path);
            ctx.globalAlpha = 0.95;
            ctx.lineWidth = 2.5;
            if (grow < 1) ctx.setLineDash([length * grow, length * 2]);
            else {
                // Dashes keep flowing from the near label to the far one.
                ctx.setLineDash([10, 8]);
                ctx.lineDashOffset = -now / 35;
            }
            ctx.stroke(path);
            ctx.restore();
            if (grow < 1) continue;
            arrived.add(instance_key(to));
            this.#arrowhead(ctx, c2, b);
            this.#tag(ctx, bezier_point(a, c1, c2, b, 0.5), to.name);
        }
        const pulse = 0.5 + 0.5 * Math.sin(now / 300);
        for (const at of this.#instances) {
            const start = (this.#depth.get(instance_key(at)) ?? 0) === 0;
            if (!start && !arrived.has(instance_key(at))) continue;
            const p = this.#point(at);
            if (!p) continue;
            ctx.beginPath();
            ctx.arc(p.x, p.y, (start ? 9 : 6) + 3 * pulse, 0, Math.PI * 2);
            ctx.strokeStyle = LINE_COLOR;
            ctx.globalAlpha = 0.5 + 0.4 * pulse;
            ctx.lineWidth = start ? 3 : 2;
            ctx.stroke();
            ctx.globalAlpha = 1;
            ctx.beginPath();
            ctx.arc(p.x, p.y, start ? 4.5 : 3, 0, Math.PI * 2);
            ctx.fillStyle = LINE_COLOR;
            ctx.fill();
        }
    }

    /** A chevron at `tip`, pointing along the curve's last control leg. */
    #arrowhead(ctx: CanvasRenderingContext2D, control: Vec2, tip: Vec2) {
        const angle = Math.atan2(tip.y - control.y, tip.x - control.x);
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
        ctx.fillStyle = LINE_COLOR;
        ctx.fill();
    }

    /** The net's name on its line, so a line says which signal it carries. */
    #tag(ctx: CanvasRenderingContext2D, at: Vec2, name: string) {
        ctx.font = "600 11px ui-monospace, monospace";
        const w = ctx.measureText(name).width + 12;
        ctx.fillStyle = "rgba(15, 23, 42, 0.9)";
        ctx.strokeStyle = LINE_COLOR;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(at.x - w / 2, at.y - 9, w, 18, 9);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "#fde68a";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(name, at.x, at.y + 0.5);
        ctx.textAlign = "start";
    }

    #open_at(event: MouseEvent) {
        const canvas = this.#sheets_canvas;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const screen = new Vec2(
            event.clientX - rect.left,
            event.clientY - rect.top,
        );
        for (const sheet of this.#sheets.values()) {
            const local = this.#sheet_matrix(sheet).inverse().transform(screen);
            if (!sheet.view.bounds.contains_point(local)) continue;
            const here = this.#instances.find(
                (it) => it.page === sheet.view.key,
            );
            this.host.open_page(sheet.view.key, here?.uuid);
            this.close();
            this.host.closed?.();
            return;
        }
    }
}

/** A point on the cubic Bézier a→b with controls c1, c2, at `t`. */
function bezier_point(a: Vec2, c1: Vec2, c2: Vec2, b: Vec2, t: number) {
    const u = 1 - t;
    return new Vec2(
        u * u * u * a.x +
            3 * u * u * t * c1.x +
            3 * u * t * t * c2.x +
            t * t * t * b.x,
        u * u * u * a.y +
            3 * u * u * t * c1.y +
            3 * u * t * t * c2.y +
            t * t * t * b.y,
    );
}

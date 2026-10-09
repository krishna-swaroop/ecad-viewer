/*
    The DOM for one inset: a header (chain dot, title, side badge, toolbar),
    the canvas the provider renders into, and a resize grip. The panel owns
    gestures; what they mean is up to the session.
*/

import { Vec2 } from "../../base/math";
import type { InsetSide } from "./types";

export type InsetAction =
    | "rotate-ccw"
    | "rotate-cw"
    | "mirror"
    | "lens"
    | "refit"
    | "pin"
    | "close";

export interface InsetPanelHandlers {
    action(action: InsetAction): void;
    /** The panel moved or resized; leaders need recomputing. */
    moved(): void;
    /** The canvas size changed; the inset needs re-rendering. */
    resized(): void;
    /** Drag on the canvas, in screen pixels. */
    pan(dx: number, dy: number): void;
    /** Wheel on the canvas; `cursor` is in canvas CSS pixels. */
    wheel(cursor: Vec2, delta_y: number, shift: boolean): void;
    /** The user grabbed the panel (header, grip or canvas). */
    touched(): void;
}

const TOOLBAR: [InsetAction, string, string][] = [
    ["rotate-ccw", "↺", "Rotate −15°"],
    ["rotate-cw", "↻", "Rotate +15°"],
    ["mirror", "⇋", "Mirror"],
    ["lens", "◯", "Lens"],
    ["refit", "⌂", "Refit"],
    ["pin", "📌", "Pin"],
    ["close", "✕", "Close"],
];

const SIDE_LABEL: Record<InsetSide, string> = {
    top: "TOP",
    bottom: "BOT",
    sch: "SCH",
};

export const MIN_PANEL_WIDTH = 160;
export const MIN_PANEL_HEIGHT = 120;

export class InsetPanel {
    readonly el: HTMLDivElement;
    readonly canvas: HTMLCanvasElement;
    #title: HTMLSpanElement;
    #side: HTMLSpanElement;
    #buttons = new Map<InsetAction, HTMLButtonElement>();
    #resize_observer: ResizeObserver;

    constructor(
        color: string,
        private readonly handlers: InsetPanelHandlers,
    ) {
        this.el = document.createElement("div");
        this.el.className = "inset preview";
        this.el.style.setProperty("--inset-color", color);

        const header = document.createElement("div");
        header.className = "inset-header";
        const dot = document.createElement("span");
        dot.className = "inset-dot";
        this.#title = document.createElement("span");
        this.#title.className = "inset-title";
        this.#side = document.createElement("span");
        this.#side.className = "inset-side";
        const toolbar = document.createElement("span");
        toolbar.className = "inset-toolbar";
        for (const [action, glyph, label] of TOOLBAR) {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = glyph;
            button.title = label;
            button.setAttribute("aria-label", label);
            button.dataset["action"] = action;
            button.addEventListener("click", (e) => {
                e.stopPropagation();
                handlers.action(action);
            });
            this.#buttons.set(action, button);
            toolbar.append(button);
        }
        header.append(dot, this.#title, this.#side, toolbar);

        this.canvas = document.createElement("canvas");
        this.canvas.className = "inset-canvas";
        const grip = document.createElement("div");
        grip.className = "inset-grip";
        this.el.append(header, this.canvas, grip);

        this.#drag(header, (dx, dy) => {
            this.el.style.left = `${this.el.offsetLeft + dx}px`;
            this.el.style.top = `${this.el.offsetTop + dy}px`;
            handlers.moved();
        });
        this.#drag(grip, (dx, dy) => {
            this.set_size(this.el.offsetWidth + dx, this.el.offsetHeight + dy);
        });
        this.#drag(this.canvas, (dx, dy) => handlers.pan(dx, dy));
        this.canvas.addEventListener(
            "wheel",
            (e) => {
                e.preventDefault();
                e.stopPropagation();
                const rect = this.canvas.getBoundingClientRect();
                handlers.wheel(
                    new Vec2(e.clientX - rect.left, e.clientY - rect.top),
                    e.deltaY,
                    e.shiftKey,
                );
            },
            { passive: false },
        );
        this.#resize_observer = new ResizeObserver(() => handlers.resized());
        this.#resize_observer.observe(this.canvas);
    }

    set title(value: { reference: string; number: string; detail?: string }) {
        const sub = [value.number, value.detail].filter(Boolean).join(" · ");
        this.#title.replaceChildren(
            Object.assign(document.createElement("b"), {
                textContent: value.reference,
            }),
            document.createTextNode(sub ? ` · ${sub}` : ""),
        );
    }

    set side(side: InsetSide) {
        this.#side.textContent = SIDE_LABEL[side];
        this.#side.classList.toggle("bottom", side === "bottom");
    }

    set preview(value: boolean) {
        this.el.classList.toggle("preview", value);
    }

    set mirrored(value: boolean) {
        this.#buttons.get("mirror")!.classList.toggle("on", value);
    }

    get lens() {
        return this.el.classList.contains("lens");
    }

    set lens(value: boolean) {
        this.el.classList.toggle("lens", value);
        this.#buttons.get("lens")!.classList.toggle("on", value);
    }

    button(action: InsetAction) {
        return this.#buttons.get(action)!;
    }

    place(x: number, y: number, w: number, h: number) {
        this.el.style.left = `${x}px`;
        this.el.style.top = `${y}px`;
        this.set_size(w, h);
    }

    set_size(w: number, h: number) {
        this.el.style.width = `${Math.max(MIN_PANEL_WIDTH, w)}px`;
        this.el.style.height = `${Math.max(MIN_PANEL_HEIGHT, h)}px`;
    }

    dispose() {
        this.#resize_observer.disconnect();
        this.el.remove();
    }

    #drag(target: HTMLElement, on_move: (dx: number, dy: number) => void) {
        target.addEventListener("pointerdown", (e) => {
            if (e.button !== 0) return;
            // Toolbar buttons take their own clicks. Capturing the pointer
            // here would retarget the click to the header and swallow it.
            if ((e.target as Element).closest("button")) return;
            e.preventDefault();
            e.stopPropagation();
            // Synthetic or already-released pointers cannot be captured.
            try {
                target.setPointerCapture(e.pointerId);
            } catch {
                /* drag still works while the pointer stays over the target */
            }
            let last = { x: e.clientX, y: e.clientY };
            const move = (ev: PointerEvent) => {
                on_move(ev.clientX - last.x, ev.clientY - last.y);
                last = { x: ev.clientX, y: ev.clientY };
            };
            const up = () => {
                target.removeEventListener("pointermove", move);
                target.removeEventListener("pointerup", up);
                target.removeEventListener("pointercancel", up);
            };
            target.addEventListener("pointermove", move);
            target.addEventListener("pointerup", up);
            target.addEventListener("pointercancel", up);
            this.handlers.touched();
        });
    }
}

export const INSET_STYLES = `
.inset-root { position: absolute; inset: 0; pointer-events: none; z-index: 30; overflow: hidden; }
.inset-root svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; z-index: 2; pointer-events: none; }
.inset { position: absolute; z-index: 1; pointer-events: auto; display: flex; flex-direction: column;
  background: var(--inset-bg, #fff); color: var(--inset-fg, #0f172a);
  border: 1.5px solid var(--inset-color); border-radius: var(--inset-radius, 8px);
  box-shadow: 0 8px 24px rgb(15 23 42 / 18%); overflow: hidden;
  font: 12px/1.3 var(--inset-font, system-ui, sans-serif); }
.inset.preview { border-style: dashed; }
.inset-header { display: flex; align-items: center; gap: 6px; height: 28px; flex: none; padding: 0 4px 0 8px;
  border-bottom: 1px solid var(--inset-border, #e2e8f0); cursor: move; user-select: none; white-space: nowrap; }
.inset-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--inset-color); flex: none; }
.inset-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--inset-muted, #64748b); }
.inset-title b { color: var(--inset-fg, #0f172a); }
.inset-side { font: 600 10px/1 ui-monospace, monospace; padding: 3px 5px; border-radius: 4px;
  background: var(--inset-muted-bg, #f1f5f9); color: var(--inset-muted, #64748b); }
.inset-side.bottom { background: #dbe7f7; color: #29558f; }
.inset-toolbar { display: flex; gap: 1px; }
.inset-toolbar button { all: unset; width: 22px; height: 22px; display: flex; align-items: center; justify-content: center;
  border-radius: 5px; color: var(--inset-muted, #64748b); cursor: pointer; font-size: 13px; }
.inset-toolbar button:hover { background: var(--inset-muted-bg, #f1f5f9); color: var(--inset-fg, #0f172a); }
.inset-toolbar button.on { color: var(--inset-color); }
.inset.preview .inset-toolbar button:not([data-action="pin"]) { display: none; }
.inset-canvas { flex: 1; width: 100%; min-height: 0; display: block; cursor: grab; }
.inset-grip { position: absolute; right: 0; bottom: 0; width: 12px; height: 12px; cursor: nwse-resize; }
.inset.lens { border-radius: 50%; border-width: 2px; }
.inset.lens .inset-header { position: absolute; top: 9%; left: 18%; right: 18%; height: 24px; z-index: 1;
  background: var(--inset-bg, #fff); border: 1px solid var(--inset-border, #e2e8f0); border-radius: 6px; }
.inset.lens .inset-title, .inset.lens .inset-side { display: none; }
.inset.lens .inset-grip { right: 14%; bottom: 14%; }
`;

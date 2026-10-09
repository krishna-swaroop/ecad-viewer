/*
    Board insets: the PCB around a footprint, rendered by the board viewer
    that already holds the document.
*/

import { BBox, Vec2 } from "../../base/math";
import { Pad } from "../../kicad/board";
import { Depth } from "../../kicad/board_bbox_visitor";
import { VIEWER_DRAW_REQUESTED } from "../../viewers/base/viewer";
import type { BoardViewer } from "../../viewers/board/viewer";
import { inset_matrix, type InsetCamera } from "./camera";
import type { InsetHit, InsetProvider, InsetTarget } from "./types";

const center = (box: BBox) => new Vec2(box.x + box.w / 2, box.y + box.h / 2);

export class BoardInsetProvider implements InsetProvider {
    readonly kind = "pcb" as const;

    #listeners = new Set<() => void>();
    #hooked: BoardViewer | null = null;
    #unhook: (() => void) | null = null;

    constructor(private readonly viewer: () => BoardViewer | null) {}

    /**
     * Insets show the board viewer's own scene, so every change it draws
     * (layers, highlights, selection, variant, DNP) reaches them: they
     * re-render on its draw requests.
     */
    subscribe(listener: () => void) {
        this.#listeners.add(listener);
        this.#hook();
        return () => {
            this.#listeners.delete(listener);
        };
    }

    #hook() {
        const viewer = this.viewer();
        if (!viewer || viewer === this.#hooked) return;
        this.#unhook?.();
        this.#hooked = viewer;
        const notify = () => {
            for (const listener of this.#listeners) listener();
        };
        viewer.addEventListener(VIEWER_DRAW_REQUESTED as never, notify);
        this.#unhook = () =>
            viewer.removeEventListener(VIEWER_DRAW_REQUESTED, notify);
    }

    ready() {
        this.#hook();
        return !!this.viewer()?.board;
    }

    async resolve(
        reference: string,
        number: string,
    ): Promise<InsetTarget | null> {
        this.#hook();
        const board = this.viewer()?.board;
        if (!board) return null;
        const fp = board.footprints.find((f) => f.reference === reference);
        if (!fp) return null;
        const pad = fp.pad_by_number(number) ?? null;
        const bottom = fp.layer?.startsWith("B.") ?? false;
        return {
            kind: "pcb",
            reference,
            number,
            detail: pad?.net?.name || undefined,
            side: bottom ? "bottom" : "top",
            focus: fp.bbox,
            anchor: center(pad ? pad.bbox : fp.bbox),
            anchor_box: pad?.bbox,
            mirror: bottom,
        };
    }

    hit_test(_target: InsetTarget, world: Vec2): InsetHit | null {
        const viewer = this.viewer();
        if (!viewer?.board) return null;
        for (const entry of viewer.find_items_under_pos(world)) {
            const item = entry.item;
            if (entry.depth !== Depth.PAD || !(item instanceof Pad)) continue;
            if (!item.number.trim()) continue;
            return {
                reference: item.parent.reference,
                number: item.number,
                box: item.bbox,
            };
        }
        return null;
    }

    render(
        target: InsetTarget,
        camera: InsetCamera,
        canvas: HTMLCanvasElement,
    ) {
        this.viewer()?.render_view(
            canvas,
            (w, h) => inset_matrix(camera, w, h),
            // A bottom view shows the back side on top, KiCad's flip view.
            { back_on_top: camera.mirror },
        );
    }
}

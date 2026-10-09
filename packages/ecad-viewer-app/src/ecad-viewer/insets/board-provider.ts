/*
    Board insets: the PCB around a footprint, rendered by the board viewer
    that already holds the document.
*/

import { BBox, Vec2 } from "../../base/math";
import type { BoardViewer } from "../../viewers/board/viewer";
import { inset_matrix, type InsetCamera } from "./camera";
import type { InsetProvider, InsetTarget } from "./types";

const center = (box: BBox) => new Vec2(box.x + box.w / 2, box.y + box.h / 2);

export class BoardInsetProvider implements InsetProvider {
    readonly kind = "pcb" as const;

    constructor(private readonly viewer: () => BoardViewer | null) {}

    async resolve(
        reference: string,
        number: string,
    ): Promise<InsetTarget | null> {
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
            mirror: bottom,
        };
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

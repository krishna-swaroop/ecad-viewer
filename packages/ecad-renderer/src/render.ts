import type { boardProto, schematicProto } from "kicad-parser";

import { KicadPCB } from "../../ecad-viewer-app/src/kicad/board";
import { KicadSch } from "../../ecad-viewer-app/src/kicad/schematic";
import themes from "../../ecad-viewer-app/src/kicanvas/themes";
import { BoardViewer } from "../../ecad-viewer-app/src/viewers/board/viewer";
import { SchematicViewer } from "../../ecad-viewer-app/src/viewers/schematic/viewer";
import { KiCanvasProbeEvent } from "../../ecad-viewer-app/src/viewers/base/events";
import type {
    ViewerInteractionOptions,
    ViewerNavigationOptions,
} from "../../ecad-viewer-app/src/viewers/base/viewer";
import type { RenderOptions, RenderResult } from "./types";

/**
 * Glyphs are deliberately not loaded here.
 *
 * Upstream's renderer assigns the full NewStroke table at module load so it has
 * no runtime font dependency, and flags the cost itself: it adds about 2 MB to
 * every bundle that imports the renderer. A library symbol or footprint carries
 * reference designators, pin names and values, all of which the 256 glyphs
 * StrokeFont bundles by default already cover.
 *
 * A host that renders CJK text can populate `NewStrokeGlyph.glyph_data` before
 * its first render -- the table is a module-level singleton, so the app's
 * `Project.import_cjk_glyphs()` covers the renderer too.
 */

/**
 * Canvases already wired for context-menu suppression -- idempotent across
 * repeated renders into the same canvas.
 */
const context_menu_wired = new WeakSet<HTMLCanvasElement>();

/**
 * Suppress the browser's context menu on the renderer's canvas.
 *
 * Interactive viewers pan with right-drag, so the default menu would interrupt
 * the gesture. Only `preventDefault()` is called and propagation is left alone,
 * so a host can still attach its own `contextmenu` listener for a custom menu.
 */
function suppress_default_context_menu(canvas: HTMLCanvasElement) {
    if (context_menu_wired.has(canvas)) return;
    context_menu_wired.add(canvas);
    canvas.addEventListener("contextmenu", (e) => {
        if (e.target === canvas) e.preventDefault();
    });
}

/**
 * Resolve the canvas to paint into.
 *
 * The host owns the canvas's CSS size; the renderer owns the backing
 * resolution and keeps it in step with CSS size x DPR on every clear, while
 * the viewer's Viewport watches CSS size changes to update the camera.
 */
function target(options: RenderOptions): HTMLCanvasElement {
    const canvas = options.canvas ?? document.createElement("canvas");
    if (!canvas.parentElement)
        (options.container ?? document.body).append(canvas);
    suppress_default_context_menu(canvas);
    return canvas;
}

interface MountableViewer {
    setup(): Promise<void>;
    load(value: never): Promise<void>;
    dispose(): void;
    loaded: PromiseLike<boolean>;
    show_drawing_sheet: boolean;
    addEventListener(
        type: typeof KiCanvasProbeEvent.type,
        listener: (event: KiCanvasProbeEvent) => void,
    ): { dispose(): void };
    zoom_by(factor: number): void;
    reset_view(): void;
    set_probe_highlight(index: string, state: "hover" | "latched"): number;
    clear_probe_highlight(): void;
}

const enabled_navigation: ViewerNavigationOptions = {
    wheel: "direct",
    pinch: true,
    touchPan: true,
};

const disabled_navigation: ViewerNavigationOptions = {
    wheel: "disabled",
    pinch: false,
    touchPan: false,
};

function interaction(options: RenderOptions): ViewerInteractionOptions {
    const legacy = options.interactive ?? false;
    return {
        selectable: options.selectable ?? legacy,
        navigation: {
            ...(legacy ? enabled_navigation : disabled_navigation),
            ...options.navigation,
        },
    };
}

async function mount<T extends MountableViewer>(
    viewer: T,
    document: unknown,
    canvas: HTMLCanvasElement,
    options: RenderOptions,
): Promise<RenderResult<T>> {
    // A render call is for the supplied POD alone. The worksheet is a document
    // concern and would distort how a standalone asset is fitted.
    viewer.show_drawing_sheet = false;
    await viewer.setup();
    await viewer.load(document as never);
    // DocumentViewer finishes painting and calls zoom_fit_top_item on its next
    // layout turn. Resolving before that fit would hand back an unfitted view.
    await viewer.loaded;
    const probe_listener = viewer.addEventListener(
        KiCanvasProbeEvent.type,
        (event) => options.onProbe?.(event.detail),
    );
    let disposed = false;
    return {
        canvas,
        viewer,
        controller: {
            zoomBy: (factor) => viewer.zoom_by(factor),
            resetView: () => viewer.reset_view(),
            setProbeHighlight: (index, state) =>
                viewer.set_probe_highlight(index, state),
            clearProbeHighlight: () => viewer.clear_probe_highlight(),
        },
        dispose: () => {
            if (disposed) return;
            disposed = true;
            probe_listener.dispose();
            viewer.dispose();
        },
    };
}

export async function renderSchematic(
    schematic: schematicProto.I_KicadSch,
    options: RenderOptions = {},
): Promise<RenderResult<SchematicViewer>> {
    const canvas = target(options);
    return mount(
        new SchematicViewer(
            canvas,
            interaction(options),
            themes.default.schematic,
        ),
        new KicadSch("schematic.kicad_sch", schematic),
        canvas,
        options,
    );
}

export async function renderPcb(
    pcb: boardProto.I_KicadPCB,
    options: RenderOptions = {},
): Promise<RenderResult<BoardViewer>> {
    const canvas = target(options);
    return mount(
        new BoardViewer(canvas, interaction(options), themes.default.board),
        new KicadPCB("board.kicad_pcb", pcb),
        canvas,
        options,
    );
}

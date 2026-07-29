/*
    Copyright (c) 2022 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { BBox, Vec2 } from "../../base/math";
import {
    DrawingSheet,
    type DrawingSheetDocument,
    type BaseTheme,
} from "../../kicad";
import { Grid } from "./grid";
import type { DocumentPainter, PaintableDocument } from "./painter";
import { ViewLayerNames, type ViewLayerSet } from "./view-layers";
import { Viewer } from "./viewer";
import { later } from "../../base/async";
import { DrawingSheetPainter } from "../drawing-sheet/painter";
import { is_showing_design_block } from "../../ecad-viewer/ecad_viewer_global";
import { Color } from "../../graphics";
import type { EcadDiffPresentation } from "./diff-presentation";

type ViewableDocument = DrawingSheetDocument &
    PaintableDocument & {
        filename: string;
        bbox: BBox;
        is_converted_from_ad?: boolean;
    };
const zoom_speed = 0.005;
const delta = 3;

export abstract class DocumentViewer<
    DocumentT extends ViewableDocument,
    PainterT extends DocumentPainter,
    ViewLayerSetT extends ViewLayerSet,
    ThemeT extends BaseTheme,
> extends Viewer {
    public document: DocumentT;
    public drawing_sheet: DrawingSheet;
    declare public layers: ViewLayerSetT;
    public theme: ThemeT;

    protected painter: PainterT;
    protected grid: Grid;
    #diff_presentation: EcadDiffPresentation | null = null;
    #paint_count = 0;
    #presentation_cache_enabled = false;
    #retained_overlay_channels: ReadonlySet<string> = new Set();
    #presentation_scene_cache = new Map<
        DocumentT,
        Map<
            EcadDiffPresentation | null,
            {
                layers: ViewLayerSetT;
                painter: PainterT;
                grid: Grid;
            }
        >
    >();

    protected static FACTOR_zoom_fit_top_item = 1.6;

    public set_drawing_sheet(sheet: DrawingSheet) {
        if (this.disposables.isDisposed) {
            return;
        }
        this.drawing_sheet = sheet;
        if (this.document) {
            this.paint();
            this.draw();
        }
    }

    /** True after the host custom element disconnected and disposed this viewer. */
    public get is_disposed(): boolean {
        return this.disposables.isDisposed;
    }

    constructor(
        canvas: HTMLCanvasElement,
        interactive: boolean,
        theme: ThemeT,
    ) {
        super(canvas, interactive);
        this.theme = theme;
    }

    protected abstract create_painter(): PainterT;
    protected abstract create_layer_set(): ViewLayerSetT;
    protected get grid_origin(): Vec2 {
        return new Vec2(0, 0);
    }

    /**
     * Install a prepared native document-diff presentation. This is a cold
     * operation and repaints once; selecting a change must use an overlay and
     * camera update instead of calling this method.
     */
    public set_diff_presentation(
        presentation: EcadDiffPresentation | null,
    ): boolean {
        if (this.disposables.isDisposed) {
            return false;
        }
        if (
            this.#diff_presentation?.signature === presentation?.signature &&
            this.#diff_presentation === presentation
        ) {
            return false;
        }
        this.#diff_presentation = presentation;
        if (this.document) {
            this.paint();
            this.draw();
        }
        return true;
    }

    public get diff_presentation(): EcadDiffPresentation | null {
        return this.#diff_presentation;
    }

    /** Local-only benchmark counter; no data leaves the viewer. */
    public get paint_count(): number {
        return this.#paint_count;
    }

    public get presentation_cache_size(): number {
        let size = 0;
        for (const scenes of this.#presentation_scene_cache.values()) {
            size += scenes.size;
        }
        return size;
    }

    /**
     * Retain prepared display lists while a comparison session is active.
     * Switching a warm presentation then swaps layer sets instead of walking
     * and painting the document again.
     */
    public enable_presentation_cache(
        retained_overlay_channels: ReadonlySet<string> = new Set(),
    ): void {
        this.#presentation_cache_enabled = true;
        this.#retained_overlay_channels = retained_overlay_channels;
        this.#cache_current_presentation();
    }

    public disable_presentation_cache(): void {
        for (const scenes of this.#presentation_scene_cache.values()) {
            for (const scene of scenes.values()) {
                if (scene.layers !== this.layers) {
                    this.disposables.disposeAndRemove(scene.layers);
                }
            }
        }
        this.#presentation_scene_cache.clear();
        this.#presentation_cache_enabled = false;
        this.#retained_overlay_channels = new Set();
    }

    #cache_current_presentation(): void {
        if (
            !this.#presentation_cache_enabled ||
            !this.document ||
            !this.layers ||
            !this.painter ||
            !this.grid
        ) {
            return;
        }
        let scenes = this.#presentation_scene_cache.get(this.document);
        if (!scenes) {
            scenes = new Map();
            this.#presentation_scene_cache.set(this.document, scenes);
        }
        scenes.set(this.#diff_presentation, {
            layers: this.layers,
            painter: this.painter,
            grid: this.grid,
        });
    }

    #restore_cached_presentation(
        src: DocumentT,
        presentation: EcadDiffPresentation | null,
    ): boolean {
        const cached = this.#presentation_scene_cache
            .get(src)
            ?.get(presentation);
        if (!cached) return false;
        this.#cache_current_presentation();
        this.document = src;
        this.#diff_presentation = presentation;
        this.layers = cached.layers;
        this.painter = cached.painter;
        this.grid = cached.grid;
        if (this.drawing_sheet) {
            this.drawing_sheet.document = src;
        }
        this.rebind_overlay_layers(this.#retained_overlay_channels);
        this.draw();
        return true;
    }

    /**
     * Swap to an already-prepared display list without painting. Comparison
     * selection uses this to enter/leave the monochrome focus scene on a click.
     */
    public activate_cached_diff_presentation(
        presentation: EcadDiffPresentation | null,
    ): boolean {
        if (!this.document || this.disposables.isDisposed) return false;
        return this.#restore_cached_presentation(this.document, presentation);
    }

    async #load_prepared_presentation(
        src: DocumentT,
        presentation: EcadDiffPresentation | null,
    ): Promise<void> {
        await this.setup_finished;
        if (this.#restore_cached_presentation(src, presentation)) return;
        this.#cache_current_presentation();
        this.document = src;
        this.#diff_presentation = presentation;
        await this.viewport.ready;
        this.renderer.update_canvas_size();
        this.paint();
        this.draw();
    }

    /**
     * Activate a document and its prepared diff in one cold paint. Unlike
     * set_diff_presentation()+load(), this never repaints the outgoing page.
     */
    public async load_diff_document(
        src: DocumentT,
        presentation: EcadDiffPresentation,
    ): Promise<void> {
        await this.#load_prepared_presentation(src, presentation);
    }

    /** Activate a normal revision scene without repainting the outgoing page. */
    public async load_plain_document(src: DocumentT): Promise<void> {
        await this.#load_prepared_presentation(src, null);
    }

    override async load(src: DocumentT) {
        await this.setup_finished;

        if (this.document == src) {
            // Same document object can arrive before presentation is installed.
            // If a diff session is active, repaint so A/R/M is not skipped.
            if (this.#diff_presentation) {
                this.paint();
                this.draw();
            }
            return;
        }

        this.document = src;
        this.paint();

        // Wait for a valid viewport size, then re-paint. The first paint above
        // often runs before the host flex layout sizes the canvas (0×0 or the
        // browser default 300×150), which left comparison scenes blank/wrong.
        later(async () => {
            await this.viewport.ready;
            const c = this.document as unknown as any;
            this.viewport.bounds = c.bbox.grow(11);

            this.paint();

            // Position the camera and draw the scene.
            this.zoom_fit_top_item();

            // Mark the viewer as loaded and notify event listeners
            this.resolve_loaded(true);

            // Draw
            this.draw();
        });
    }

    protected override on_canvas_resize(): void {
        this.renderer.update_canvas_size();
        this.viewport.sync_from_canvas();
        // Retained WebGL document layers are world-space and survive a canvas
        // backing-store resize. Repainting here rebuilds every PCB layer for
        // each ResizeObserver tick (including every frame of a host panel
        // transition). Cold loads already perform an explicit valid-size paint
        // after viewport.ready, so settled resizes only need a draw.
        super.on_canvas_resize();
    }

    public override paint() {
        if (!this.document) {
            return;
        }
        this.#paint_count += 1;

        // Update the renderer's background color to match the theme.
        this.renderer.background_color = is_showing_design_block()
            ? Color.white
            : this.theme.background;

        // Load the default drawing sheet.
        if (!this.drawing_sheet) {
            this.drawing_sheet = DrawingSheet.default();
        }
        this.drawing_sheet.document = this.document;

        // Setup graphical layers. Skip if the host already disconnected —
        // replaceSources can race an in-flight app.load against dispose.
        if (this.disposables.isDisposed) {
            return;
        }
        const cached_current = this.#presentation_scene_cache
            .get(this.document)
            ?.get(this.#diff_presentation);
        if (
            !this.#presentation_cache_enabled ||
            cached_current?.layers === this.layers
        ) {
            this.disposables.disposeAndRemove(this.layers);
            this.#presentation_scene_cache
                .get(this.document)
                ?.delete(this.#diff_presentation);
        }
        this.layers = this.disposables.add(this.create_layer_set());
        this.rebind_overlay_layers();

        // Paint the board
        this.painter = this.create_painter();
        this.painter.diff_presentation = this.#diff_presentation;
        this.painter.paint(
            this.document,
            this.#diff_presentation?.referenceItems ?? [],
        );

        // Paint the drawing sheet
        if (!this.document.is_converted_from_ad && !is_showing_design_block())
            new DrawingSheetPainter(
                this.renderer,
                this.layers,
                this.theme,
            ).paint(this.drawing_sheet);

        // Create the grid
        this.grid = new Grid(
            this.renderer,
            this.viewport.camera,
            this.layers.by_name(ViewLayerNames.grid)!,
            this.grid_origin,
            this.theme.grid,
            this.theme.grid_axes,
        );
        this.#cache_current_presentation();
    }

    public override zoom_in() {
        this.genericZoom(true);
    }

    protected genericZoom(zoomIn: boolean) {
        this.viewport.camera.zoom *= Math.exp(
            (zoomIn ? delta : -delta) * -zoom_speed,
        );
        this.viewport.camera.zoom = Math.min(
            Viewer.MaxZoom,
            Math.max(this.viewport.camera.zoom, Viewer.MinZoom),
        );
        this.draw();
    }

    public override zoom_out() {
        this.genericZoom(false);
    }

    public override move(pos: Vec2): void {}

    public override zoom_fit_top_item() {
        this.viewport.camera.bbox = this.document.bbox.grow(
            DocumentViewer.FACTOR_zoom_fit_top_item,
        );
        this.draw();
    }

    public override get fit_zoom(): number {
        const bounds = this.document.bbox.grow(
            DocumentViewer.FACTOR_zoom_fit_top_item,
        );
        const camera = this.viewport.camera;
        const viewport = camera.fit_viewport_size;
        if (
            bounds.w <= 0 ||
            bounds.h <= 0 ||
            viewport.x <= 0 ||
            viewport.y <= 0
        ) {
            return super.fit_zoom;
        }
        return camera.zoom_for_bbox(bounds);
    }

    public override draw(): void {
        if (!this.viewport) {
            return;
        }

        this.grid?.update();

        super.draw();
    }
}

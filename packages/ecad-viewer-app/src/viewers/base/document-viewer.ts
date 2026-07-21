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

    protected static FACTOR_zoom_fit_top_item = 1.6;

    public set_drawing_sheet(sheet: DrawingSheet) {
        this.drawing_sheet = sheet;
        if (this.document) {
            this.paint();
            this.draw();
        }
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

    /**
     * Activate a document and its prepared diff in one cold paint. Unlike
     * set_diff_presentation()+load(), this never repaints the outgoing page.
     */
    public async load_diff_document(
        src: DocumentT,
        presentation: EcadDiffPresentation,
    ): Promise<void> {
        if (this.document === src && this.#diff_presentation === presentation) {
            return;
        }
        this.#diff_presentation = presentation;
        if (this.document === src) {
            this.paint();
            this.draw();
            return;
        }
        await this.load(src);
        // Concurrent project "change" loads can early-return after setting
        // document without this presentation. Always finish on the installed
        // presentation so the settled scene is never full-theme color.
        if (this.#diff_presentation !== presentation) {
            this.#diff_presentation = presentation;
        }
        await this.viewport.ready;
        this.renderer.update_canvas_size();
        this.paint();
        this.draw();
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
        if (this.document) {
            this.paint();
        }
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

        // Setup graphical layers
        this.disposables.disposeAndRemove(this.layers);
        this.layers = this.disposables.add(this.create_layer_set());
        this.rebind_overlay_layers();

        // Paint the board
        this.painter = this.create_painter();
        this.painter.diff_presentation = this.#diff_presentation;
        this.painter.paint(
            this.document,
            this.#diff_presentation?.removedItems ?? [],
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

    public override draw(): void {
        if (!this.viewport) {
            return;
        }

        this.grid?.update();

        super.draw();
    }
}

/*
    Copyright (c) 2022 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import type { CrossHightAble } from "../../base/cross_highlight_able";
import { Logger } from "../../base/log";
import { BBox, Vec2 } from "../../base/math";
import { Color, Renderer } from "../../graphics";
import { WebGL2Renderer } from "../../graphics/webgl";
import type { BoardTheme } from "../../kicad";
import * as board_items from "../../kicad/board";
import {
    BoardBBoxVisitor,
    type BoardInteractiveItem,
    Depth,
    type NetProperty,
} from "../../kicad/board_bbox_visitor";
import type { KCBoardLayersPanelElement } from "../../kicanvas/elements/kc-board/layers-panel";
import { DocumentViewer } from "../base/document-viewer";
import { KiCanvasFitterMenuEvent, KiCanvasSelectEvent } from "../base/events";
import type { VisibilityType } from "../base/view-layers";
import { ViewerType } from "../base/viewer";
import type {
    EcadOverlayAnchor,
    ResolvedOverlayAnchor,
} from "../base/overlay-scene";
import {
    LayerNames,
    LayerSet,
    ViewLayer,
} from "./layers";
import { BoardPainter } from "./painter";
import {
    diff_selection_copper_layers,
    type BoardDiffSelectionEntry,
} from "./diff-layers";
import { OrderedMap } from "immutable";
const log = new Logger("pcb:viewer");

export const ZONE_DEFAULT_OPACITY = 0.6;

export type { BoardDiffSelectionEntry } from "./diff-layers";

export class BoardViewer extends DocumentViewer<
    board_items.KicadPCB,
    BoardPainter,
    LayerSet,
    BoardTheme
> {
    #should_restore_visibility = false;
    #zones_visibility = new Map<string, VisibilityType>();
    #layer_visibility_ctrl: KCBoardLayersPanelElement;

    set layer_visibility_ctrl(ctr: KCBoardLayersPanelElement) {
        this.#layer_visibility_ctrl = ctr;
    }

    #restore_native_layers() {
        if (!this.#should_restore_visibility) return;
        const visibilities = this.layer_visibility;
        if (visibilities) {
            for (const layer of this.layers.in_ui_order()) {
                layer.visible = visibilities.get(layer.name) ?? layer.visible;
            }
        }
        this.#should_restore_visibility = false;
    }

    #restore_zone_layers() {
        for (const layer of this.layers.zone_layers()) {
            const visible = this.#zones_visibility.get(layer.name);
            if (visible !== undefined) layer.visible = visible;
        }
        this.#zones_visibility.clear();
    }

    #crossprobe:
        | { kind: "fp"; fp: board_items.Footprint }
        | { kind: "net"; num: number }
        | null = null;

    // The layer the user isolated from the layer menu, if any. Layer isolation
    // and net cross-probe both drive layers.highlight(), so clearing a
    // selection would otherwise wipe the user's isolation as a side effect.
    // Tracking it lets clear_selection restore isolation after clearing a probe.
    #isolated_layer: string | null = null;

    public highlight_net(num: number | null, emit_selection = true) {
        this.#restore_native_layers();
        this.#restore_zone_layers();
        this.#layer_visibility_ctrl?.clear_highlight();
        // Force a fresh paint even when re-applying the same net (e.g. after the
        // host tab becomes visible and WebGL selection layers need rebuilding).
        if (num != null) this.painter.filter_net = null;
        if (
            this.painter.paint_net(
                this.board,
                num,
                this.layer_visibility ?? new Map<string, boolean>(),
            )
        ) {
            if (num) {
                this.#should_restore_visibility = true;
                for (const layer of this.layers.in_ui_order()) {
                    layer.visible = false;
                }
            }
            this.draw();
        }
        if (num && emit_selection) {
            this.dispatchEvent(
                new KiCanvasSelectEvent({
                    item: {
                        net: this.board.getNetName(num),
                        ...this.#net_info.get(num),
                    },
                    previous: null,
                }),
            );
        }
    }
    protected override on_document_clicked(): void {
        // Cross-probe / Focus is sticky until Esc or an explicit clear_selection.
        // Document clicks (tab UI, 3D/SCH canvas) must not wipe a probe that was
        // just applied from another view — that was showing as "frame only".
        if (this.#crossprobe) return;

        if (this.#should_restore_visibility) {
            this.#restore_native_layers();
            this.painter.clear_interactive();
            this.draw();
        }

        if (this.#zones_visibility.size) {
            this.painter.clear_interactive();
            for (const layer of this.layers.zone_layers()) {
                layer.visible = this.#zones_visibility.get(layer.name)!;
            }
            this.#zones_visibility.clear();
            this.draw();
        }
    }

    public highlight_fp(fp: board_items.Footprint) {
        this.#crossprobe = { kind: "fp", fp };
        this.#restore_native_layers();
        if (!this.#zones_visibility.size)
            for (const layer of this.layers.zone_layers()) {
                this.#zones_visibility.set(layer.name, layer.visibility);
                layer.visible = false;
            }
        this.painter.paint_footprint(fp);
        this.draw();
    }

    /** Single-click selection: green outline only (no hatch / zone hide). */
    public outline_fp(fp: board_items.Footprint) {
        this.#crossprobe = null;
        this.#restore_native_layers();
        this.#restore_zone_layers();
        this.painter.filter_net = null;
        this.painter.outline_footprint(fp);
        this.draw();
    }

    public focus_net(num: number | null, emit_selection = true) {
        this.#crossprobe = num != null ? { kind: "net", num } : null;
        this.highlight_net(num, emit_selection);
        const net_bbox = this.painter.net_bbox;
        if (net_bbox) {
            this.viewport.camera.bbox = net_bbox.grow(
                net_bbox.w * 0.5,
                net_bbox.h * 0.5,
            );
        }
    }

    public clear_selection() {
        this.#crossprobe = null;
        this.#restore_native_layers();
        this.#restore_zone_layers();
        this.painter.filter_net = null;
        this.painter?.clear_interactive();
        // Clearing a selection or net probe must not undo the user's layer
        // isolation, which is an independent view choice made from the layer
        // menu. Re-apply it after clearing rather than dropping to no highlight.
        const isolated = this.#isolated_layer
            ? this.layers?.by_name(this.#isolated_layer)
            : null;
        this.layers?.highlight(isolated ?? null);
        this.#layer_visibility_ctrl?.update_item_states();
        this.draw();
    }

    public capture_diff_layer_visibility(): Map<string, boolean> {
        return new Map(
            Array.from(this.layers.in_ui_order(), (layer) => [
                layer.name,
                layer.visible,
            ]),
        );
    }

    /**
     * Render the selected native footprint or routing geometry over the
     * retained monochrome comparison scene. Routing focus exposes only the
     * copper layers actually used by the selected segments/vias.
     */
    public paint_diff_selection(
        entries: ReadonlyArray<BoardDiffSelectionEntry>,
        base_visibility: ReadonlyMap<string, boolean>,
    ): void {
        const routing_type_ids = new Set(["LineSegment", "ArcSegment", "Via"]);
        const routing = entries.some(
            (entry) =>
                entry.routing ||
                routing_type_ids.has(
                    (entry.item as { typeId?: string }).typeId ?? "",
                ),
        );
        const selected_layers = routing
            ? diff_selection_copper_layers(entries)
            : new Set<string>();

        for (const layer of this.layers.in_ui_order()) {
            layer.visible =
                routing && selected_layers.size
                    ? selected_layers.has(layer.name)
                    : (base_visibility.get(layer.name) ?? layer.visible);
        }
        this.#layer_visibility_ctrl?.clear_highlight();
        this.#layer_visibility_ctrl?.update_item_states();
        this.painter.paint_diff_selection(entries);
        this.draw();
    }

    /**
     * Hidden Prism tabs still receive cross-probe paints, but WebGL layers can
     * be empty until the canvas is visible. Re-bake the last probe on activate.
     */
    public override set_active(active: boolean) {
        super.set_active(active);
        if (!active || !this.#crossprobe) return;
        // Defer one frame so any document-click handlers from the tab switch
        // run first; then re-bake Focus/hatch on a visible canvas.
        const probe = this.#crossprobe;
        requestAnimationFrame(() => {
            if (this.#crossprobe !== probe) return;
            if (probe.kind === "fp") {
                this.highlight_fp(probe.fp);
                return;
            }
            this.painter.filter_net = null;
            this.highlight_net(probe.num, false);
            const net_bbox = this.painter.net_bbox;
            if (net_bbox) {
                this.viewport.camera.bbox = net_bbox.grow(
                    net_bbox.w * 0.5,
                    net_bbox.h * 0.5,
                );
            }
        });
    }

    #resolve_footprint(item: unknown): board_items.Footprint | null {
        let node = item as
            | { typeId?: string; parent?: unknown }
            | null
            | undefined;
        for (let i = 0; node && i < 8; i++) {
            if (node.typeId === "Footprint")
                return node as unknown as board_items.Footprint;
            node = node.parent as typeof node;
        }
        return null;
    }

    override on_click(pos: Vec2, event?: MouseEvent): void {
        const items = this.find_items_under_pos(pos);

        if (items.length > 0) {
            if (items.length == 1) {
                const it = items[0];
                if (it) {
                    // Outline only when the hit is the footprint itself — pad/track
                    // single-click is panel selection without component outline.
                    if (
                        it.item &&
                        (it.item as { typeId?: string }).typeId === "Footprint"
                    ) {
                        this.outline_fp(it.item as board_items.Footprint);
                    }
                    this.dispatchEvent(
                        new KiCanvasSelectEvent({
                            item: it.item,
                            previous: null,
                            intent: "select",
                        }),
                    );
                    this.dispatchEvent(
                        new KiCanvasFitterMenuEvent({
                            items: [],
                        }),
                    );
                }
            } else {
                this.dispatchEvent(
                    new KiCanvasSelectEvent({
                        item: null,
                        previous: null,
                        intent: "select",
                    }),
                );
                this.dispatchEvent(
                    new KiCanvasFitterMenuEvent({
                        items: items,
                    }),
                );
            }
        } else {
            // Truly empty click (nothing under the cursor): emit an empty
            // selection so the host can deselect. Previously nothing was
            // dispatched here, so a click on bare board left the selection stuck.
            this.dispatchEvent(
                new KiCanvasSelectEvent({
                    item: null,
                    previous: null,
                    intent: "select",
                }),
            );
        }
    }

    get layer_visibility() {
        return this.#layer_visibility_ctrl?.visibilities ?? null;
    }

    find_items_under_pos(pos: Vec2) {
        const items: BoardInteractiveItem[] = [];

        if (!this.#layer_visibility_ctrl) return items;

        // When one or more layers are isolated (highlighted from the layer
        // menu), only items on those layers are selectable. Otherwise a click
        // could still land on a dimmed trace on another layer, e.g. picking an
        // F.Cu trace while B.Cu is isolated. Fall back to plain layer
        // visibility when nothing is isolated.
        const highlighted_layers = new Set(
            this.layers.highlighted_layer_names(),
        );

        const visible_layers: Set<string> = new Set();
        for (const [k, v] of this.layer_visibility)
            if (v) visible_layers.add(k);

        const is_item_visible = (item: BoardInteractiveItem) => {
            // Isolation restricts selection to items that actually live on an
            // isolated layer. This uses the true layer set (on_layers), not the
            // loose is_on_layer, so a footprint or pad on the opposite side is
            // not selectable just because is_on_layer answers permissively.
            if (highlighted_layers.size) {
                for (const layer of item.on_layers())
                    if (highlighted_layers.has(layer)) return true;
                return false;
            }
            // No isolation: unchanged permissive picking against visible layers.
            for (const layer of visible_layers)
                if (item.is_on_layer(layer)) return true;
            return false;
        };

        const check_depth = (depth: Depth) => {
            const layer_items = this.#interactive.get(depth) ?? [];
            if (layer_items.length)
                for (const i of layer_items) {
                    if (i.contains(pos) && is_item_visible(i)) {
                        items.push(i);
                    }
                }
        };

        for (const [depth] of this.#interactive) {
            switch (depth) {
                case Depth.GRAPHICS:
                    break;
                case Depth.VIA:
                case Depth.PAD:
                case Depth.LINE_SEGMENTS:
                    check_depth(depth);
                    break;
                case Depth.FOOT_PRINT:
                case Depth.ZONE:
                    break;
            }
        }

        // look up the footprints then
        if (!items.length) check_depth(Depth.FOOT_PRINT);

        // look up the zones finally
        if (!items.length) check_depth(Depth.ZONE);

        return items;
    }

    override on_dblclick(pos: Vec2): void {
        const items = this.find_items_under_pos(pos);
        if (items.length === 0) return;
        const it = items[0]!;

        // Pad / track / via / zone → net cross-probe (dimmed copper + host event).
        if (it.net) {
            this.focus_net(it.net, false);
            this.dispatchEvent(
                new KiCanvasSelectEvent({
                    item: {
                        net: this.board.getNetName(it.net),
                        ...this.#net_info.get(it.net),
                    },
                    previous: null,
                    intent: "crossprobe",
                }),
            );
            return;
        }

        const fp = this.#resolve_footprint(it.item);
        if (fp) {
            this.painter.filter_net = null;
            this.highlight_fp(fp);
            const b = fp.bbox;
            this.viewport.camera.bbox = b.grow(
                Math.max(b.w * 0.5, 4),
                Math.max(b.h * 0.5, 4),
            );
            this.draw();
            this.dispatchEvent(
                new KiCanvasSelectEvent({
                    item: fp,
                    previous: null,
                    intent: "crossprobe",
                }),
            );
        }
    }
    override type: ViewerType = ViewerType.PCB;

    #interactive: OrderedMap<Depth, BoardInteractiveItem[]> = OrderedMap();

    #net_info: Map<number, NetProperty>;

    #last_hover: BoardInteractiveItem | null = null;

    #highlighted_track = true;
    #overlay_item_bounds = new Map<string, BBox>();

    set_highlighted_track(val: boolean) {
        this.#highlighted_track = val;
    }

    /**
     * Returns the bounding box for an interactive board item by uuid/tstamp,
     * as captured while loading the board. Useful for host adapters that
     * need to enrich selection or overlay data with world-space bounds.
     */
    public overlay_item_bounds(uuid: string): BBox | undefined {
        return this.#overlay_item_bounds.get(uuid);
    }

    public get_host_view_state() {
        const layers = this.layers as LayerSet;
        const first_opacity = (items: Generator<ViewLayer>) =>
            items.next().value?.opacity ?? 1;
        const any_visible = (items: Generator<ViewLayer>) =>
            Array.from(items).some((layer) => (layer.opacity ?? 1) > 0);
        return {
            layers: Array.from(layers.in_ui_order()).map((layer) => ({
                name: layer.name,
                color: layer.color.to_css(),
                visible: layer.visible,
                highlighted: layer.highlighted,
            })),
            objectOpacity: {
                tracks: first_opacity(layers.copper_layers()),
                vias: first_opacity(layers.via_layers()),
                pads: first_opacity(layers.pad_layers()),
                zones: first_opacity(layers.zone_layers()),
            },
            objectVisibility: {
                references: any_visible(layers.fp_reference_txt_layers()),
                values: any_visible(layers.fp_value_txt_layers()),
                footprintText: any_visible(layers.fp_txt_layers()),
                hiddenText: any_visible(layers.hidden_txt_layers()),
            },
            highlightTracks: this.#highlighted_track,
        };
    }

    public set_host_layer_visibility(name: string, visible: boolean) {
        const layer = this.layers.by_name(name);
        if (!layer || !Array.from(this.layers.in_ui_order()).includes(layer))
            return false;
        layer.visible = visible;
        if (!visible && layer.highlighted) {
            this.layers.highlight(null);
            if (this.#isolated_layer === name) this.#isolated_layer = null;
        }
        this.#layer_visibility_ctrl?.update_item_states();
        this.draw();
        return true;
    }

    public set_host_layer_highlight(name: string | null) {
        if (!name) {
            this.layers.highlight(null);
            this.#isolated_layer = null;
            this.#layer_visibility_ctrl?.update_item_states();
            this.draw();
            return true;
        }
        const layer = this.layers.by_name(name);
        if (!layer || !Array.from(this.layers.in_ui_order()).includes(layer))
            return false;
        const next = layer.highlighted ? null : layer;
        this.layers.highlight(next);
        this.#isolated_layer = next ? name : null;
        if (next) next.visible = true;
        this.#layer_visibility_ctrl?.update_item_states();
        this.draw();
        return true;
    }

    public apply_host_layer_preset(
        preset:
            | "front"
            | "back"
            | "copper"
            | "outer-copper"
            | "inner-copper"
            | "drawings"
            | "all"
            | "none",
    ) {
        for (const layer of this.layers.in_ui_order()) {
            switch (preset) {
                case "front":
                    layer.visible =
                        layer.name.startsWith("F.") ||
                        layer.name === LayerNames.edge_cuts;
                    break;
                case "back":
                    layer.visible =
                        layer.name.startsWith("B.") ||
                        layer.name === LayerNames.edge_cuts;
                    break;
                case "copper":
                    layer.visible =
                        layer.name.endsWith(".Cu") ||
                        layer.name === LayerNames.edge_cuts;
                    break;
                case "outer-copper":
                    layer.visible =
                        layer.name === LayerNames.f_cu ||
                        layer.name === LayerNames.b_cu ||
                        layer.name === LayerNames.edge_cuts;
                    break;
                case "inner-copper":
                    layer.visible =
                        (layer.name.endsWith(".Cu") &&
                            layer.name !== LayerNames.f_cu &&
                            layer.name !== LayerNames.b_cu) ||
                        layer.name === LayerNames.edge_cuts;
                    break;
                case "drawings":
                    layer.visible =
                        !layer.name.endsWith(".Cu") &&
                        !layer.name.endsWith(".Mask") &&
                        !layer.name.endsWith(".Paste") &&
                        !layer.name.endsWith(".Adhes");
                    break;
                case "all":
                    layer.visible = true;
                    break;
                case "none":
                    layer.visible = false;
                    break;
            }
        }
        this.layers.highlight(null);
        this.#layer_visibility_ctrl?.update_item_states();
        this.draw();
    }

    public set_host_object_opacity(
        kind: "tracks" | "vias" | "pads" | "zones",
        opacity: number,
    ) {
        const value = Math.max(0, Math.min(1, opacity));
        switch (kind) {
            case "tracks":
                this.track_opacity = value;
                break;
            case "vias":
                this.via_opacity = value;
                break;
            case "pads":
                this.pad_opacity = value;
                break;
            case "zones":
                this.zone_opacity = value;
                break;
        }
    }

    public set_host_object_visibility(
        kind: "references" | "values" | "footprintText" | "hiddenText",
        visible: boolean,
    ) {
        const layers = this.layers as LayerSet;
        const opacity = visible ? 1 : 0;
        const set = (items: Generator<ViewLayer>) => {
            for (const layer of items) layer.opacity = opacity;
        };
        switch (kind) {
            case "references":
                set(layers.fp_reference_txt_layers());
                break;
            case "values":
                set(layers.fp_value_txt_layers());
                break;
            case "footprintText":
                set(layers.fp_txt_layers());
                break;
            case "hiddenText":
                set(layers.hidden_txt_layers());
                break;
        }
        this.draw();
    }

    public set_host_track_highlight(enabled: boolean) {
        this.set_highlighted_track(enabled);
        this.draw();
    }

    get board(): board_items.KicadPCB {
        return this.document;
    }

    override async load(src: board_items.KicadPCB) {
        try {
            const visitor = new BoardBBoxVisitor();
            visitor.visit(src);
            this.#overlay_item_bounds.clear();

            for (let k = Depth.START; k < Depth.END; k++)
                this.#interactive = this.#interactive.set(k, []);

            for (const e of visitor.interactive_items) {
                this.#interactive.get(e.depth)?.push(e);
                const uuid =
                    e.item && "uuid" in e.item
                        ? e.item.uuid
                        : e.item && "tstamp" in e.item
                          ? e.item.tstamp
                          : undefined;
                if (uuid) this.#overlay_item_bounds.set(uuid, e.item!.bbox);
            }
            this.#net_info = visitor.net_info;
        } catch (e) {
            log.warn(`BoardBBoxVisitor error :${e}`);
        }
        await super.load(src);
    }

    protected override resolve_overlay_anchor(
        anchor: EcadOverlayAnchor,
    ): ResolvedOverlayAnchor | null {
        if (anchor.kind === "source-item") {
            const bounds = this.#overlay_item_bounds.get(anchor.uuid);
            return bounds
                ? { point: bounds.center, bounds, page: anchor.page }
                : null;
        }
        if (anchor.kind === "entity" && anchor.reference) {
            const footprint = this.board.find_footprint(anchor.reference);
            const bounds = footprint?.bbox;
            return bounds
                ? { point: bounds.center, bounds, page: anchor.page }
                : null;
        }
        return null;
    }

    protected override create_renderer(canvas: HTMLCanvasElement): Renderer {
        const renderer = new WebGL2Renderer(canvas);
        renderer.background_color = Color.gray;
        return renderer;
    }

    protected override create_painter() {
        return new BoardPainter(this.renderer, this.layers, this.theme);
    }

    protected override create_layer_set() {
        const layers = new LayerSet(this.board, this.theme);

        for (const zone of layers.zone_layers())
            zone.opacity = ZONE_DEFAULT_OPACITY;

        for (const it of layers.hidden_txt_layers()) {
            it.opacity = 0;
        }

        return layers;
    }

    protected override get grid_origin() {
        return new Vec2(0, 0);
    }

    private set_layers_opacity(layers: Generator<ViewLayer>, opacity: number) {
        for (const layer of layers) {
            layer.opacity = opacity;
        }
        this.draw();
    }

    set track_opacity(value: number) {
        this.set_layers_opacity(
            (this.layers as LayerSet).copper_layers(),
            value,
        );
    }

    set via_opacity(value: number) {
        this.set_layers_opacity((this.layers as LayerSet).via_layers(), value);
    }

    set zone_opacity(value: number) {
        this.set_layers_opacity((this.layers as LayerSet).zone_layers(), value);
    }

    set pad_opacity(value: number) {
        const st = this.layers as LayerSet;

        for (const it of [st.pad_layers(), st.pad_hole_layers()])
            this.set_layers_opacity(it, value);
    }

    set grid_opacity(value: number) {
        this.set_layers_opacity((this.layers as LayerSet).grid_layers(), value);
    }

    set page_opacity(value: number) {
        this.layers.by_name(LayerNames.drawing_sheet)!.opacity = value;
        this.draw();
    }

    zoom_to_board() {
        const edge_cuts = this.layers.by_name(LayerNames.edge_cuts)!;
        const board_bbox = edge_cuts.bbox;
        this.viewport.camera.bbox = board_bbox.grow(board_bbox.w * 0.1);
    }

    findHighlightItem(pos: Vec2): CrossHightAble | null {
        return null;
    }

    findInteractive(pos: Vec2) {
        if (!this.#layer_visibility_ctrl) return null;

        const visible_layers: Set<string> = new Set();
        for (const [k, v] of this.layer_visibility)
            if (v) visible_layers.add(k);

        const is_item_visible = (item: BoardInteractiveItem) => {
            for (const layer of visible_layers)
                if (item.is_on_layer(layer)) return true;

            return false;
        };

        for (const [, v] of this.#interactive) {
            for (const e of v) {
                if (e.contains(pos) && is_item_visible(e)) {
                    return e;
                }
            }
        }
        return null;
    }

    override on_hover(_pos: Vec2) {
        const hover_item = this.findInteractive(_pos);

        if (hover_item === this.#last_hover) return;

        this.#last_hover = hover_item;

        if (
            !this.#highlighted_track &&
            hover_item?.depth === Depth.LINE_SEGMENTS
        )
            return;

        this.painter.highlight(hover_item);
        this.draw();
    }
}

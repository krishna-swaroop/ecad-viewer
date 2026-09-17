/*
    Zoom-driven net-name / pad-number label layers.

    The board scene is retained: `DocumentPainter` tessellates every layer once
    and `on_draw` only re-renders them with the camera matrix. Labels are the
    one board element with per-item zoom gates (KiCad's `ViewGetLOD`), so they
    get their own small dynamic layers, rebuilt the way `Grid` rebuilds the
    grid: only when the camera leaves the last cached region, a zoom threshold
    is crossed, or an option changes. Panning inside the region and zooming
    between thresholds cost nothing.
*/

import { BBox, Camera2 } from "../../base/math";
import { Renderer } from "../../graphics";
import { KicadPCB } from "../../kicad";
import * as board_items from "../../kicad/board";
import { CopperLayerNames, LayerNames, LayerSet, ViewLayer } from "./layers";
import {
    DEFAULT_NET_LABEL_OPTIONS,
    MIN_GLYPH_PX,
    arc_label_layout,
    display_net_name,
    draw_label,
    min_glyph_height,
    pad_label_layer,
    pad_label_layout,
    pad_label_min_zoom,
    segment_label_layouts,
    track_label_min_zoom,
    via_label_layout,
    via_label_min_zoom,
    type LabelLayout,
    type NetLabelOptions,
} from "./net-label-painter";

type Candidate =
    | {
          kind: "pad";
          layer: string;
          min_zoom: number;
          bbox: BBox;
          pad: board_items.Pad;
      }
    | {
          kind: "segment";
          layer: string;
          min_zoom: number;
          bbox: BBox;
          segment: board_items.LineSegment;
          name: string;
      }
    | {
          kind: "arc";
          layer: string;
          min_zoom: number;
          bbox: BBox;
          arc: board_items.ArcSegment;
          name: string;
      }
    | {
          kind: "via";
          layer: string;
          min_zoom: number;
          bbox: BBox;
          via: board_items.Via;
          name: string;
      };

function segment_bbox(
    a: { x: number; y: number },
    b: { x: number; y: number },
    width: number,
) {
    const r = width / 2;
    return new BBox(
        Math.min(a.x, b.x) - r,
        Math.min(a.y, b.y) - r,
        Math.abs(b.x - a.x) + width,
        Math.abs(b.y - a.y) + width,
    );
}

function bbox_intersects(a: BBox, b: BBox): boolean {
    return a.x <= b.x2 && a.x2 >= b.x && a.y <= b.y2 && a.y2 >= b.y;
}

export class NetLabelLayers {
    #candidates: Candidate[] = [];
    #layers: ViewLayer[] = [];
    #copper_count = 0;
    #built = false;

    #last_region: BBox | null = null;
    #last_visible_count = -1;
    #last_options: NetLabelOptions | null = null;
    #last_copper_visible = false;

    #options: NetLabelOptions = { ...DEFAULT_NET_LABEL_OPTIONS };

    constructor(
        public gfx: Renderer,
        public camera: Camera2,
        public board: KicadPCB,
        public layer_set: LayerSet,
    ) {}

    get options(): Readonly<NetLabelOptions> {
        return this.#options;
    }

    set options(value: NetLabelOptions) {
        this.#options = { ...value };
    }

    /** Drop every label layer's graphics and force the next update to rebuild. */
    reset(): void {
        for (const layer of this.#layers) {
            layer.graphics?.dispose();
            layer.graphics = undefined;
        }
        this.#last_region = null;
        this.#last_visible_count = -1;
        this.#last_options = null;
    }

    /**
     * Bring the label layers up to date with the camera and options. Cheap
     * when nothing relevant changed; call it before every draw.
     */
    update(): void {
        if (!this.#built) this.#build_candidates();

        const copper_visible = this.layer_set.is_any_copper_layer_visible();
        if (!copper_visible) {
            if (this.#last_copper_visible) this.reset();
            this.#last_copper_visible = false;
            return;
        }
        this.#last_copper_visible = true;

        const zoom = this.camera.zoom;
        const viewport = this.camera.bbox;
        const visible_count = this.#visible_count(zoom);
        const options = this.#options;

        if (
            this.#last_region &&
            this.#last_visible_count === visible_count &&
            this.#last_region.contains(viewport) &&
            this.#last_options &&
            this.#last_options.padNumbers === options.padNumbers &&
            this.#last_options.padNetNames === options.padNetNames &&
            this.#last_options.trackNetNames === options.trackNetNames
        ) {
            return;
        }

        // Grow the region well beyond the viewport so panning stays inside
        // the cached labels and does not re-tessellate every frame.
        const region = viewport.grow(viewport.w * 1.5, viewport.h * 1.5);
        this.#last_region = region;
        this.#last_visible_count = visible_count;
        this.#last_options = { ...options };

        this.#repaint(zoom, region, visible_count, options);
    }

    /** Layout every label that would be drawn right now, for tests and tools. */
    layouts(): Map<string, LabelLayout[]> {
        if (!this.#built) this.#build_candidates();
        const zoom = this.camera.zoom;
        const viewport = this.camera.bbox;
        const region = viewport.grow(viewport.w * 1.5, viewport.h * 1.5);
        const out = new Map<string, LabelLayout[]>();
        const count = this.#visible_count(zoom);
        for (let i = 0; i < count; i++) {
            const candidate = this.#candidates[i]!;
            if (!bbox_intersects(candidate.bbox, region)) continue;
            const layouts = this.#layouts_for(
                candidate,
                zoom,
                region,
                this.#options,
            );
            if (layouts.length === 0) continue;
            const list = out.get(candidate.layer) ?? [];
            list.push(...layouts);
            out.set(candidate.layer, list);
        }
        return out;
    }

    #build_candidates(): void {
        this.#built = true;
        this.#layers = Array.from(this.layer_set.netname_layers()).filter(
            (layer) => layer !== undefined,
        );
        const layer_names = new Set(this.#layers.map((layer) => layer.name));

        this.#copper_count = this.board.layers.filter((layer) =>
            CopperLayerNames.includes(layer.canonical_name as LayerNames),
        ).length;

        const candidates: Candidate[] = [];

        for (const fp of this.board.footprints) {
            for (const pad of fp.pads) {
                if (!pad.number && !pad.net?.name) continue;
                const layer = pad_label_layer(pad);
                if (!layer || !layer_names.has(layer)) continue;
                const bbox = pad.bbox;
                if (!bbox.valid) continue;
                const layout = pad_label_layout(pad, true, true);
                if (!layout) continue;
                candidates.push({
                    kind: "pad",
                    layer,
                    min_zoom: Math.max(
                        pad_label_min_zoom(pad),
                        MIN_GLYPH_PX / min_glyph_height(layout),
                    ),
                    bbox,
                    pad,
                });
            }
        }

        const copper_label_layer = (layer: string) => `:${layer}:NetNames`;

        for (const item of this.board.segments) {
            const name = this.#net_name(item.net);
            if (!name) continue;
            const layer = copper_label_layer(item.layer);
            if (!layer_names.has(layer)) continue;
            const min_zoom = Math.max(
                track_label_min_zoom(item.width),
                MIN_GLYPH_PX / (item.width * 0.55),
            );
            if (item instanceof board_items.ArcSegment) {
                candidates.push({
                    kind: "arc",
                    layer,
                    min_zoom,
                    bbox: BBox.from_points([
                        item.start,
                        item.mid,
                        item.end,
                    ]).grow(item.width),
                    arc: item,
                    name,
                });
            } else {
                candidates.push({
                    kind: "segment",
                    layer,
                    min_zoom,
                    bbox: segment_bbox(item.start, item.end, item.width),
                    segment: item,
                    name,
                });
            }
        }

        if (layer_names.has(LayerNames.via_netnames)) {
            for (const via of this.board.vias) {
                const name = this.#net_name(via.net);
                if (!name && via.type === "through-hole") continue;
                const layout = via_label_layout(
                    via,
                    name,
                    this.#copper_count,
                    true,
                );
                if (!layout) continue;
                candidates.push({
                    kind: "via",
                    layer: LayerNames.via_netnames,
                    min_zoom: Math.max(
                        via_label_min_zoom(via),
                        MIN_GLYPH_PX / min_glyph_height(layout),
                    ),
                    bbox: new BBox(
                        via.at.position.x - via.size / 2,
                        via.at.position.y - via.size / 2,
                        via.size,
                        via.size,
                    ),
                    via,
                    name,
                });
            }
        }

        candidates.sort((a, b) => a.min_zoom - b.min_zoom);
        this.#candidates = candidates;
    }

    #net_name(net: number | undefined): string {
        if (!net || net <= 0) return "";
        return display_net_name(this.board.getNetName(net));
    }

    /** Number of leading candidates whose zoom gate passes (sorted ascending). */
    #visible_count(zoom: number): number {
        let lo = 0;
        let hi = this.#candidates.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (this.#candidates[mid]!.min_zoom <= zoom) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    #layouts_for(
        candidate: Candidate,
        zoom: number,
        region: BBox,
        options: NetLabelOptions,
    ): LabelLayout[] {
        switch (candidate.kind) {
            case "pad": {
                if (!options.padNumbers && !options.padNetNames) return [];
                const layout = pad_label_layout(
                    candidate.pad,
                    options.padNumbers,
                    options.padNetNames,
                );
                if (!layout) return [];
                // With one string hidden the other grows; re-check legibility.
                if (min_glyph_height(layout) * zoom < MIN_GLYPH_PX) return [];
                return [layout];
            }
            case "segment":
                if (!options.trackNetNames) return [];
                return segment_label_layouts(
                    candidate.segment.start,
                    candidate.segment.end,
                    candidate.segment.width,
                    candidate.name,
                    region,
                );
            case "arc":
                if (!options.trackNetNames) return [];
                return arc_label_layout(candidate.arc, candidate.name, region);
            case "via": {
                const show_layers = candidate.via.type !== "through-hole";
                if (!options.trackNetNames && !show_layers) return [];
                const layout = via_label_layout(
                    candidate.via,
                    candidate.name,
                    this.#copper_count,
                    options.trackNetNames,
                );
                if (!layout) return [];
                if (min_glyph_height(layout) * zoom < MIN_GLYPH_PX) return [];
                return [layout];
            }
        }
    }

    #repaint(
        zoom: number,
        region: BBox,
        visible_count: number,
        options: NetLabelOptions,
    ): void {
        const by_layer = new Map<string, LabelLayout[]>();
        for (let i = 0; i < visible_count; i++) {
            const candidate = this.#candidates[i]!;
            if (!bbox_intersects(candidate.bbox, region)) continue;
            const layouts = this.#layouts_for(candidate, zoom, region, options);
            if (layouts.length === 0) continue;
            let list = by_layer.get(candidate.layer);
            if (!list) {
                list = [];
                by_layer.set(candidate.layer, list);
            }
            list.push(...layouts);
        }

        for (const layer of this.#layers) {
            layer.graphics?.dispose();
            layer.graphics = undefined;

            const layouts = by_layer.get(layer.name);
            if (!layouts || layouts.length === 0) continue;

            this.gfx.start_layer(layer.name);
            for (const layout of layouts) {
                draw_label(this.gfx, layout, layer.color);
            }
            layer.graphics = this.gfx.end_layer();
        }
    }
}

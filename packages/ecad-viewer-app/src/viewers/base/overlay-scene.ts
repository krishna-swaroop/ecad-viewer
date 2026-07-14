import { BBox, Vec2 } from "../../base/math";
import { Color, Polygon, Polyline, type Renderer } from "../../graphics";
import { StrokeFont, TextAttributes } from "../../kicad/text";
import type { ExtensionLayerPlacement, ViewLayerSet } from "./view-layers";

export type EcadOverlayContext = "SCH" | "PCB";
export type EcadOverlayPlacement = ExtensionLayerPlacement;

export type EcadOverlayAnchor =
    | { kind: "world"; x: number; y: number; page?: string }
    | { kind: "bbox"; bounds: [number, number, number, number]; page?: string }
    | { kind: "source-item"; uuid: string; page?: string }
    | {
          kind: "entity";
          reference?: string;
          net?: string;
          pin?: string;
          page?: string;
      };

export type EcadOverlayStyle = {
    sizing?: "world" | "screen";
    stroke?: string;
    fill?: string;
    opacity?: number;
    strokeWidth?: number;
    dash?: number[];
    blend?: GlobalCompositeOperation;
};

type OverlayPrimitiveBase = EcadOverlayStyle & {
    id: string;
    anchor: EcadOverlayAnchor;
    interactive?: boolean;
    metadata?: unknown;
    accessibilityLabel?: string;
};

export type MarkerPrimitive = OverlayPrimitiveBase & {
    kind: "marker";
    radius?: number;
};
export type BBoxPrimitive = OverlayPrimitiveBase & {
    kind: "bbox";
    padding?: number;
};
export type PolylinePrimitive = OverlayPrimitiveBase & {
    kind: "polyline";
    points: Array<[number, number]>;
};
export type PolygonPrimitive = OverlayPrimitiveBase & {
    kind: "polygon";
    points: Array<[number, number]>;
};
export type TextPrimitive = OverlayPrimitiveBase & {
    kind: "text";
    text: string;
    size?: number;
};

export type EcadOverlayPrimitive =
    | MarkerPrimitive
    | BBoxPrimitive
    | PolylinePrimitive
    | PolygonPrimitive
    | TextPrimitive;

export type EcadOverlayScene = {
    channelId: string;
    context: EcadOverlayContext;
    placement: EcadOverlayPlacement;
    visible: boolean;
    primitives: EcadOverlayPrimitive[];
};

export type ResolvedOverlayAnchor = {
    point: Vec2;
    bounds?: BBox;
    page?: string;
};

export type OverlayAnchorResolver = (
    anchor: EcadOverlayAnchor,
) => ResolvedOverlayAnchor | null;

export type OverlayHit = {
    channelId: string;
    primitiveId: string;
    resolvedAnchor: {
        x: number;
        y: number;
        bounds?: [number, number, number, number];
        page?: string;
    };
    context: EcadOverlayContext;
    metadata?: unknown;
};

type CompiledPrimitive = {
    scene: EcadOverlayScene;
    primitive: EcadOverlayPrimitive;
    anchor: ResolvedOverlayAnchor;
    bounds: BBox;
};

const GRID_SIZE = 20;

export class OverlaySceneManager {
    #scenes = new Map<string, { signature: string; scene: EcadOverlayScene }>();
    #compiled = new Map<string, CompiledPrimitive[]>();
    #hit_grid = new Map<string, CompiledPrimitive[]>();
    #last_zoom = 0;

    constructor(
        private readonly renderer: Renderer,
        private layers: ViewLayerSet,
        private readonly resolve_anchor: OverlayAnchorResolver,
        private readonly get_zoom: () => number,
    ) {}

    replace_layers(layers: ViewLayerSet) {
        if (this.layers === layers) return;
        this.layers = layers;
        for (const { scene } of this.#scenes.values()) this.#compile(scene);
        this.#rebuild_hit_grid();
    }

    set_scene(scene: EcadOverlayScene): boolean {
        const signature = JSON.stringify(scene);
        if (this.#scenes.get(scene.channelId)?.signature === signature)
            return false;
        this.layers.clear_extension_layer(scene.channelId);
        this.#scenes.set(scene.channelId, { signature, scene });
        this.#compile(scene);
        this.#rebuild_hit_grid();
        return true;
    }

    clear_scene(channel_id: string): boolean {
        if (!this.#scenes.delete(channel_id)) return false;
        this.#compiled.delete(channel_id);
        this.layers.clear_extension_layer(channel_id);
        this.#rebuild_hit_grid();
        return true;
    }

    refresh_screen_sized(): boolean {
        const zoom = this.get_zoom() || 1;
        if (Math.abs(zoom - this.#last_zoom) < 0.0001) return false;
        this.#last_zoom = zoom;
        let changed = false;
        for (const { scene } of this.#scenes.values()) {
            if (
                !scene.primitives.some(
                    (primitive) => primitive.sizing === "screen",
                )
            )
                continue;
            this.layers.clear_extension_layer(scene.channelId);
            this.#compile(scene);
            changed = true;
        }
        if (changed) this.#rebuild_hit_grid();
        return changed;
    }

    hit_test(point: Vec2): OverlayHit | null {
        const candidates = this.#hit_grid.get(this.#grid_key(point)) ?? [];
        for (let index = candidates.length - 1; index >= 0; index--) {
            const hit = candidates[index]!;
            if (!hit.bounds.contains_point(point)) continue;
            return this.#event_payload(hit);
        }
        return null;
    }

    #compile(scene: EcadOverlayScene) {
        const compiled: CompiledPrimitive[] = [];
        if (!scene.visible) {
            this.#compiled.set(scene.channelId, compiled);
            return;
        }
        const layer = this.layers.extension_layer(
            scene.channelId,
            scene.placement,
        );
        this.renderer.start_layer(layer.name);
        for (const primitive of scene.primitives) {
            const anchor = this.#resolve(primitive.anchor);
            if (!anchor) continue;
            const bounds = this.#paint(primitive, anchor);
            if (primitive.interactive)
                compiled.push({ scene, primitive, anchor, bounds });
        }
        layer.graphics = this.renderer.end_layer();
        layer.graphics.composite_operation =
            scene.primitives.find((primitive) => primitive.blend)?.blend ??
            "source-over";
        this.#compiled.set(scene.channelId, compiled);
    }

    #resolve(anchor: EcadOverlayAnchor): ResolvedOverlayAnchor | null {
        if (anchor.kind === "world") {
            return { point: new Vec2(anchor.x, anchor.y), page: anchor.page };
        }
        if (anchor.kind === "bbox") {
            const bounds = new BBox(...anchor.bounds);
            return { point: bounds.center, bounds, page: anchor.page };
        }
        return this.resolve_anchor(anchor);
    }

    #paint(
        primitive: EcadOverlayPrimitive,
        anchor: ResolvedOverlayAnchor,
    ): BBox {
        const zoom = Math.max(this.get_zoom() || 1, 0.0001);
        const scale = primitive.sizing === "screen" ? 1 / zoom : 1;
        const opacity = primitive.opacity ?? 1;
        const stroke = Color.from_css(
            primitive.stroke ?? "#3388ffff",
        ).with_alpha(opacity);
        const fill = Color.from_css(primitive.fill ?? "#3388ff33").with_alpha(
            opacity,
        );
        const width = (primitive.strokeWidth ?? 0.25) * scale;
        if (primitive.kind === "marker") {
            const radius = (primitive.radius ?? 4) * scale;
            this.renderer.circle(anchor.point, radius, fill);
            return new BBox(
                anchor.point.x - radius,
                anchor.point.y - radius,
                radius * 2,
                radius * 2,
            );
        }
        if (primitive.kind === "bbox") {
            const padding = (primitive.padding ?? 0) * scale;
            const bounds = (
                anchor.bounds ?? new BBox(anchor.point.x, anchor.point.y, 0, 0)
            ).grow(padding);
            if ((primitive.fill ?? "") !== "")
                this.renderer.polygon(Polygon.from_BBox(bounds, fill));
            this.renderer.line(Polyline.from_BBox(bounds, width, stroke));
            return bounds.grow(width);
        }
        if (primitive.kind === "polyline") {
            const points = primitive.points.map(([x, y]) =>
                anchor.point.add(new Vec2(x, y)),
            );
            this.renderer.line(new Polyline(points, width, stroke));
            return BBox.from_points(points).grow(width);
        }
        if (primitive.kind === "polygon") {
            const points = primitive.points.map(([x, y]) =>
                anchor.point.add(new Vec2(x, y)),
            );
            this.renderer.polygon(new Polygon(points, fill));
            if (points.length)
                this.renderer.line(
                    new Polyline([...points, points[0]!], width, stroke),
                );
            return BBox.from_points(points).grow(width);
        }
        const size = (primitive.size ?? 2) * scale;
        const attributes = new TextAttributes();
        attributes.size = new Vec2(size, size);
        attributes.stroke_width = Math.max(width, size * 0.08);
        attributes.color = stroke;
        StrokeFont.default().draw(
            this.renderer,
            primitive.text,
            anchor.point,
            attributes,
        );
        return new BBox(
            anchor.point.x - size,
            anchor.point.y - size,
            size * Math.max(2, primitive.text.length),
            size * 2,
        );
    }

    #grid_key(point: Vec2) {
        return `${Math.floor(point.x / GRID_SIZE)}:${Math.floor(point.y / GRID_SIZE)}`;
    }

    #rebuild_hit_grid() {
        this.#hit_grid.clear();
        for (const compiled of this.#compiled.values()) {
            for (const hit of compiled) {
                const min_x = Math.floor(hit.bounds.x / GRID_SIZE);
                const max_x = Math.floor(hit.bounds.x2 / GRID_SIZE);
                const min_y = Math.floor(hit.bounds.y / GRID_SIZE);
                const max_y = Math.floor(hit.bounds.y2 / GRID_SIZE);
                for (let x = min_x; x <= max_x; x++) {
                    for (let y = min_y; y <= max_y; y++) {
                        const key = `${x}:${y}`;
                        const bucket = this.#hit_grid.get(key) ?? [];
                        bucket.push(hit);
                        this.#hit_grid.set(key, bucket);
                    }
                }
            }
        }
    }

    #event_payload(hit: CompiledPrimitive): OverlayHit {
        const bounds = hit.anchor.bounds;
        return {
            channelId: hit.scene.channelId,
            primitiveId: hit.primitive.id,
            context: hit.scene.context,
            metadata: hit.primitive.metadata,
            resolvedAnchor: {
                x: hit.anchor.point.x,
                y: hit.anchor.point.y,
                bounds: bounds
                    ? [bounds.x, bounds.y, bounds.w, bounds.h]
                    : undefined,
                page: hit.anchor.page,
            },
        };
    }
}

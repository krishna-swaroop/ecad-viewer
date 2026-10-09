/*
    Schematic insets: the schematic around a symbol.

    Every inset is pinned to its sheet instance's own scene. Insets never
    render from the live schematic viewer: its sheet changes as the user
    navigates, and a reused sheet file shows different references per
    instance, so a scene belongs to one (document, instance path) pair.

    Scenes are headless SchematicViewers (Canvas2D, no GPU context) kept in a
    small cache. A scene is reference-counted by the insets showing it and is
    never evicted while one is open; beyond `cap`, the least recently used
    idle scene is dropped.
*/

import { BBox, Vec2 } from "../../base/math";
import type { SchematicTheme } from "../../kicad";
import {
    PinInstance,
    type KicadSch,
    type SchematicInstanceContext,
    type SchematicSymbol,
} from "../../kicad/schematic";
import { SchematicViewer } from "../../viewers/schematic/viewer";
import { inset_matrix, type InsetCamera } from "./camera";
import type { InsetHit, InsetProvider, InsetTarget } from "./types";

export interface SchematicInsetPage {
    /** Unique per sheet instance (Project page `project_path`). */
    key: string;
    /** Shown in the inset header. */
    name: string;
    document: KicadSch;
    context: SchematicInstanceContext | undefined;
}

export interface SchematicInsetHost {
    pages(): readonly SchematicInsetPage[];
    theme(): SchematicTheme;
    /** Where the scenes' hidden canvases live (the element's shadow root). */
    container(): Node;
    /** The design variant the main view shows; scenes follow it. */
    variant?(): string | null;
}

interface Scene {
    key: string;
    page: SchematicInsetPage;
    viewer: SchematicViewer;
    canvas: HTMLCanvasElement;
    ready: Promise<void>;
    refs: number;
    used: number;
}

const DEFAULT_CAP = 4;

const center = (box: BBox) => new Vec2(box.x + box.w / 2, box.y + box.h / 2);

export class SchematicInsetProvider implements InsetProvider {
    readonly kind = "sch" as const;
    #scenes = new Map<string, Scene>();
    #targets = new WeakMap<InsetTarget, string>();
    #clock = 0;
    #listeners = new Set<() => void>();

    constructor(
        private readonly host: SchematicInsetHost,
        private readonly cap = DEFAULT_CAP,
    ) {}

    /** Scenes currently held; for tests and diagnostics. */
    get scene_keys(): string[] {
        return [...this.#scenes.keys()];
    }

    /** Each scene's applied variant; for tests and diagnostics. */
    get scene_variants(): (string | null)[] {
        return [...this.#scenes.values()].map((s) => s.viewer.get_variant());
    }

    ready() {
        return this.host.pages().length > 0;
    }

    subscribe(listener: () => void) {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    /**
     * The main view switched design variant: every scene follows (DNP and
     * fitted state come from the variant) and open insets re-render.
     */
    set_variant(name: string | null) {
        for (const scene of this.#scenes.values())
            scene.viewer.set_variant(name);
        for (const listener of this.#listeners) listener();
    }

    async resolve(
        reference: string,
        number: string,
    ): Promise<InsetTarget | null> {
        const found = this.#find(reference, number);
        if (!found) return null;
        const scene = this.#acquire(found.page);
        await scene.ready;
        if (!this.#scenes.has(scene.key)) return null;
        const viewer = scene.viewer;
        const painted = (item: unknown) =>
            viewer.layers.query_item_bboxes(item).next().value as
                | BBox
                | undefined;
        const symbol_box =
            viewer.schematic_renderer.get_item_bbox(found.symbol.uuid) ??
            found.symbol.bbox;
        const pin_box = found.pin
            ? (painted(found.pin) ?? found.pin.bbox)
            : symbol_box;
        const target: InsetTarget = {
            kind: "sch",
            reference,
            number,
            detail: found.page.name,
            side: "sch",
            focus: symbol_box,
            anchor: center(pin_box),
            anchor_box: found.pin ? pin_box : undefined,
            mirror: false,
        };
        this.#targets.set(target, scene.key);
        return target;
    }

    hit_test(target: InsetTarget, world: Vec2): InsetHit | null {
        const key = this.#targets.get(target);
        const scene = key ? this.#scenes.get(key) : undefined;
        if (!scene?.viewer.document) return null;
        // find_item's inferred type narrows `item` to null; it is any item.
        const { item, bbox } = scene.viewer.find_item(world) as {
            item: unknown;
            bbox: BBox | null;
        };
        if (!(item instanceof PinInstance) || !item.number.trim()) return null;
        const context = scene.page.context;
        return {
            reference: context?.reference(item.parent) ?? item.parent.reference,
            number: item.number,
            box: bbox ?? item.bbox,
        };
    }

    render(
        target: InsetTarget,
        camera: InsetCamera,
        canvas: HTMLCanvasElement,
    ) {
        const key = this.#targets.get(target);
        const scene = key ? this.#scenes.get(key) : undefined;
        if (!scene) return;
        scene.used = ++this.#clock;
        scene.viewer.render_view(canvas, (w, h) => inset_matrix(camera, w, h));
    }

    release(target: InsetTarget) {
        const key = this.#targets.get(target);
        if (!key) return;
        this.#targets.delete(target);
        const scene = this.#scenes.get(key);
        if (scene) scene.refs = Math.max(0, scene.refs - 1);
        this.#evict();
    }

    dispose() {
        for (const scene of this.#scenes.values()) this.#drop(scene);
        this.#scenes.clear();
    }

    #find(reference: string, number: string) {
        let best:
            | {
                  page: SchematicInsetPage;
                  symbol: SchematicSymbol;
                  pin: PinInstance | undefined;
              }
            | undefined;
        for (const page of this.host.pages()) {
            for (const symbol of page.document.symbols.values()) {
                const ref = page.context?.reference(symbol) ?? symbol.reference;
                if (ref !== reference) continue;
                const pins =
                    page.context?.unit_pins(symbol) ?? symbol.unit_pins;
                const pin = pins.find((p) => p.number === number);
                // A multi-unit part opens the unit that carries the pin.
                if (pin) return { page, symbol, pin };
                best ??= { page, symbol, pin: undefined };
            }
        }
        return best;
    }

    #acquire(page: SchematicInsetPage): Scene {
        let scene = this.#scenes.get(page.key);
        if (!scene) {
            const canvas = document.createElement("canvas");
            Object.assign(canvas.style, {
                position: "absolute",
                left: "0",
                top: "0",
                width: "4px",
                height: "4px",
                visibility: "hidden",
                pointerEvents: "none",
            });
            this.host.container().appendChild(canvas);
            const viewer = new SchematicViewer(
                canvas,
                false,
                this.host.theme(),
            );
            viewer.show_drawing_sheet = false;
            const ready = (async () => {
                await viewer.setup();
                if (page.context) viewer.set_instance_context(page.context);
                const variant = this.host.variant?.();
                if (variant !== undefined) viewer.set_variant(variant);
                await viewer.load(page.document);
            })();
            scene = {
                key: page.key,
                page,
                viewer,
                canvas,
                ready,
                refs: 0,
                used: 0,
            };
            this.#scenes.set(page.key, scene);
        }
        scene.refs += 1;
        scene.used = ++this.#clock;
        this.#evict();
        return scene;
    }

    #evict() {
        while (this.#scenes.size > this.cap) {
            let oldest: Scene | undefined;
            for (const scene of this.#scenes.values())
                if (!scene.refs && (!oldest || scene.used < oldest.used))
                    oldest = scene;
            if (!oldest) return;
            this.#scenes.delete(oldest.key);
            this.#drop(oldest);
        }
    }

    #drop(scene: Scene) {
        scene.viewer.dispose();
        scene.canvas.remove();
    }
}

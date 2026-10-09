/*
    InsetLink: connects one <ecad-viewer> to its inset session.

    Each element owns a session whose overlay lives in its own shadow root,
    so a hidden tab hides its insets with it. The session is served by the
    element's own documents and by its peer's (the element holding the other
    document): hovering a schematic pin opens a PCB inset from the peer, and
    a chained inset (M5) can come back to this element's own schematic.
*/

import { Vec2 } from "../../base/math";
import {
    KiCanvasProbeEvent,
    type KiCanvasProbeDetail,
} from "../../viewers/base/events";
import type { Viewer } from "../../viewers/base/viewer";
import type { InsetCamera } from "./camera";
import { InsetSession } from "./session";
import type {
    InsetKind,
    InsetProvider,
    InsetSource,
    InsetTarget,
} from "./types";

/** What a link needs from an element (its own, or its peer's). */
export interface InsetPeer {
    insetProvider(kind: InsetKind): InsetProvider | null;
}

export interface InsetLinkHost extends InsetPeer {
    /** Where the overlay mounts: the element's shadow root. */
    overlay_parent(): Node | null;
    /** The element's viewers that act as hover sources, by kind. */
    source_viewers(): Partial<Record<InsetKind, Viewer | null>>;
}

export const HOVER_OPEN_DELAY_MS = 180;
export const HOVER_CLOSE_DELAY_MS = 700;

const OTHER: Record<InsetKind, InsetKind> = { sch: "pcb", pcb: "sch" };

/** Designators KiCad never places on a board (power and flag symbols). */
const is_virtual = (reference: string) =>
    !reference.trim() || reference.startsWith("#");

/** A provider that finds the current real one on every call. */
class LazyProvider implements InsetProvider {
    #owners = new WeakMap<InsetTarget, InsetProvider>();

    constructor(
        readonly kind: InsetKind,
        private readonly find: () => InsetProvider | null,
    ) {}

    async resolve(reference: string, number: string) {
        const provider = this.find();
        const target = (await provider?.resolve(reference, number)) ?? null;
        if (target && provider) this.#owners.set(target, provider);
        return target;
    }

    render(
        target: InsetTarget,
        camera: InsetCamera,
        canvas: HTMLCanvasElement,
    ) {
        this.#owners.get(target)?.render(target, camera, canvas);
    }

    release(target: InsetTarget) {
        this.#owners.get(target)?.release?.(target);
        this.#owners.delete(target);
    }
}

/** A main viewer as a leader source. Null while its canvas is hidden. */
export function viewer_source(viewer: Viewer): InsetSource {
    return {
        world_to_client(point: Vec2) {
            const rect = viewer.canvas.getBoundingClientRect();
            if (!rect.width || !rect.height || !viewer.viewport) return null;
            const p = viewer.viewport.camera.world_to_screen(point);
            return new Vec2(rect.left + p.x, rect.top + p.y);
        },
    };
}

export class InsetLink {
    readonly session = new InsetSession();
    #peer: InsetPeer | null = null;
    #listeners = new Map<
        Viewer,
        { kind: InsetKind; dispose(): void; source: InsetSource }
    >();
    #open_timer: number | null = null;
    #close_timer: number | null = null;

    constructor(private readonly host: InsetLinkHost) {
        for (const kind of ["pcb", "sch"] as const) {
            this.session.register(
                new LazyProvider(
                    kind,
                    () =>
                        this.#peer?.insetProvider(kind) ??
                        this.host.insetProvider(kind),
                ),
            );
        }
    }

    set peer(peer: InsetPeer | null) {
        this.#peer = peer;
        if (!peer) this.session.close_all();
        this.sync();
    }

    get peer() {
        return this.#peer;
    }

    /** Attach to the element's current viewers and overlay host. */
    sync() {
        const parent = this.host.overlay_parent();
        if (parent) this.session.mount(parent);
        const wanted = new Map<Viewer, InsetKind>();
        for (const [kind, viewer] of Object.entries(
            this.host.source_viewers(),
        ) as [InsetKind, Viewer | null][])
            if (viewer) wanted.set(viewer, kind);
        for (const [viewer, entry] of this.#listeners)
            if (wanted.get(viewer) !== entry.kind) {
                entry.dispose();
                this.#listeners.delete(viewer);
            }
        for (const [viewer, kind] of wanted) {
            if (this.#listeners.has(viewer)) continue;
            const listener = viewer.addEventListener(
                KiCanvasProbeEvent.type,
                (event) => this.#on_probe(viewer, event.detail),
            );
            this.#listeners.set(viewer, {
                kind,
                dispose: () => listener.dispose(),
                source: viewer_source(viewer),
            });
        }
    }

    /** A source viewer's camera moved; leaders must follow. */
    sources_moved() {
        this.session.sources_moved();
    }

    dispose() {
        this.#clear_timers();
        for (const entry of this.#listeners.values()) entry.dispose();
        this.#listeners.clear();
        this.session.dispose();
    }

    #on_probe(viewer: Viewer, detail: KiCanvasProbeDetail) {
        if (!this.#peer) return;
        if (detail.phase === "hover") {
            if (!detail.reference || !detail.anchor) return;
            if (is_virtual(detail.reference)) return;
            const entry = this.#listeners.get(viewer);
            if (!entry) return;
            this.#cancel_close();
            if (this.#open_timer !== null) clearTimeout(this.#open_timer);
            const { reference, number } = detail;
            const anchor = new Vec2(detail.anchor.x, detail.anchor.y);
            this.#open_timer = window.setTimeout(() => {
                this.#open_timer = null;
                // The element may have re-rendered its shadow DOM.
                const parent = this.host.overlay_parent();
                if (parent) this.session.mount(parent);
                void this.session.open({
                    kind: OTHER[entry.kind],
                    reference,
                    number,
                    source: entry.source,
                    source_anchor: anchor,
                    preview: true,
                    show_missing: true,
                });
            }, HOVER_OPEN_DELAY_MS);
        } else if (detail.phase === "leave" || detail.phase === "clear") {
            if (this.#open_timer !== null) clearTimeout(this.#open_timer);
            this.#open_timer = null;
            this.#cancel_close();
            this.#close_timer = window.setTimeout(() => {
                this.#close_timer = null;
                const preview = this.session.preview;
                // The pointer reached the preview: leave it for pinning.
                if (preview && !preview.panel.el.matches(":hover"))
                    this.session.close(preview);
            }, HOVER_CLOSE_DELAY_MS);
        }
    }

    #cancel_close() {
        if (this.#close_timer !== null) clearTimeout(this.#close_timer);
        this.#close_timer = null;
    }

    #clear_timers() {
        if (this.#open_timer !== null) clearTimeout(this.#open_timer);
        this.#cancel_close();
        this.#open_timer = null;
    }
}

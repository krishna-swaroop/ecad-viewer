/*
    Net map: every sheet a net touches, side by side, joined where it crosses.

    Each page instance the highlighted nets reach is a tile that frames the
    whole page, drawn from the inset provider's scenes (so the tile shows the
    net highlighted like the main view). Curves join each label to its
    partners on other tiles: a global label to the next global label of the
    same name, a sheet entry to the hierarchical label it leads into.

    A click on a tile opens that page in the main view and closes the map.
*/

import { BBox, Vec2 } from "../../base/math";
import {
    net_color,
    type SchematicNetMembers,
} from "../../viewers/schematic/net-highlight";
import { inset_matrix, type InsetCamera } from "./camera";
import {
    net_instance_at,
    net_instances,
    type NetInstance,
    type NetInstancePage,
} from "./net-instances";
import type { SchematicPageView } from "./schematic-provider";

const SVG_NS = "http://www.w3.org/2000/svg";

export interface NetMapHost {
    /** Where the map mounts: over the schematic, in the element's shadow root. */
    container(): HTMLElement | null;
    pages(): NetInstancePage[];
    page_view(key: string): Promise<SchematicPageView | null>;
    /** Show `page` in the main view (a tile was clicked). */
    open_page(page: string): void;
    background(): string;
}

interface Tile {
    view: SchematicPageView;
    el: HTMLElement;
    canvas: HTMLCanvasElement;
    camera: InsetCamera;
}

interface Link {
    a: NetInstance;
    b: NetInstance;
    color: string;
}

const STYLES = `
.net-map {
    position: absolute;
    inset: 0;
    z-index: 20;
    display: grid;
    gap: 10px;
    padding: 10px;
    box-sizing: border-box;
}
.net-map .tile {
    position: relative;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    border: 1px solid rgba(148, 163, 184, 0.35);
    border-radius: 6px;
    overflow: hidden;
    cursor: pointer;
    background: var(--net-map-bg);
}
.net-map .tile:hover {
    border-color: rgba(148, 163, 184, 0.9);
}
.net-map .tile header {
    flex: none;
    padding: 4px 8px;
    font: 500 11px/1.3 system-ui, sans-serif;
    color: #e2e8f0;
    background: rgba(15, 23, 42, 0.85);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.net-map .tile canvas {
    flex: 1;
    width: 100%;
    min-height: 0;
}
.net-map svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    overflow: visible;
}
`;

/** Which page instances each net reaches, in the order the nets list them. */
export function net_map_pages(
    nets: readonly SchematicNetMembers[],
    pages: readonly NetInstancePage[],
): NetInstancePage[] {
    const shown: NetInstancePage[] = [];
    for (const net of nets)
        for (const member of net.pages) {
            const page = pages.find((p) => p.sheet_path === member.sheetPath);
            if (page && !shown.includes(page)) shown.push(page);
        }
    return shown;
}

/**
 * The curves between tiles: each label or sheet entry of a net joined to
 * where it leads on another shown page. Global labels of one name form a
 * chain in tile order rather than every pair.
 */
export function net_map_links(
    nets: readonly SchematicNetMembers[],
    pages: readonly NetInstancePage[],
    shown: readonly NetInstancePage[],
): Link[] {
    const keys = shown.map((page) => page.key);
    const links: Link[] = [];
    const seen = new Set<string>();
    const add = (a: NetInstance, b: NetInstance, color: string) => {
        const id = [`${a.page}#${a.uuid}`, `${b.page}#${b.uuid}`]
            .sort()
            .join("|");
        if (a.page === b.page || seen.has(id)) return;
        seen.add(id);
        links.push({ a, b, color });
    };
    for (const [index, net] of nets.entries()) {
        const color = net_color(net, index);
        const labels: NetInstance[] = [];
        for (const member of net.pages) {
            const page = shown.find((p) => p.sheet_path === member.sheetPath);
            if (!page) continue;
            for (const uuid of member.uuids) {
                const at = net_instance_at(pages, page.key, uuid);
                if (at && at.kind !== "local") labels.push(at);
            }
        }
        const globals = new Map<string, NetInstance[]>();
        for (const label of labels) {
            if (label.kind === "global") {
                const group = globals.get(label.name) ?? [];
                group.push(label);
                globals.set(label.name, group);
                continue;
            }
            for (const other of net_instances(pages, label))
                if (keys.includes(other.page)) add(label, other, color);
        }
        for (const group of globals.values()) {
            group.sort((a, b) => keys.indexOf(a.page) - keys.indexOf(b.page));
            for (let i = 1; i < group.length; i++)
                add(group[i - 1]!, group[i]!, color);
        }
    }
    return links;
}

export class NetMap {
    #root: HTMLElement | null = null;
    #svg: SVGSVGElement | null = null;
    #tiles = new Map<string, Tile>();
    #links: Link[] = [];
    #observer: ResizeObserver | null = null;
    #frame: number | null = null;
    #ticket = 0;

    constructor(private readonly host: NetMapHost) {}

    get open() {
        return this.#root !== null;
    }

    async show(nets: readonly SchematicNetMembers[]) {
        this.close();
        const container = this.host.container();
        if (!container || !nets.length) return false;
        const ticket = ++this.#ticket;
        const pages = this.host.pages();
        const shown = net_map_pages(nets, pages);
        if (!shown.length) return false;

        const root = document.createElement("div");
        root.className = "net-map";
        root.style.setProperty("--net-map-bg", this.host.background());
        root.style.background = this.host.background();
        const cols = Math.ceil(Math.sqrt(shown.length));
        root.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
        root.style.gridTemplateRows = `repeat(${Math.ceil(shown.length / cols)}, minmax(0, 1fr))`;
        const style = document.createElement("style");
        style.textContent = STYLES;
        root.append(style);
        this.#root = root;
        container.append(root);

        const views = await Promise.all(
            shown.map((page) => this.host.page_view(page.key)),
        );
        if (ticket !== this.#ticket) {
            for (const view of views) view?.release();
            return false;
        }
        for (const view of views) {
            if (!view) continue;
            const el = document.createElement("div");
            el.className = "tile";
            const header = document.createElement("header");
            header.textContent = view.name;
            header.title = view.name;
            const canvas = document.createElement("canvas");
            el.append(header, canvas);
            el.addEventListener("click", () => {
                this.host.open_page(view.key);
                this.close();
            });
            root.append(el);
            this.#tiles.set(view.key, {
                view,
                el,
                canvas,
                camera: {
                    center: new Vec2(0, 0),
                    zoom: 1,
                    rotation: 0,
                    mirror: false,
                },
            });
        }
        this.#links = net_map_links(nets, pages, shown);
        const svg = document.createElementNS(SVG_NS, "svg");
        root.append(svg);
        this.#svg = svg;
        this.#observer = new ResizeObserver(() => this.#schedule());
        this.#observer.observe(root);
        this.#schedule();
        return true;
    }

    close() {
        this.#ticket++;
        if (this.#frame !== null) cancelAnimationFrame(this.#frame);
        this.#frame = null;
        this.#observer?.disconnect();
        this.#observer = null;
        for (const tile of this.#tiles.values()) tile.view.release();
        this.#tiles.clear();
        this.#root?.remove();
        this.#root = null;
        this.#svg = null;
    }

    #schedule() {
        if (this.#frame !== null) return;
        this.#frame = requestAnimationFrame(() => {
            this.#frame = null;
            this.#draw();
        });
    }

    #draw() {
        const root = this.#root;
        const svg = this.#svg;
        if (!root || !svg) return;
        for (const tile of this.#tiles.values()) {
            const w = tile.canvas.clientWidth;
            const h = tile.canvas.clientHeight;
            if (!w || !h) continue;
            fit_page(tile.camera, tile.view.bounds, w, h);
            tile.view.render(tile.canvas, tile.camera);
        }
        const origin = root.getBoundingClientRect();
        const point = (at: NetInstance) => {
            const tile = this.#tiles.get(at.page);
            const box = tile?.view.item_bbox(at.uuid);
            if (!tile || !box) return null;
            const rect = tile.canvas.getBoundingClientRect();
            const p = inset_matrix(
                tile.camera,
                rect.width,
                rect.height,
            ).transform(box.center);
            return new Vec2(
                rect.left - origin.left + p.x,
                rect.top - origin.top + p.y,
            );
        };
        svg.replaceChildren();
        for (const link of this.#links) {
            const a = point(link.a);
            const b = point(link.b);
            if (!a || !b) continue;
            const bend = Math.max(40, Math.abs(b.x - a.x) * 0.35);
            const path = document.createElementNS(SVG_NS, "path");
            path.setAttribute(
                "d",
                `M ${a.x} ${a.y} C ${a.x + (b.x >= a.x ? bend : -bend)} ${a.y}, ${b.x - (b.x >= a.x ? bend : -bend)} ${b.y}, ${b.x} ${b.y}`,
            );
            path.setAttribute("fill", "none");
            path.setAttribute("stroke", link.color);
            path.setAttribute("stroke-width", "2");
            path.setAttribute("stroke-opacity", "0.85");
            svg.append(path);
            for (const end of [a, b]) {
                const dot = document.createElementNS(SVG_NS, "circle");
                dot.setAttribute("cx", `${end.x}`);
                dot.setAttribute("cy", `${end.y}`);
                dot.setAttribute("r", "4");
                dot.setAttribute("fill", link.color);
                svg.append(dot);
            }
        }
    }
}

/** Frame the whole page in a `w`×`h` tile. */
function fit_page(camera: InsetCamera, bounds: BBox, w: number, h: number) {
    const bw = Math.max(bounds.w, 1);
    const bh = Math.max(bounds.h, 1);
    camera.center = bounds.center;
    camera.zoom = Math.min(w / bw, h / bh) * 0.94;
}

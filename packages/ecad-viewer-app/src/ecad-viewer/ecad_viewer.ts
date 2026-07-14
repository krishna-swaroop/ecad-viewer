import { later } from "../base/async";
import { listen } from "../base/events";
import { BBox, Vec2 } from "../base/math";
import {
    CSS,
    CustomElement,
    attribute,
    css,
    html,
} from "../base/web-components";
import { KCUIElement } from "../kc-ui";
import kc_ui_styles from "../kc-ui/kc-ui.css";
import { AssertType, Project } from "../kicanvas/project";
import { type EcadBlob, type EcadSources } from "../kicanvas/services/vfs";
import { KCBoardAppElement } from "../kicanvas/elements/kc-board/app";
import { KCSchematicAppElement } from "../kicanvas/elements/kc-schematic/app";
import { BomApp } from "../kicanvas/elements/bom/app";
import { KicadSch } from "../kicad";

import { is_3d_model, is_kicad, TabHeaderElement } from "./tab_header";
import {
    BoardContentReady,
    EcadCommentAreaEvent,
    EcadOverlayClickEvent,
    EcadOverlayHoverEvent,
    EcadOverlayLeaveEvent,
    ImageExportRequestEvent,
    ImageExportResultEvent,
    KiCanvasSelectEvent,
    LoadZipEvent,
    LoadZipErrorEvent,
    Online3dViewerLoaded,
    Online3dViewerUrlReady,
    OpenBarrierEvent,
    SheetLoadEvent,
    TabActivateEvent,
    TabMenuClickEvent,
    TabMenuVisibleChangeEvent,
} from "../viewers/base/events";
import type { EcadOverlayScene } from "../viewers/base/overlay-scene";
import {
    EcadSemanticSelectionEvent,
    normalize_board_selection,
    normalize_schematic_selection,
    type EcadCrossProbeRequest,
    type EcadSemanticSelectionDetail,
    type EcadSourceUpdate,
} from "./host-adapter";

export type {
    EcadCrossProbeRequest,
    EcadHostContext,
    EcadOverlaySceneInput,
    EcadSemanticSelectionDetail,
    EcadSourceUpdate,
} from "./host-adapter";
export type {
    EcadOverlayAnchor,
    EcadOverlayPrimitive,
    EcadOverlayScene,
} from "../viewers/base/overlay-scene";

export interface EcadSchematicPageState {
    projectPath: string;
    sheetPath: string;
    filename: string;
    name?: string;
    page?: string;
    depth: number;
    active: boolean;
}

export interface EcadPcbLayerState {
    name: string;
    color: string;
    visible: boolean;
    highlighted: boolean;
}

export interface EcadPcbViewState {
    layers: EcadPcbLayerState[];
    objectOpacity: Record<"tracks" | "vias" | "pads" | "zones", number>;
    objectVisibility: Record<
        "references" | "values" | "footprintText" | "hiddenText",
        boolean
    >;
    highlightTracks: boolean;
}

export { TabActivateEvent, SheetLoadEvent } from "../viewers/base/events";

import { TabKind } from "./constraint";
import type { InputContainer } from "./input_container";
import type { Online3dViewer } from "../3d-viewer/online_3d_viewer";
import "../kc-ui/spinner";
import { show_ecad_viewer } from "../eda_host/show_ecad_viewer";
import "./ecad_viewer_global";
import { ZipUtils } from "../utils/zip_utils";
import { length } from "../base/iterator";
import { HQ_LOGO } from "../kc-ui/hq_logo";
import type { BoardViewer } from "../viewers/board/viewer";
import type { SchematicViewer } from "../viewers/schematic/viewer";

export class ECadViewer extends KCUIElement implements InputContainer {
    static override styles = [
        ...KCUIElement.styles,
        new CSS(kc_ui_styles),
        css`
            :host(.full-window) {
                width: 100vw; /* Full width of the viewport */
                height: 100vh; /* Full height of the viewport */
                top: 0px;
                left: 0px;
                position: fixed;
            }

            :host {
                margin: 0;
                display: flex;
                position: relative;
                width: 100%;
                max-height: 100%;
                aspect-ratio: 1.414;
                background-color: white;
                color: var(--fg);
                contain: layout paint;
            }

            .vertical {
                display: flex;
                flex-direction: column;
                height: 100%;
                width: 100%;
                overflow: hidden;
            }

            .tab-content {
                height: 100%;
                width: 100%;
                flex: 1;
                display: none;
            }

            .tab-content.active {
                display: inherit;
            }

            .bottom-left-icon {
                position: absolute;
                bottom: 16px;
                left: 16px; /* Adjusted to place it on the bottom-left */
                display: flex;
                align-items: center;
                justify-content: center;
                width: 40px;
                height: 40px;
                background-color: transparent;
                border-radius: 50%;
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
                text-decoration: none;
                color: var(--fg);
                transition:
                    transform 0.2s ease-in-out,
                    box-shadow 0.2s ease-in-out;
            }

            .bottom-left-icon:hover {
                transform: scale(1.1);
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            }
        `,
    ];

    constructor() {
        super();
        this.addDisposable(this.#project);
        this.provideContext("project", this.#project);
        this.addDisposable(
            listen(this.#project, "change", () => {
                const active = this.#project.active_sch_name;
                if (
                    active &&
                    this.#project.pages.some(
                        (page) => page.project_path === active,
                    )
                ) {
                    this.#active_schematic_project_path = active;
                }
                this.dispatchEvent(
                    new CustomEvent("ecad-viewer:view-state-change", {
                        bubbles: false,
                    }),
                );
            }),
        );
        this.addEventListener("contextmenu", function (event) {
            event.preventDefault();
        });
        this.addDisposable(
            listen(window, "keydown", (event) => {
                this.#handle_host_keydown(event as KeyboardEvent);
            }),
        );
    }

    get input() {
        return this.#file_input;
    }
    public get target() {
        return this;
    }

    #tab_contents: Record<string, HTMLElement> = {};
    #active_tab: TabKind = TabKind.pcb;
    #user_selected_tab = false;
    #initial_tab_set = false;
    #project: Project = new Project();
    #schematic_app: KCSchematicAppElement;
    #ov_d_app: Online3dViewer;
    #board_app: KCBoardAppElement;
    #bom_app: BomApp;
    #tab_header: TabHeaderElement;
    #file_input: HTMLInputElement;
    #spinner: HTMLElement;
    #content: HTMLElement;
    #step_viewer_placeholder: HTMLElement;
    #viewers_container: HTMLDivElement;
    #is_full_screen = false;
    #host_active = true;
    #revision_key: string | null = null;
    #source_names = new Set<string>();
    #overlay_scenes = new Map<string, EcadOverlayScene>();
    #active_schematic_project_path: string | null = null;
    get project() {
        return this.#project;
    }

    get showHeader() {
        return this.getAttribute("show-header") !== "false";
    }

    get showSelectionPanel() {
        return this.getAttribute("show-selection-panel") !== "false";
    }

    public async replaceSources(update: EcadSourceUpdate): Promise<void> {
        if (this.#revision_key === update.revisionKey && this.loaded) return;
        this.#project.reset();
        this.#revision_key = update.revisionKey;
        this.#source_names = new Set(
            update.sources.map((source) => source.filename),
        );
        await this.#setup_project({ urls: [], blobs: update.sources });
    }

    public async appendSources(update: EcadSourceUpdate): Promise<void> {
        if (
            this.#revision_key !== null &&
            this.#revision_key !== update.revisionKey
        ) {
            await this.replaceSources(update);
            return;
        }
        this.#revision_key = update.revisionKey;
        const additions = update.sources.filter(
            (source) => !this.#source_names.has(source.filename),
        );
        if (!additions.length) return;
        for (const source of additions) this.#source_names.add(source.filename);
        await this.#add_files_to_project(additions);
    }

    public setActive(active: boolean): void {
        this.#host_active = active;
        this.#apply_viewer_activity();
    }

    /**
     * Enable or disable comment mode on both the schematic and board
     * viewers. While enabled, dragging on a viewer's canvas draws a
     * rubber-band area and emits an `EcadCommentAreaEvent` on mouseup
     * instead of performing normal item selection.
     */
    public setCommentMode(enabled: boolean): void {
        if (enabled) {
            this.setAttribute("comment-mode", "");
        } else {
            this.removeAttribute("comment-mode");
        }
        this.#safe_board_viewer()?.set_comment_mode(enabled);
        this.#safe_schematic_viewer()?.set_comment_mode(enabled);
    }

    public clearSelection(): void {
        this.#safe_board_viewer()?.clear_selection();
        this.#safe_schematic_viewer()?.clear_selection();
    }

    public setOverlayScene(
        channelId: string,
        scene: Omit<EcadOverlayScene, "channelId">,
    ): void {
        const normalized = { ...scene, channelId };
        this.#overlay_scenes.set(channelId, normalized);
        this.#viewer_for_context(normalized.context)?.set_overlay_scene(
            normalized,
        );
    }

    public clearOverlayScene(channelId: string): void {
        this.#overlay_scenes.delete(channelId);
        this.#safe_board_viewer()?.clear_overlay_scene(channelId);
        this.#safe_schematic_viewer()?.clear_overlay_scene(channelId);
    }

    public requestCrossProbe(request: EcadCrossProbeRequest): boolean {
        const value = request.value.trim();
        if (!value) return false;
        const target = request.targetContext;
        if (target === "PCB" || (!target && this.has_pcb)) {
            const board_viewer = this.#safe_board_viewer();
            if (board_viewer) {
                if (request.kind === "net") {
                    const requested_name = request.net ?? value;
                    // A schematic/semantic numeric ID is not guaranteed to be
                    // the board's local net code. Resolve by stable name first
                    // and use the numeric code only as a validated fallback.
                    const by_name = board_viewer.board.nets.find(
                        (net) => net.name === requested_name,
                    );
                    const by_code = board_viewer.board.nets.find(
                        (net) => net.number === request.netCode,
                    );
                    const net_code = by_name?.number ?? by_code?.number;
                    if (net_code !== undefined) {
                        board_viewer.focus_net(net_code, false);
                        return true;
                    }
                } else {
                    const footprint = board_viewer.board.find_footprint(
                        request.uuid ?? request.designator ?? value,
                    );
                    if (footprint) {
                        board_viewer.highlight_fp(footprint);
                        if (request.mode !== "hover") {
                            const bounds = footprint.bbox;
                            board_viewer.viewport.camera.bbox = bounds.grow(
                                Math.max(bounds.w * 0.8, 4),
                                Math.max(bounds.h * 0.8, 4),
                            );
                        }
                        board_viewer.draw();
                        return true;
                    }
                }
            }
        }
        if (target === "SCH" || (!target && this.has_sch)) {
            return this.#apply_schematic_cross_probe(request, value);
        }
        return false;
    }

    @attribute({ type: Boolean })
    public loading: boolean;

    @attribute({ type: Boolean })
    public loaded: boolean;

    /**
     * Move the camera to a specific location (in world coordinates)
     */
    public zoomToLocation(x: number, y: number): void {
        const pos = new Vec2(x, y);
        // Helper to move camera on a viewer
        const moveCamera = (viewer: any) => {
            if (viewer?.viewport?.camera) {
                viewer.viewport.camera.center.set(pos.x, pos.y);
                viewer.draw();
            }
        };

        if (this.#board_app?.viewer) {
            moveCamera(this.#board_app.viewer);
        }
        if (this.#schematic_app?.viewer) {
            moveCamera(this.#schematic_app.viewer);
        }
    }

    /**
     * Switch to a specific schematic page (by filename or sheet path)
     */
    public switchPage(pageId: string): boolean {
        if (!this.#schematic_app) return false;
        const page = this.#project.pages.find(
            (candidate) =>
                candidate.project_path === pageId ||
                candidate.filename === pageId ||
                candidate.name === pageId ||
                candidate.page === pageId,
        );
        if (!page) {
            console.warn(`switchPage: Could not find page with ID ${pageId}`);
            return false;
        }
        return this.#activate_schematic_page(page.project_path);
    }

    public navigateSchematicPage(direction: -1 | 1): boolean {
        const pages = this.#project.pages;
        if (!pages.length) return false;
        const current = this.#active_schematic_page();
        const index = pages.findIndex(
            (page) => page.project_path === current?.project_path,
        );
        const next =
            pages[
                ((index >= 0 ? index : 0) + direction + pages.length) %
                    pages.length
            ];
        return next ? this.#activate_schematic_page(next.project_path) : false;
    }

    public navigateSchematicParent(): boolean {
        const current = this.#active_schematic_page();
        if (!current?.parent_project_path) return false;
        const parent = this.#project.pages.find(
            (page) => page.project_path === current.parent_project_path,
        );
        return parent
            ? this.#activate_schematic_page(parent.project_path)
            : false;
    }

    #handle_host_keydown(event: KeyboardEvent) {
        if (!this.#host_active || !this.has_sch || event.defaultPrevented)
            return;
        if (document.querySelector('[role="dialog"][data-state="open"]'))
            return;
        const target = event.composedPath()[0];
        if (
            target instanceof HTMLInputElement ||
            target instanceof HTMLTextAreaElement ||
            (target instanceof HTMLElement && target.isContentEditable)
        )
            return;

        const direction =
            event.key === "[" || event.code === "BracketLeft"
                ? -1
                : event.key === "]" || event.code === "BracketRight"
                  ? 1
                  : null;
        if (direction) {
            if (this.navigateSchematicPage(direction)) event.preventDefault();
            return;
        }
        if (
            event.altKey &&
            (event.key === "Backspace" ||
                event.key === "Delete" ||
                event.code === "Backspace" ||
                event.code === "Delete") &&
            this.navigateSchematicParent()
        ) {
            event.preventDefault();
        }
    }

    public getActiveSchematicPage() {
        const page = this.#active_schematic_page();
        return page
            ? {
                  projectPath: page.project_path,
                  sheetPath: page.sheet_path,
                  filename: page.filename,
                  name: page.name,
                  page: page.page,
              }
            : null;
    }

    public getSchematicPages(): EcadSchematicPageState[] {
        // The project owns page activation; prefer its explicit active path so
        // host controls update synchronously, even while the canvas is loading
        // the new schematic document.
        const active =
            this.#project.active_sch_name ??
            this.#active_schematic_page()?.project_path;
        return this.#project.pages.map((page) => ({
            projectPath: page.project_path,
            sheetPath: page.sheet_path,
            filename: page.filename,
            name: page.name,
            page: page.page,
            depth: Math.max(
                0,
                page.sheet_path.split("/").filter(Boolean).length - 1,
            ),
            active: page.project_path === active,
        }));
    }

    public getPcbViewState(): EcadPcbViewState | null {
        return this.#safe_board_viewer()?.get_host_view_state() ?? null;
    }

    public setPcbLayerVisibility(name: string, visible: boolean): boolean {
        const changed =
            this.#safe_board_viewer()?.set_host_layer_visibility(
                name,
                visible,
            ) ?? false;
        if (changed) this.#emit_view_state_change();
        return changed;
    }

    public setPcbLayerHighlight(name: string | null): boolean {
        const changed =
            this.#safe_board_viewer()?.set_host_layer_highlight(name) ?? false;
        if (changed) this.#emit_view_state_change();
        return changed;
    }

    public applyPcbLayerPreset(
        preset:
            | "front"
            | "back"
            | "copper"
            | "outer-copper"
            | "inner-copper"
            | "drawings"
            | "all"
            | "none",
    ): void {
        this.#safe_board_viewer()?.apply_host_layer_preset(preset);
        this.#emit_view_state_change();
    }

    public setPcbObjectOpacity(
        kind: "tracks" | "vias" | "pads" | "zones",
        opacity: number,
    ): void {
        this.#safe_board_viewer()?.set_host_object_opacity(kind, opacity);
        this.#emit_view_state_change();
    }

    public setPcbObjectVisibility(
        kind: "references" | "values" | "footprintText" | "hiddenText",
        visible: boolean,
    ): void {
        this.#safe_board_viewer()?.set_host_object_visibility(kind, visible);
        this.#emit_view_state_change();
    }

    public setPcbTrackHighlight(enabled: boolean): void {
        this.#safe_board_viewer()?.set_host_track_highlight(enabled);
        this.#emit_view_state_change();
    }

    #emit_view_state_change() {
        this.dispatchEvent(
            new CustomEvent("ecad-viewer:view-state-change", {
                bubbles: false,
            }),
        );
    }

    #active_schematic_page() {
        const exact = this.#project.pages.find(
            (page) => page.project_path === this.#active_schematic_project_path,
        );
        if (exact) return exact;
        const filename = this.#safe_schematic_viewer()?.schematic?.filename;
        return this.#project.pages
            .filter((page) => !filename || page.filename === filename)
            .sort(
                (a, b) =>
                    a.sheet_path.split("/").filter(Boolean).length -
                    b.sheet_path.split("/").filter(Boolean).length,
            )[0];
    }

    #activate_schematic_page(project_path: string): boolean {
        const page = this.#project.pages.find(
            (candidate) => candidate.project_path === project_path,
        );
        const viewer = this.#safe_schematic_viewer();
        if (!page || !viewer || !(page.document instanceof KicadSch))
            return false;
        this.#active_schematic_project_path = page.project_path;
        this.#project.activate_sch(page.project_path);
        return true;
    }

    /**
     * Get screen coordinates from world coordinates
     */
    public getScreenLocation(
        x: number,
        y: number,
    ): { x: number; y: number } | null {
        const pos = new Vec2(x, y);

        let viewer: any = null;
        if (this.#active_tab === TabKind.pcb && this.#board_app) {
            viewer = this.#board_app.viewer;
        } else if (this.#active_tab === TabKind.sch && this.#schematic_app) {
            viewer = this.#schematic_app.viewer;
        } else {
            // Fallback
            viewer = (this.#board_app?.viewer ||
                this.#schematic_app?.viewer) as any;
        }

        if (viewer?.viewport?.camera) {
            // Note: Camera2 uses snake_case world_to_screen
            const screenPos = viewer.viewport.camera.world_to_screen(pos);
            return { x: screenPos.x, y: screenPos.y };
        }
        return null;
    }

    public async exportImage(
        viewType: "SCH" | "PCB" | "3D" | "BOM" = this.#active_tab as
            "SCH" | "PCB" | "3D" | "BOM",
    ): Promise<{ image: string; width: number; height: number } | null> {
        await this.loaded;

        const tabKind = this.#viewTypeToTabKind(viewType);
        const currentTab = this.#active_tab;
        const needSwitch = currentTab !== tabKind;

        if (needSwitch) {
            await this.#switchToTab(tabKind);
        }

        let result: { image: string; width: number; height: number } | null =
            null;

        switch (viewType) {
            case "PCB": {
                const boardViewer = this.#board_app?.viewer;
                if (boardViewer?.canvas) {
                    const canvas = boardViewer.canvas as HTMLCanvasElement;

                    if (canvas.width === 0 || canvas.height === 0) {
                        return null;
                    }

                    if (typeof boardViewer.draw === "function") {
                        boardViewer.draw();
                    }

                    await new Promise((resolve) =>
                        requestAnimationFrame(resolve),
                    );

                    result = {
                        image: canvas.toDataURL("image/png"),
                        width: canvas.width,
                        height: canvas.height,
                    };
                }
                break;
            }
            case "SCH": {
                const schViewer = this.#schematic_app?.viewer;
                if (schViewer?.canvas) {
                    const schematics = Array.from(
                        this.#project?.schematics() || [],
                    );

                    if (schematics.length > 1) {
                        const images: Array<{
                            image: string;
                            width: number;
                            height: number;
                            name: string;
                        }> = [];
                        const originalSheet = (schViewer as any).sch_name;

                        for (const sch of schematics) {
                            if (sch instanceof KicadSch) {
                                await this.#schematic_app.viewer.load(sch);
                                await new Promise((resolve) =>
                                    requestAnimationFrame(resolve),
                                );

                                const canvas =
                                    schViewer.canvas as HTMLCanvasElement;
                                images.push({
                                    image: canvas.toDataURL("image/png"),
                                    width: canvas.width,
                                    height: canvas.height,
                                    name: sch.filename,
                                });
                            }
                        }

                        if (originalSheet) {
                            const originalSch =
                                this.#project.file_by_name(originalSheet);
                            if (originalSch instanceof KicadSch) {
                                await this.#schematic_app.viewer.load(
                                    originalSch,
                                );
                            }
                        }

                        result = {
                            image: JSON.stringify(images),
                            width: 0,
                            height: 0,
                        };
                    } else {
                        const canvas = schViewer.canvas as HTMLCanvasElement;
                        result = {
                            image: canvas.toDataURL("image/png"),
                            width: canvas.width,
                            height: canvas.height,
                        };
                    }
                }
                break;
            }
            case "3D": {
                const viewer3d = this.#ov_d_app;
                if (viewer3d?._viewer_container) {
                    const renderer = viewer3d._viewer_container.renderer;
                    if (renderer) {
                        renderer.render(
                            viewer3d._viewer_container.scene,
                            viewer3d._viewer_container.activeCamera,
                        );

                        const canvas = renderer.domElement;
                        result = {
                            image: canvas.toDataURL("image/png"),
                            width: canvas.width,
                            height: canvas.height,
                        };
                    }
                }
                break;
            }
            case "BOM": {
                const bomItems = this.#project?.bom_items;
                if (bomItems && bomItems.length > 0) {
                    const padding = 20;
                    const rowHeight = 28;
                    const headerHeight = 32;
                    const colWidths = [50, 140, 350, 160, 200, 70];
                    const totalWidth =
                        colWidths.reduce((a, b) => a + b, 0) + padding * 2;
                    const totalHeight =
                        headerHeight +
                        (bomItems.length + 1) * rowHeight +
                        padding * 2;

                    const canvas = document.createElement("canvas");
                    const dpr = window.devicePixelRatio || 1;
                    canvas.width = totalWidth * dpr;
                    canvas.height = totalHeight * dpr;
                    const ctx = canvas.getContext("2d");

                    if (ctx) {
                        ctx.scale(dpr, dpr);

                        ctx.fillStyle = "#ffffff";
                        ctx.fillRect(0, 0, totalWidth, totalHeight);

                        ctx.fillStyle = "#666";
                        ctx.fillRect(
                            padding,
                            padding,
                            totalWidth - padding * 2,
                            headerHeight,
                        );

                        ctx.fillStyle = "#ffffff";
                        ctx.font = "bold 12px sans-serif";
                        ctx.textAlign = "left";
                        ctx.textBaseline = "middle";

                        const headers = [
                            "No",
                            "Value",
                            "Description",
                            "Footprint",
                            "Designator",
                            "Quantity",
                        ];
                        let x = padding + 8;
                        headers.forEach((header, index) => {
                            ctx.fillText(header, x, padding + headerHeight / 2);
                            x += colWidths[index] ?? 0;
                        });

                        ctx.fillStyle = "#333";
                        ctx.font = "11px sans-serif";
                        ctx.textAlign = "left";
                        ctx.textBaseline = "middle";

                        let y = padding + headerHeight;
                        bomItems.forEach((item, index) => {
                            if (index % 2 === 0) {
                                ctx.fillStyle = "#f9f9f9";
                                ctx.fillRect(
                                    padding,
                                    y,
                                    totalWidth - padding * 2,
                                    rowHeight,
                                );
                            }

                            ctx.fillStyle = "#333";
                            let x = padding + 8;

                            ctx.fillText(
                                String(index + 1),
                                x,
                                y + rowHeight / 2,
                            );
                            x += colWidths[0] ?? 0;

                            ctx.save();
                            ctx.beginPath();
                            ctx.rect(x - 8, y, colWidths[1] ?? 0, rowHeight);
                            ctx.clip();
                            ctx.fillText(item.Name || "", x, y + rowHeight / 2);
                            ctx.restore();
                            x += colWidths[1] ?? 0;

                            ctx.save();
                            ctx.beginPath();
                            ctx.rect(x - 8, y, colWidths[2] ?? 0, rowHeight);
                            ctx.clip();
                            ctx.fillText(
                                item.Description || "",
                                x,
                                y + rowHeight / 2,
                            );
                            ctx.restore();
                            x += colWidths[2] ?? 0;

                            ctx.save();
                            ctx.beginPath();
                            ctx.rect(x - 8, y, colWidths[3] ?? 0, rowHeight);
                            ctx.clip();
                            ctx.fillText(
                                item.Footprint || "",
                                x,
                                y + rowHeight / 2,
                            );
                            ctx.restore();
                            x += colWidths[3] ?? 0;

                            ctx.save();
                            ctx.beginPath();
                            ctx.rect(x - 8, y, colWidths[4] ?? 0, rowHeight);
                            ctx.clip();
                            ctx.fillText(
                                item.Reference || "",
                                x,
                                y + rowHeight / 2,
                            );
                            ctx.restore();
                            x += colWidths[4] ?? 0;

                            ctx.fillText(
                                String(item.Qty),
                                x,
                                y + rowHeight / 2,
                            );

                            y += rowHeight;
                        });

                        const totalQty = bomItems.reduce(
                            (sum, item) => sum + item.Qty,
                            0,
                        );
                        ctx.fillStyle = "#666";
                        ctx.fillRect(
                            padding,
                            y,
                            totalWidth - padding * 2,
                            rowHeight,
                        );
                        ctx.fillStyle = "#ffffff";
                        ctx.font = "bold 12px sans-serif";
                        ctx.textAlign = "right";
                        ctx.fillText(
                            `Total: ${totalQty} Price: N/A`,
                            totalWidth - padding - 8,
                            y + rowHeight / 2,
                        );

                        result = {
                            image: canvas.toDataURL("image/png"),
                            width: canvas.width,
                            height: canvas.height,
                        };
                    }
                }
                break;
            }
        }

        if (needSwitch && currentTab !== tabKind) {
            await this.#switchToTab(currentTab);
        }

        return result;
    }

    #viewTypeToTabKind(viewType: "SCH" | "PCB" | "3D" | "BOM"): TabKind {
        switch (viewType) {
            case "PCB":
                return TabKind.pcb;
            case "SCH":
                return TabKind.sch;
            case "3D":
                return TabKind.step;
            case "BOM":
                return TabKind.bom;
            default:
                return TabKind.pcb;
        }
    }

    async #switchToTab(tabKind: TabKind): Promise<void> {
        return new Promise((resolve) => {
            const tabButtons =
                this.#tab_header?.shadowRoot?.querySelectorAll("tab-button");
            if (tabButtons) {
                tabButtons.forEach((btn) => {
                    if (btn.textContent?.trim().toUpperCase() === tabKind) {
                        (btn as HTMLElement).click();
                    }
                });
            }

            const checkTab = () => {
                if (this.#active_tab === tabKind) {
                    resolve();
                } else {
                    setTimeout(checkTab, 50);
                }
            };
            setTimeout(checkTab, 100);
        });
    }

    override initialContentCallback() {
        this.#setup_events();
        later(() => {
            this.load_src();
        });
    }

    async #setup_events() {
        // Listen for ZIP blob received via postMessage
        this.addDisposable(
            listen(window, LoadZipEvent.type, async (event) => {
                await this.load_zip((event as LoadZipEvent).detail);
            }),
        );

        this.addDisposable(
            listen(window, ImageExportRequestEvent.type, async (e) => {
                const event = e as ImageExportRequestEvent;
                let viewType: "SCH" | "PCB" | "3D" | "BOM" = this
                    .#active_tab as "SCH" | "PCB" | "3D" | "BOM";

                if (typeof event.detail === "string") {
                    viewType = event.detail as "SCH" | "PCB" | "3D" | "BOM";
                } else if (
                    event.detail &&
                    typeof event.detail === "object" &&
                    "viewType" in event.detail &&
                    event.detail.viewType
                ) {
                    viewType = event.detail.viewType;
                }

                const result = await this.exportImage(viewType);
                if (result) {
                    window.parent.postMessage(
                        {
                            type: ImageExportResultEvent.type,
                            detail: {
                                viewType: viewType,
                                imageData: result.image,
                                width: result.width,
                                height: result.height,
                                timestamp: Date.now(),
                            },
                        },
                        "*",
                    );
                }
            }),
        );
    }

    async load_zip(file: Blob) {
        // Dispose current project (queueing: newest wins)
        this.#project.reset();

        try {
            const files = await ZipUtils.unzipFile(file);
            const readFilePromises = Array.from(files).map((file) =>
                this.readFile(file),
            );

            const blobs: EcadBlob[] = [];

            const results = await Promise.all(readFilePromises);

            let idx = -1;
            results.forEach(({ name, content }) => {
                idx = idx + 1;
                const names = name.split("/");
                name = names[names.length - 1]!;

                if (is_kicad(name)) {
                    blobs.push({ filename: name, content });
                } else if (is_3d_model(name)) {
                    this.#project.ov_3d_url = URL.createObjectURL(files[idx]!);
                }
            });

            await this.#setup_project({ urls: [], blobs });
        } catch (error) {
            console.error("Error while loading ZIP:", error);
            // Dispatch error event for iframe bridge to handle
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error while loading ZIP";
            window.dispatchEvent(new LoadZipErrorEvent(errorMessage));
        }
    }

    private readFile(file: File): Promise<{ name: string; content: string }> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) =>
                resolve({
                    name: file.name,
                    content: e.target!.result as string,
                });
            reader.onerror = (error) => reject(error);
            reader.readAsText(file);
        });
    }

    async load_window_zip_url(url: string) {
        return this.load_zip(await (await fetch(url)).blob());
    }

    async load_src() {
        console.log(
            "[ECadViewer] load_src() called, design_urls:",
            window.design_urls,
        );
        if (window.zip_url) {
            return this.load_window_zip_url(window.zip_url);
        }
        if (window.design_urls) {
            const extract_zip_blobs = async (
                url: string,
                label: string,
            ): Promise<EcadBlob[]> => {
                console.log("[ECadViewer] Loading", label + ":", url);
                const blob = await (await fetch(url)).blob();
                const files = await ZipUtils.unzipFile(blob);
                const readFilePromises = Array.from(files).map((file) =>
                    this.readFile(file),
                );
                const results = await Promise.all(readFilePromises);
                const blobs: EcadBlob[] = [];
                let idx = -1;
                results.forEach(({ name, content }) => {
                    idx = idx + 1;
                    const names = name.split("/");
                    name = names[names.length - 1]!;
                    if (is_kicad(name)) {
                        blobs.push({ filename: name, content });
                    } else if (is_3d_model(name)) {
                        this.#project.ov_3d_url = URL.createObjectURL(
                            files[idx]!,
                        );
                        console.log(
                            "[ECadViewer] 3D model found in zip:",
                            name,
                        );
                    }
                });
                console.log(
                    "[ECadViewer]",
                    label,
                    "loaded,",
                    blobs.length,
                    "kicad files",
                );
                return blobs;
            };

            let initial_loaded = false;

            if (window.design_urls.sch_url) {
                const sch_blobs = await extract_zip_blobs(
                    window.design_urls.sch_url,
                    "SCH",
                );
                await this.#setup_project({ urls: [], blobs: sch_blobs });
                initial_loaded = true;
            }

            if (window.design_urls.pcb_url) {
                const pcb_blobs = await extract_zip_blobs(
                    window.design_urls.pcb_url,
                    "PCB",
                );
                if (!initial_loaded) {
                    await this.#setup_project({ urls: [], blobs: pcb_blobs });
                    initial_loaded = true;
                } else {
                    await this.#add_files_to_project(pcb_blobs);
                }
            }

            if (window.design_urls.glb_url) {
                const glb_blobs = await extract_zip_blobs(
                    window.design_urls.glb_url,
                    "GLB",
                );
                if (!initial_loaded) {
                    await this.#setup_project({ urls: [], blobs: glb_blobs });
                    initial_loaded = true;
                } else if (glb_blobs.length > 0) {
                    await this.#add_files_to_project(glb_blobs);
                }
                if (this.#project.ov_3d_url) {
                    console.log(
                        "[ECadViewer] GLB URL ready, dispatching Online3dViewerUrlReady",
                    );
                    window.dispatchEvent(
                        new Online3dViewerUrlReady(this.#project.ov_3d_url),
                    );
                }
            }

            return;
        }

        const urls = [];
        const blobs: EcadBlob[] = [];

        for (const src_elm of this.querySelectorAll<EcadSourceElement>(
            "ecad-source",
        )) {
            if (src_elm.src) {
                urls.push(src_elm.src);
            }
        }

        for (const blob_elm of this.querySelectorAll<EcadBlobElement>(
            "ecad-blob",
        )) {
            blobs.push({
                filename: blob_elm.filename,
                content: blob_elm.content,
            });
        }

        for (const src of this.querySelectorAll<Ov3dElement>(
            "ecad-3d-source",
        )) {
            if (src.src) {
                this.#project.ov_3d_url = src.src;
                break;
            }
        }

        await this.#setup_project({ urls, blobs });
    }

    async #setup_project(sources: EcadSources) {
        console.log(
            "[ECadViewer] #setup_project() called, has_sch:",
            this.has_sch,
            "has_pcb:",
            this.has_pcb,
        );
        this.loaded = false;
        this.loading = true;

        try {
            await this.#project.load(sources);

            this.loaded = true;
            console.log(
                "[ECadViewer] Project loaded, has_sch:",
                this.has_sch,
                "has_pcb:",
                this.has_pcb,
                "active_tab:",
                this.#active_tab,
            );
            await this.update();
            this.#project.on_loaded();
        } catch (error) {
            console.error(
                "[ECadViewer] Error while setting up project:",
                error,
            );
            // Dispatch error event for iframe bridge to handle
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error while setting up project";
            window.dispatchEvent(new LoadZipErrorEvent(errorMessage));
        } finally {
            this.loading = false;
        }
    }

    async #add_files_to_project(blobs: EcadBlob[]) {
        console.log(
            "[ECadViewer] #add_files_to_project() called, adding",
            blobs.length,
            "files",
        );
        this.loading = true;
        try {
            await this.#project.load({ urls: [], blobs });
            console.log(
                "[ECadViewer] Files added, has_sch:",
                this.has_sch,
                "has_pcb:",
                this.has_pcb,
            );
            // Notify existing viewers of the updated project without re-rendering
            this.#project.on_loaded();
        } catch (error) {
            console.error(
                "[ECadViewer] Error while adding files to project:",
                error,
            );
        } finally {
            this.loading = false;
        }
    }

    #safe_board_viewer(): BoardViewer | null {
        try {
            return (this.#board_app?.viewer as BoardViewer | undefined) ?? null;
        } catch {
            return null;
        }
    }

    #safe_schematic_viewer(): SchematicViewer | null {
        try {
            return (
                (this.#schematic_app?.viewer as SchematicViewer | undefined) ??
                null
            );
        } catch {
            return null;
        }
    }

    #viewer_for_context(context: "SCH" | "PCB") {
        return context === "SCH"
            ? this.#safe_schematic_viewer()
            : this.#safe_board_viewer();
    }

    #apply_viewer_activity() {
        const board_active =
            this.#host_active &&
            (this.#active_tab === TabKind.pcb || !this.has_sch);
        const schematic_active =
            this.#host_active &&
            (this.#active_tab === TabKind.sch || !this.has_pcb);
        this.#safe_board_viewer()?.set_active(board_active);
        this.#safe_schematic_viewer()?.set_active(schematic_active);
    }

    #restore_overlay_scenes() {
        for (const scene of this.#overlay_scenes.values()) {
            this.#viewer_for_context(scene.context)?.set_overlay_scene(scene);
        }
    }

    #relay_board_selection(event: Event) {
        event.stopPropagation();
        const item = (event as KiCanvasSelectEvent).detail.item;
        if (!item) return;
        const viewer = this.#safe_board_viewer();
        const board = viewer?.board;
        if (!board) return;
        const detail = normalize_board_selection(item, board);
        if (!detail) return;
        this.#attach_item_bounds_pcb(detail, item, viewer!);
        this.dispatchEvent(new EcadSemanticSelectionEvent(detail));
    }

    #relay_schematic_selection(event: Event) {
        event.stopPropagation();
        const item = (event as KiCanvasSelectEvent).detail.item;
        if (!item) return;
        const viewer = this.#safe_schematic_viewer();
        const schematic = viewer?.schematic;
        if (!schematic) return;
        const detail = normalize_schematic_selection(item, schematic);
        if (!detail) return;
        this.#attach_item_bounds_sch(detail, item, viewer!);
        this.dispatchEvent(new EcadSemanticSelectionEvent(detail));
    }

    /** Best-effort item bbox lookup for the given world coordinate systems. */
    static #item_bbox(item: unknown): BBox | undefined {
        if (
            item &&
            typeof item === "object" &&
            "bbox" in item &&
            (item as { bbox?: unknown }).bbox instanceof BBox
        ) {
            return (item as { bbox: BBox }).bbox;
        }
        return undefined;
    }

    #attach_item_bounds_sch(
        detail: EcadSemanticSelectionDetail,
        item: unknown,
        viewer: SchematicViewer,
    ) {
        let bbox = ECadViewer.#item_bbox(item);
        if (!bbox && detail.uuid) {
            bbox = viewer.schematic_renderer.get_item_bbox(detail.uuid);
        }
        ECadViewer.#apply_bounds(detail, bbox);
    }

    #attach_item_bounds_pcb(
        detail: EcadSemanticSelectionDetail,
        item: unknown,
        viewer: BoardViewer,
    ) {
        let bbox = ECadViewer.#item_bbox(item);
        if (!bbox && detail.uuid) {
            bbox = viewer.overlay_item_bounds(detail.uuid);
        }
        if (!bbox && detail.reference) {
            bbox = viewer.board.find_footprint(detail.reference)?.bbox;
        }
        ECadViewer.#apply_bounds(detail, bbox);
    }

    static #apply_bounds(
        detail: EcadSemanticSelectionDetail,
        bbox: BBox | undefined,
    ) {
        if (!bbox) return;
        detail.x = bbox.center.x;
        detail.y = bbox.center.y;
        detail.bounds = [bbox.x, bbox.y, bbox.w, bbox.h];
    }

    #relay_overlay_event<D>(
        EventClass: new (detail: D) => CustomEvent<D>,
        event: Event,
    ): void {
        event.stopPropagation();
        this.dispatchEvent(
            new EventClass((event as CustomEvent<D>).detail),
        );
    }

    #relay_comment_area_event(event: Event) {
        event.stopPropagation();
        const detail = { ...(event as EcadCommentAreaEvent).detail };
        if (detail.context === "SCH" && !detail.page) {
            detail.page = this.#safe_schematic_viewer()?.schematic?.filename;
        }
        this.dispatchEvent(new EcadCommentAreaEvent(detail));
    }

    #apply_schematic_cross_probe(
        request: EcadCrossProbeRequest,
        value: string,
    ): boolean {
        const viewer = this.#safe_schematic_viewer();
        if (!viewer) return false;

        let sheet = request.sheet ?? request.page;
        let uuid = request.uuid;
        if (request.kind === "net") {
            const ref = this.#project.find_labels_by_name(
                request.net ?? value,
            )?.[0];
            sheet ??= ref?.sheet_name;
            uuid ??= ref?.uuid;
        } else if (!uuid) {
            for (const schematic of this.#project.schematics()) {
                const symbol = schematic.find_symbol(
                    request.designator ?? value,
                );
                if (!symbol) continue;
                sheet ??= schematic.filename;
                uuid = symbol.uuid;
                break;
            }
        }
        if (!uuid) return false;

        const focus = () => viewer.zoom_fit_item(uuid!);
        if (sheet && sheet !== viewer.sch_name) {
            const target = this.#project.file_by_name(sheet);
            if (!(target instanceof KicadSch)) return false;
            void viewer.load(target).then(focus);
            return true;
        }
        focus();
        return true;
    }
    get has_3d() {
        return this.#project.has_boards || this.#project.has_3d;
    }
    get has_pcb() {
        return this.#project.has_boards;
    }
    get has_sch() {
        return this.#project.has_schematics;
    }

    get sch_count() {
        return length(this.#project.schematics());
    }
    get has_bom() {
        return this.has_pcb || this.has_sch;
    }
    on_full_windows() {
        if (window.is_module_lib) {
            console.log("is_module_lib " + window.is_module_lib);
            return show_ecad_viewer();
        }

        if (!this.#is_full_screen) {
            window.document.documentElement.requestFullscreen();
            this.#is_full_screen = true;
        } else {
            window.document.exitFullscreen();
            this.#is_full_screen = false;
        }
        if (this.#ov_d_app) this.#ov_d_app.on_show();
    }

    override render() {
        this.#file_input = html` <input
            type="file"
            id="fileInput"
            style="display: none"
            multiple />` as HTMLInputElement;
        this.#spinner = html`<ecad-spinner></ecad-spinner>` as HTMLElement;
        if (!this.loaded) return this.#spinner;
        this.#spinner.hidden = true;
        this.#tab_contents = {};

        this.#tab_header = new TabHeaderElement({
            has_3d: this.has_3d,
            has_pcb: this.has_pcb,
            sch_count: this.sch_count,
            has_bom: this.has_bom,
            active_tab: this.#user_selected_tab ? this.#active_tab : undefined,
        });

        if (window.hide_header || !this.showHeader) {
            this.#tab_header.hidden = true;
        }

        this.#tab_header.input_container = this;
        this.#tab_header.addEventListener(TabActivateEvent.type, (event) => {
            const tab = (event as TabActivateEvent).detail;
            console.log(
                "[ECadViewer] TabActivateEvent received: previous=",
                tab.previous,
                "current=",
                tab.current,
                "userInitiated=",
                tab.userInitiated,
                "initial_tab_set=",
                this.#initial_tab_set,
            );
            if (tab.userInitiated) {
                this.#user_selected_tab = true;
                this.#initial_tab_set = true;
            } else if (!this.#initial_tab_set) {
                this.#initial_tab_set = true;
                this.#user_selected_tab = true;
                console.log(
                    "[ECadViewer] First automatic tab activation recorded - future renders will preserve tab:",
                    tab.current,
                );
            }
            this.#active_tab = tab.current;
            this.dispatchEvent(new TabActivateEvent(tab));
            if (tab.previous) {
                switch (tab.previous) {
                    case TabKind.pcb:
                        if (this.#board_app)
                            this.#board_app.tabMenuHidden = true;
                        break;
                    case TabKind.sch:
                        if (this.#schematic_app)
                            this.#schematic_app.tabMenuHidden = true;
                        break;
                    case TabKind.bom:
                        break;
                    case TabKind.step:
                        break;
                }
            }

            Object.values(this.#tab_contents).forEach((i) => {
                i.classList.remove("active");
            });
            this.#tab_contents[tab.current]?.classList.add("active");
            this.#apply_viewer_activity();

            if (tab.current === TabKind.step) {
                if (this.#ov_d_app) {
                    // Only resize if the viewer is actually visible (model loaded)
                    if (this.#ov_d_app.style.display !== "none") {
                        this.#ov_d_app.on_show();
                    }
                } else {
                    (async () => {
                        // @ts-expect-error its imported from map
                        await import("3d-viewer");
                        this.#ov_d_app =
                            html`<ecad-3d-viewer></ecad-3d-viewer>` as Online3dViewer;
                        this.#viewers_container.appendChild(this.#ov_d_app);
                        const page = embed_to_tab(this.#ov_d_app, TabKind.step);
                        page.classList.add("active");
                        page.style.display = "none";
                        const onLoaded = () => {
                            console.log(
                                "[ECadViewer] Online3dViewerLoaded received, showing 3D viewer",
                            );
                            this.#step_viewer_placeholder.hidden = true;
                            this.#ov_d_app.style.display = "";
                            this.#ov_d_app.on_show();
                            this.project.removeEventListener(
                                Online3dViewerLoaded.type,
                                onLoaded,
                            );
                        };
                        this.project.addEventListener(
                            Online3dViewerLoaded.type,
                            onLoaded,
                        );
                    })();
                }
            }
        });

        this.#tab_header.addEventListener(TabMenuClickEvent.type, (event) => {
            const tab = (event as TabMenuClickEvent).detail;
            switch (tab) {
                case TabKind.pcb:
                    this.#board_app.tabMenuHidden =
                        !this.#board_app.tabMenuHidden;
                    break;
                case TabKind.sch:
                    this.#schematic_app.tabMenuHidden =
                        !this.#schematic_app.tabMenuHidden;
                    break;
                case TabKind.bom:
                    break;
            }
        });

        this.#tab_header.addEventListener(OpenBarrierEvent.type, (event) => {
            if (this.#spinner) {
                this.#spinner.hidden = false;
                this.#content.hidden = true;
            }
        });

        const embed_to_tab = (page: HTMLElement, index: TabKind) => {
            this.#tab_contents[index] = page;
            page.classList.add("tab-content");
            page.addEventListener(TabMenuVisibleChangeEvent.type, (event) => {
                const visible = (event as TabMenuVisibleChangeEvent).detail;
                this.#tab_header.tabMenuChecked = visible;
            });
            return page;
        };

        if (this.has_pcb) {
            this.#board_app = html`<kc-board-app>
            </kc-board-app>` as KCBoardAppElement;
            this.#board_app.showPropertyPanel = this.showSelectionPanel;
            embed_to_tab(this.#board_app, TabKind.pcb);
            this.#board_app.addEventListener(
                KiCanvasSelectEvent.type,
                (event) => this.#relay_board_selection(event),
            );
            this.#board_app.addEventListener(
                EcadOverlayClickEvent.type,
                (event) => this.#relay_overlay_event(EcadOverlayClickEvent, event),
            );
            this.#board_app.addEventListener(
                EcadOverlayHoverEvent.type,
                (event) => this.#relay_overlay_event(EcadOverlayHoverEvent, event),
            );
            this.#board_app.addEventListener(
                EcadOverlayLeaveEvent.type,
                (event) => this.#relay_overlay_event(EcadOverlayLeaveEvent, event),
            );
            this.#board_app.addEventListener(
                EcadCommentAreaEvent.type,
                (event) => this.#relay_comment_area_event(event),
            );
            if (!this.#project.has_3d) {
                try {
                    this.#project
                        .get_file_text(
                            this.#project.get_first_page(AssertType.PCB)!
                                .filename,
                        )
                        .then((v) => {
                            if (v)
                                window.dispatchEvent(new BoardContentReady(v));
                        });
                } catch (e) {
                    alert(e);
                }
            }
        }

        if (this.has_sch) {
            this.#schematic_app = html`<kc-schematic-app>
            </kc-schematic-app>` as KCSchematicAppElement;
            this.#schematic_app.showPropertyPanel = this.showSelectionPanel;
            this.#tab_contents[TabKind.sch] = this.#schematic_app;
            embed_to_tab(this.#schematic_app, TabKind.sch);
            this.#schematic_app.addEventListener(
                KiCanvasSelectEvent.type,
                (event) => this.#relay_schematic_selection(event),
            );
            this.#schematic_app.addEventListener(
                EcadOverlayClickEvent.type,
                (event) => this.#relay_overlay_event(EcadOverlayClickEvent, event),
            );
            this.#schematic_app.addEventListener(
                EcadOverlayHoverEvent.type,
                (event) => this.#relay_overlay_event(EcadOverlayHoverEvent, event),
            );
            this.#schematic_app.addEventListener(
                EcadOverlayLeaveEvent.type,
                (event) => this.#relay_overlay_event(EcadOverlayLeaveEvent, event),
            );
            this.#schematic_app.addEventListener(
                EcadCommentAreaEvent.type,
                (event) => this.#relay_comment_area_event(event),
            );
            this.#schematic_app.addEventListener(SheetLoadEvent.type, (e) => {
                this.#tab_header.dispatchEvent(new SheetLoadEvent(e.detail));
                // Re-dispatch from viewer so visualizer can track active sheet
                this.dispatchEvent(new SheetLoadEvent(e.detail));
            });
        }

        if (this.has_3d) {
            this.#step_viewer_placeholder =
                html`<ecad-spinner></ecad-spinner>` as HTMLElement;
            embed_to_tab(this.#step_viewer_placeholder, TabKind.step);
        }
        if (this.has_bom) {
            this.#bom_app = new BomApp();
            embed_to_tab(this.#bom_app, TabKind.bom);
        }

        this.#viewers_container = html` <div class="vertical">
            ${this.#board_app} ${this.#schematic_app} ${this.#bom_app}
            ${this.#step_viewer_placeholder}
        </div>` as HTMLDivElement;

        this.#content = html` <div class="vertical">
            ${this.#tab_header} ${this.#viewers_container}
            <a
                href=${window.ai_url}
                class="bottom-left-icon"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Visit EDA website">
                ${HQ_LOGO}
            </a>
        </div>` as HTMLElement;
        return html` ${this.#content} ${this.#spinner} `;
    }

    override renderedCallback() {
        window.requestAnimationFrame(() => {
            this.#apply_viewer_activity();
            this.#restore_overlay_scenes();
        });
    }
}

window.customElements.define("ecad-viewer", ECadViewer);

class EcadSourceElement extends CustomElement {
    constructor() {
        super();
        this.ariaHidden = "true";
        this.hidden = true;
        this.style.display = "none";
    }

    @attribute({ type: String })
    src: string | null;
}

window.customElements.define("ecad-source", EcadSourceElement);

class EcadBlobElement extends CustomElement {
    constructor() {
        super();
        this.ariaHidden = "true";
        this.hidden = true;
        this.style.display = "none";
    }

    @attribute({ type: String })
    filename: string;

    @attribute({ type: String })
    content: string;
}

window.customElements.define("ecad-blob", EcadBlobElement);

class Ov3dElement extends CustomElement {
    constructor() {
        super();
        this.ariaHidden = "true";
        this.hidden = true;
        this.style.display = "none";
    }

    @attribute({ type: String })
    src: string | null;
}
window.customElements.define("ecad-3d-source", Ov3dElement);

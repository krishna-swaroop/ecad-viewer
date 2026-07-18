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
import {
    AssertType,
    Project,
    getParserPerfSnapshot,
} from "../kicanvas/project";
import { type EcadBlob, type EcadSources } from "../kicanvas/services/vfs";
import { KCBoardAppElement } from "../kicanvas/elements/kc-board/app";
import { KCSchematicAppElement } from "../kicanvas/elements/kc-schematic/app";
import { BomApp } from "../kicanvas/elements/bom/app";
import { KicadPCB, KicadSch } from "../kicad";

import { is_3d_model, is_kicad, TabHeaderElement } from "./tab_header";
import {
    BoardContentReady,
    EcadCommentAreaEvent,
    EcadOverlayClickEvent,
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
    COMMENT_OVERLAY_CHANNELS,
    EcadCommentOverlayClickEvent,
    comment_id_from_primitive,
    comment_overlay_scene,
    type EcadCommentContext,
    type EcadCommentOverlayHitDetail,
    type EcadCommentOverlaySet,
} from "./comment-overlay";
import {
    EcadCrossProbeEvent,
    EcadSemanticSelectionEvent,
    normalize_board_selection,
    normalize_schematic_selection,
    promote_pad_to_net_detail,
    type EcadCrossProbeRequest,
    type EcadSemanticSelectionDetail,
    type EcadSourceUpdate,
} from "./host-adapter";
import {
    EcadDocumentComparisonFrameEvent,
    EcadDocumentComparisonReadyEvent,
    prepareComparisonDocument,
    type EcadDocumentComparisonPreparation,
    type EcadDocumentComparisonRequest,
    type EcadDocumentComparisonSelection,
    type EcadDocumentComparisonSelectionResult,
} from "./document-comparison";
import { build_diff_presentation } from "../viewers/base/diff-presentation";
import type { EcadDiffPresentation } from "../viewers/base/diff-presentation";
import type { PaintableDocument } from "../viewers/base/painter";
import { ecadPerfLog } from "../kicanvas/perf_log";

export type {
    EcadCrossProbeRequest,
    EcadHostContext,
    EcadSemanticSelectionDetail,
    EcadSourceUpdate,
} from "./host-adapter";
export {
    EcadCrossProbeEvent,
    EcadSemanticSelectionEvent,
} from "./host-adapter";
export type {
    EcadCommentAnchor,
    EcadCommentContext,
    EcadCommentOverlay,
    EcadCommentOverlayHitDetail,
    EcadCommentOverlaySet,
} from "./comment-overlay";
export { EcadCommentOverlayClickEvent } from "./comment-overlay";
export type {
    EcadDocumentComparisonPreparation,
    EcadDocumentComparisonRequest,
    EcadDocumentComparisonSelection,
    EcadDocumentComparisonSelectionResult,
    EcadPreparedDiffTarget,
} from "./document-comparison";
export {
    EcadDocumentComparisonFrameEvent,
    EcadDocumentComparisonReadyEvent,
    buildDocumentComparisonTargets,
    prepareComparisonDocument,
    selectComparisonDocument,
} from "./document-comparison";
export type {
    EcadDocumentDiffIndex,
    EcadDiffCategory,
    EcadDiffGroup,
    EcadIndexedChange,
    KiCadChangeKind,
    KiCadDiffValue,
    KiCadDocumentDiff,
    KiCadItemChange,
    KiCadProjectDiff,
    KiCadPropertyDelta,
} from "./document-diff";
export {
    bbox_to_world,
    buildDocumentDiffIndex,
    change_category,
    document_units,
    parseKiCadDocumentDiff,
    parseKiCadProjectDiff,
    split_kiid_path,
} from "./document-diff";

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

/**
 * Value-based camera state exposed by <ecad-viewer>. Plain POD so consumers
 * never depend on the internal Camera2/Vec2/Angle types. `x`/`y` are the world
 * center, `zoom` the scale factor, `rotation` in radians.
 */
export interface CameraState {
    x: number;
    y: number;
    zoom: number;
    rotation: number;
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
                height: 100%;
                background-color: white;
                color: var(--fg);
                contain: layout paint;
            }

            /* Opt-in A4 letterbox for standalone embeds. Forced aspect-ratio on
               :host shrinks the viewer in sized Prism panes and desyncs the
               first camera fit from the final layout. */
            :host(.aspect-a4) {
                height: auto;
                max-height: 100%;
                aspect-ratio: 1.414;
            }

            .vertical {
                display: flex;
                flex-direction: column;
                height: 100%;
                width: 100%;
                /* :host is a flex row; content must own full width or it shares
                   space with the spinner sibling and collapses. */
                flex: 1 1 100%;
                min-width: 0;
                overflow: hidden;
            }

            /* Spinner overlays; must not consume flex width beside content. */
            ecad-spinner {
                position: absolute;
                inset: 0;
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
        this.addDisposable(this.#reference_project);
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
    #reference_project: Project = new Project();
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
    #comment_overlay_scenes = new Map<EcadCommentContext, EcadOverlayScene>();
    #active_schematic_project_path: string | null = null;
    #document_comparison: EcadDocumentComparisonPreparation | null = null;
    #document_comparison_key: string | null = null;
    #document_comparison_revision_keys: {
        reference: string;
        comparison: string;
    } | null = null;
    #document_comparison_cache = new Map<
        string,
        {
            preparation: EcadDocumentComparisonPreparation;
            presentation: EcadDiffPresentation;
            comparisonDocument: PaintableDocument & { filename: string };
        }
    >();
    #document_comparison_request_id = 0;
    static readonly #DIFF_SELECTION_CHANNEL = ":document-diff:selection";
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

    /**
     * Parse both immutable revisions concurrently, retain the comparison
     * document as the only normal scene, inject removed native reference
     * objects, and install the fixed KiCad-style A/R/M paint presentation.
     */
    public async loadDocumentComparison(
        request: EcadDocumentComparisonRequest,
    ): Promise<EcadDocumentComparisonPreparation> {
        const started = performance.now();
        const prepared = prepareComparisonDocument(
            request.diff,
            request.documentPath,
        );
        this.#document_comparison_request_id += 1;
        this.#document_comparison = null;
        const same_sources =
            this.#document_comparison_key === request.comparisonKey &&
            this.#document_comparison_revision_keys?.reference ===
                request.reference.revisionKey &&
            this.#document_comparison_revision_keys?.comparison ===
                request.comparison.revisionKey;
        const cached = same_sources
            ? this.#document_comparison_cache.get(prepared.document.path)
            : undefined;
        if (cached) {
            const viewer = this.#viewer_for_context(cached.preparation.context);
            if (!viewer) {
                throw new Error(
                    `The ${cached.preparation.context} comparison viewer is not ready`,
                );
            }
            if (
                cached.preparation.context === "SCH" &&
                this.#active_tab !== TabKind.sch
            ) {
                await this.#switchToTab(TabKind.sch);
            } else if (
                cached.preparation.context === "PCB" &&
                this.#active_tab !== TabKind.pcb
            ) {
                await this.#switchToTab(TabKind.pcb);
            }
            await viewer.load_diff_document(
                cached.comparisonDocument as never,
                cached.presentation,
            );
            const result = {
                ...cached.preparation,
                prepareMs: performance.now() - started,
                sourceCacheHit: true,
            };
            this.#document_comparison = result;
            this.dispatchEvent(new EcadDocumentComparisonReadyEvent(result));
            return result;
        }

        if (!same_sources) {
            this.#reference_project.reset();
            this.#document_comparison_cache.clear();
            await Promise.all([
                this.#reference_project.load({
                    urls: [],
                    blobs: request.reference.sources,
                }),
                this.replaceSources(request.comparison),
            ]);
            this.#document_comparison_key = request.comparisonKey;
            this.#document_comparison_revision_keys = {
                reference: request.reference.revisionKey,
                comparison: request.comparison.revisionKey,
            };
        }

        const path = prepared.document.path.replace(/^\.?\//, "");
        const reference_document =
            this.#reference_project.file_by_name(path) ??
            this.#reference_project.file_by_name(
                path.split("/").at(-1) ?? path,
            );
        const comparison_document =
            this.#project.file_by_name(path) ??
            this.#project.file_by_name(path.split("/").at(-1) ?? path);
        const expected_type = prepared.context === "SCH" ? KicadSch : KicadPCB;
        if (
            !(reference_document instanceof expected_type) ||
            !(comparison_document instanceof expected_type)
        ) {
            throw new TypeError(
                `Both revisions must contain ${prepared.document.path}`,
            );
        }

        if (prepared.context === "SCH") {
            await this.showPage(comparison_document.filename);
        } else if (this.#active_tab !== TabKind.pcb) {
            await this.#switchToTab(TabKind.pcb);
        }

        const viewer = this.#viewer_for_context(prepared.context);
        if (!viewer) {
            throw new Error(
                `The ${prepared.context} comparison viewer is not ready`,
            );
        }
        const presentation = build_diff_presentation(
            prepared.index,
            reference_document,
            comparison_document,
        );
        await viewer.load_diff_document(
            comparison_document as never,
            presentation,
        );

        const result: EcadDocumentComparisonPreparation = {
            comparisonKey: request.comparisonKey,
            context: prepared.context,
            document: prepared.document,
            targets: prepared.targets,
            diagnostics: presentation.diagnostics,
            prepareMs: performance.now() - started,
            sourceCacheHit: same_sources,
        };
        this.#document_comparison_cache.set(prepared.document.path, {
            preparation: result,
            presentation,
            comparisonDocument,
        });
        this.#document_comparison = result;
        ecadPerfLog(
            `document comparison ready context=${result.context} changes=${prepared.index.changes.length} targets=${result.targets.size} prepare=${result.prepareMs.toFixed(1)}ms diagnostics=${result.diagnostics.length}`,
        );
        this.dispatchEvent(new EcadDocumentComparisonReadyEvent(result));
        return result;
    }

    /**
     * Apply one precomputed selection frame. This method never parses, repaints
     * the document, or walks the diff tree.
     */
    public async selectDocumentDiff(
        selection: EcadDocumentComparisonSelection,
    ): Promise<EcadDocumentComparisonSelectionResult> {
        const started = performance.now();
        const requestId = ++this.#document_comparison_request_id;
        const parserBefore = getParserPerfSnapshot().parserInvocations;
        const comparison = this.#document_comparison;
        const target = comparison?.targets.get(
            `${selection.kind}:${selection.id}`,
        );
        const viewer = comparison
            ? this.#viewer_for_context(comparison.context)
            : null;
        if (!comparison || !target || !viewer) {
            return {
                status: "missing",
                requestId,
                clickToFrameMs: performance.now() - started,
                paintCount: viewer?.paint_count ?? 0,
                parserCount:
                    getParserPerfSnapshot().parserInvocations - parserBefore,
            };
        }

        const paintBefore = viewer.paint_count;
        const [x, y, w, h] = target.bounds;
        viewer.set_overlay_scene(
            {
                channelId: ECadViewer.#DIFF_SELECTION_CHANNEL,
                context: comparison.context,
                placement: "foreground",
                visible: true,
                primitives: [
                    {
                        id: `selected:${target.kind}:${target.id}`,
                        kind: "bbox",
                        anchor: { kind: "bbox", bounds: target.bounds },
                        stroke: "#2f80ed",
                        fill: "#2f80ed16",
                        strokeWidth: 0.3,
                        padding: Math.max(w, h) * 0.06,
                        sizing: "world",
                    },
                ],
            },
            false,
        );
        const padding = Math.max(Math.max(w, h) * 0.35, 2);
        viewer.viewport.camera.bbox = new BBox(
            x - padding,
            y - padding,
            w + padding * 2,
            h + padding * 2,
        );
        viewer.draw();

        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
        );
        const result: EcadDocumentComparisonSelectionResult = {
            status:
                requestId === this.#document_comparison_request_id
                    ? "applied"
                    : "superseded",
            requestId,
            target,
            clickToFrameMs: performance.now() - started,
            paintCount: viewer.paint_count - paintBefore,
            parserCount:
                getParserPerfSnapshot().parserInvocations - parserBefore,
        };
        ecadPerfLog(
            `document diff frame request=${requestId} status=${result.status} target=${target.kind}:${target.id} clickToFrame=${result.clickToFrameMs.toFixed(1)}ms paint=${result.paintCount} parse=${result.parserCount}`,
        );
        this.dispatchEvent(new EcadDocumentComparisonFrameEvent(result));
        return result;
    }

    public clearDocumentComparison(): void {
        this.#document_comparison_request_id += 1;
        this.#document_comparison = null;
        this.#document_comparison_key = null;
        this.#document_comparison_revision_keys = null;
        this.#document_comparison_cache.clear();
        for (const context of ["SCH", "PCB"] as const) {
            const viewer = this.#viewer_for_context(context);
            viewer?.clear_overlay_scene(ECadViewer.#DIFF_SELECTION_CHANNEL);
            viewer?.set_diff_presentation(null);
        }
        this.#reference_project.reset();
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

    /**
     * Publish comment markers and optional comment areas. Arbitrary graphics
     * are intentionally not exposed at the host boundary.
     */
    public setCommentOverlays(request: EcadCommentOverlaySet): void {
        const scene = comment_overlay_scene(request);
        this.#comment_overlay_scenes.set(request.context, scene);
        this.#viewer_for_context(request.context)?.set_overlay_scene(scene);
    }

    public clearCommentOverlays(context?: EcadCommentContext): void {
        const contexts: EcadCommentContext[] = context
            ? [context]
            : ["SCH", "PCB"];
        for (const target of contexts) {
            this.#comment_overlay_scenes.delete(target);
            this.#viewer_for_context(target)?.clear_overlay_scene(
                COMMENT_OVERLAY_CHANNELS[target],
            );
        }
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
                    // Prefer stable net *name*. Host/3D netCode is only used when
                    // it matches an entry in the board nets table (KiCad 10 boards
                    // synthesize codes from names; 3D ids are not interchangeable).
                    const by_name = requested_name
                        ? board_viewer.board.nets.find(
                              (net) => net.name === requested_name,
                          )
                        : undefined;
                    const by_code =
                        request.netCode != null
                            ? board_viewer.board.nets.find(
                                  (net) => net.number === request.netCode,
                              )
                            : undefined;
                    let net_code = by_name?.number ?? by_code?.number;
                    if (net_code === undefined && requested_name) {
                        for (const fp of board_viewer.board.footprints) {
                            for (const pad of fp.pads ?? []) {
                                if (pad.net?.name === requested_name) {
                                    net_code = pad.net.number;
                                    break;
                                }
                            }
                            if (net_code !== undefined) break;
                        }
                    }
                    // Resolve via copper uuid from the semantic index when present.
                    if (net_code === undefined && request.uuids?.length) {
                        const ids = new Set(request.uuids);
                        for (const segment of board_viewer.board.segments) {
                            const id = segment.uuid || segment.tstamp;
                            if (id && ids.has(id) && segment.net) {
                                net_code = segment.net;
                                break;
                            }
                        }
                        if (net_code === undefined) {
                            for (const via of board_viewer.board.vias) {
                                const id = via.uuid || via.tstamp;
                                if (id && ids.has(id) && via.net) {
                                    net_code = via.net;
                                    break;
                                }
                            }
                        }
                    }
                    if (net_code !== undefined) {
                        board_viewer.focus_net(net_code, false);
                        return true;
                    }
                } else {
                    // Prefer designator — semantic footprint UUIDs are not always
                    // present, and a schematic symbol UUID must not win the lookup.
                    const by_ref = board_viewer.board.find_footprint(
                        request.designator ?? value,
                    );
                    const by_uuid = request.uuid
                        ? board_viewer.board.find_footprint(request.uuid)
                        : null;
                    const footprint = by_ref ?? by_uuid;
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
     * When set, the viewer suppresses its own built-in chrome — the
     * properties/objects/nets panels, the layer "fitter" tab-view, and the
     * bottom-left badge — leaving just the canvas. This lets a host application
     * render its own UI over a bare viewer without fighting the built-in panels.
     */
    @attribute({ type: Boolean })
    public "hide-chrome": boolean;

    // The page the host last requested via showPage()/switchPage(). Re-applied
    // after the project finishes loading so a post-init auto-load can't override
    // the caller's choice.
    #desired_page?: string;

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
        this.#emit_camera_change();
    }

    // ------------------------------------------------------------------
    // Focus API
    // ------------------------------------------------------------------

    /**
     * Fit the active viewer's camera to a world-space bbox and resolve with the
     * settled camera (the bbox setter defers the zoom/center computation to the
     * next paint, so we sample it a frame later).
     */
    public async focusBBox(
        x: number,
        y: number,
        w: number,
        h: number,
    ): Promise<CameraState | null> {
        const v = this.#active_inner_viewer();
        const cam = v?.viewport?.camera;
        if (!cam) return null;
        cam.bbox = new BBox(x, y, w, h);
        v.draw?.();
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        this.#emit_camera_change();
        return this.camera;
    }

    /**
     * Focus an item by uuid: resolve its bbox inside the active viewer, fit the
     * camera to it (grown a little), and optionally select/highlight it.
     * Resolves with the settled camera, or null if the item can't be resolved.
     */
    public async focusItem(
        uuid: string,
        opts?: { select?: boolean; pad?: number },
    ): Promise<CameraState | null> {
        const v: any = this.#active_inner_viewer();
        if (!v) return null;
        const pad = opts?.pad ?? 20;
        const bbox =
            v.schematic_renderer?.get_item_bbox?.(uuid) ??
            v.get_item_bbox?.(uuid) ??
            null;
        if (!bbox) return null;
        v.viewport.camera.bbox = bbox.grow(pad);
        if (opts?.select && typeof v.paint_selected === "function") {
            v.paint_selected(bbox);
        }
        v.draw?.();
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        this.#emit_camera_change();
        return this.camera;
    }

    /**
     * Convenience cross-probe: focus + highlight by designator/uuid in the
     * ACTIVE viewer. Structured hosts should prefer requestCrossProbe().
     */
    public async crossProbe(reference: string): Promise<CameraState | null> {
        const v: any = this.#active_inner_viewer();
        if (!v) return null;

        const board = v.board as
            | {
                  find_footprint?: (
                      r: string,
                  ) => { uuid?: string; bbox?: BBox } | null;
              }
            | undefined;
        if (board?.find_footprint) {
            const fp = board.find_footprint(reference);
            if (!fp?.bbox) return null;
            if (typeof v.highlight_fp === "function") v.highlight_fp(fp);
            const b = fp.bbox;
            v.viewport.camera.bbox = b.grow(b.w * 0.5, b.h * 0.5);
            v.draw?.();
            await new Promise<void>((r) => requestAnimationFrame(() => r()));
            this.#emit_camera_change();
            return this.camera;
        }

        const doc = v.document as
            | { find_symbol?: (r: string) => { uuid?: string } | null }
            | undefined;
        if (doc?.find_symbol) {
            const sym = doc.find_symbol(reference);
            if (!sym?.uuid) return null;
            return this.focusItem(sym.uuid, { select: true });
        }

        return null;
    }

    // ------------------------------------------------------------------
    // Camera API (value-based seam)
    // ------------------------------------------------------------------

    /** The inner viewer for the currently-active tab (or the only loaded one). */
    #active_inner_viewer(): any | null {
        const v =
            this.#active_tab === TabKind.pcb && this.#board_app?.viewer
                ? this.#board_app.viewer
                : this.#active_tab === TabKind.sch &&
                    this.#schematic_app?.viewer
                  ? this.#schematic_app.viewer
                  : (this.#board_app?.viewer ??
                    this.#schematic_app?.viewer ??
                    null);
        this.#ensure_camera_hook(this.#board_app?.viewer);
        this.#ensure_camera_hook(this.#schematic_app?.viewer);
        return v;
    }

    /**
     * Idempotently wrap a viewer's `on_viewport_change` so any camera move
     * (user pan/zoom included) re-emits a `camerachange` event on the host.
     */
    #ensure_camera_hook(viewer: any | undefined): void {
        if (!viewer || viewer.__camerachange_hooked) return;
        if (typeof viewer.on_viewport_change !== "function") return;
        const orig = viewer.on_viewport_change.bind(viewer);
        viewer.on_viewport_change = () => {
            orig();
            this.#emit_camera_change();
        };
        viewer.__camerachange_hooked = true;
    }

    public get camera(): CameraState | null {
        const v = this.#active_inner_viewer();
        const cam = v?.viewport?.camera;
        if (!cam) return null;
        return {
            x: cam.center.x,
            y: cam.center.y,
            zoom: cam.zoom,
            rotation: cam.rotation?.radians ?? 0,
        };
    }

    public set camera(state: CameraState | null) {
        if (!state) return;
        const v = this.#active_inner_viewer();
        const cam = v?.viewport?.camera;
        if (!cam) return;
        cam.center.set(state.x, state.y);
        cam.zoom = state.zoom;
        if (state.rotation != null && cam.rotation)
            cam.rotation.radians = state.rotation;
        v.draw?.();
        this.#emit_camera_change();
    }

    /** Dispatch a composed `camerachange` event carrying the current camera. */
    #emit_camera_change = () => {
        const detail = this.camera;
        if (!detail) return;
        this.dispatchEvent(
            new CustomEvent("camerachange", {
                detail,
                bubbles: true,
                composed: true,
            }),
        );
    };

    /**
     * Resolves once the project has finished loading (parse + first paint).
     */
    public get ready(): Promise<void> {
        return this.#project.loaded.then(() => undefined);
    }

    #resolve_schematic_page(pageId: string) {
        return this.#project.pages.find(
            (candidate) =>
                candidate.project_path === pageId ||
                candidate.filename === pageId ||
                candidate.name === pageId ||
                candidate.page === pageId,
        );
    }

    /**
     * Switch the schematic view to a specific page and resolve once applied.
     * Awaits project readiness first. Uses the instance-tree page model.
     */
    public async showPage(pageId: string): Promise<void> {
        this.#desired_page = pageId;
        await this.ready;
        await this.#apply_desired_page();
    }

    async #apply_desired_page(): Promise<void> {
        const pageId = this.#desired_page;
        if (!pageId || !this.#schematic_app) return;
        const page = this.#resolve_schematic_page(pageId);
        if (!page) {
            console.warn(`showPage: Could not find page with ID ${pageId}`);
            return;
        }
        if (this.#active_tab !== TabKind.sch && this.has_sch) {
            await this.#switchToTab(TabKind.sch);
        }
        this.#activate_schematic_page(page.project_path);
    }

    /**
     * Switch to a specific schematic page (by filename or sheet path).
     * Synchronous path used by Prism today; also records the desired page for
     * post-load reconcile.
     */
    public switchPage(pageId: string): boolean {
        this.#desired_page = pageId;
        if (!this.#schematic_app) return false;
        const page = this.#resolve_schematic_page(pageId);
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
            | "SCH"
            | "PCB"
            | "3D"
            | "BOM",
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
            // If the host already asked for a specific page via showPage/switchPage,
            // re-apply it after the post-load auto-activate of the root sheet.
            if (this.#desired_page) void this.#apply_desired_page();
            this.#ensure_camera_hook(this.#board_app?.viewer);
            this.#ensure_camera_hook(this.#schematic_app?.viewer);
            // Post-load autofit / first paint should notify camera consumers.
            this.#emit_camera_change();
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

    #restore_comment_overlay_scenes() {
        for (const scene of this.#comment_overlay_scenes.values()) {
            this.#viewer_for_context(scene.context)?.set_overlay_scene(scene);
        }
    }

    #relay_board_selection(event: Event) {
        event.stopPropagation();
        const select = event as KiCanvasSelectEvent;
        const item = select.detail.item;
        if (!item) return;
        const viewer = this.#safe_board_viewer();
        const board = viewer?.board;
        if (!board) return;
        let detail = normalize_board_selection(item, board);
        if (!detail) return;
        this.#attach_item_bounds_pcb(detail, item, viewer!);
        const intent = select.detail.intent ?? "select";
        if (intent === "crossprobe") {
            detail = promote_pad_to_net_detail(detail);
            this.dispatchEvent(new EcadCrossProbeEvent(detail));
            return;
        }
        this.dispatchEvent(new EcadSemanticSelectionEvent(detail));
    }

    #relay_schematic_selection(event: Event) {
        event.stopPropagation();
        const select = event as KiCanvasSelectEvent;
        const item = select.detail.item;
        if (!item) return;
        const viewer = this.#safe_schematic_viewer();
        const schematic = viewer?.schematic;
        if (!schematic) return;
        const detail = normalize_schematic_selection(item, schematic);
        if (!detail) return;
        this.#attach_item_bounds_sch(detail, item, viewer!);
        const intent = select.detail.intent ?? "select";
        if (intent === "crossprobe") {
            this.dispatchEvent(new EcadCrossProbeEvent(detail));
            return;
        }
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

    #relay_comment_overlay_click(event: Event): void {
        event.stopPropagation();
        const hit = (event as EcadOverlayClickEvent).detail;
        const expected = COMMENT_OVERLAY_CHANNELS[hit.context];
        if (hit.channelId !== expected) return;
        const detail: EcadCommentOverlayHitDetail = {
            commentId: comment_id_from_primitive(hit.primitiveId),
            context: hit.context,
            x: hit.resolvedAnchor.x,
            y: hit.resolvedAnchor.y,
            bounds: hit.resolvedAnchor.bounds,
            page: hit.resolvedAnchor.page,
            metadata: hit.metadata,
        };
        this.dispatchEvent(new EcadCommentOverlayClickEvent(detail));
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
        // Semantic indexes sometimes use "/" as a root sentinel — that is not
        // a loadable schematic filename.
        if (sheet === "/" || sheet === "") sheet = undefined;
        let uuid = request.uuid ?? request.uuids?.[0];
        if (request.kind === "net") {
            const refs =
                this.#project.find_labels_by_name(request.net ?? value) ?? [];
            // Deterministic: prefer requested sheet, else first by sheet name.
            const preferred = sheet;
            const sorted = [...refs].sort((a, b) =>
                (a.sheet_name || "").localeCompare(b.sheet_name || ""),
            );
            const ref =
                (preferred
                    ? sorted.find((entry) => entry.sheet_name === preferred)
                    : undefined) ?? sorted[0];
            sheet ??= ref?.sheet_name;
            if (sheet === "/" || sheet === "") sheet = undefined;
            uuid ??= ref?.uuid;
            // Fall back to any provided wire/label uuid list from the host.
            uuid ??= request.uuids?.find(Boolean);
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
        if (!uuid) {
            return false;
        }

        const focus = () => {
            const candidates = [
                uuid!,
                ...(request.uuids ?? []).filter((id) => id && id !== uuid),
            ];
            for (const id of candidates) {
                const bbox = viewer.schematic_renderer.get_item_bbox(id);
                if (bbox) {
                    viewer.zoom_fit_item(id);
                    return;
                }
            }
        };
        if (sheet && sheet !== viewer.sch_name) {
            const page = this.#resolve_schematic_page(sheet);
            const target =
                (page?.document instanceof KicadSch ? page.document : null) ??
                this.#project.file_by_name(sheet);
            if (target instanceof KicadSch) {
                if (page) this.#activate_schematic_page(page.project_path);
                void viewer.load(target).then(focus);
                return true;
            }
            // Invalid sheet sentinel — still focus on the current sheet.
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
            this.#ensure_camera_hook(this.#board_app?.viewer);
            this.#ensure_camera_hook(this.#schematic_app?.viewer);
            this.#emit_camera_change();

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
                (event) => this.#relay_comment_overlay_click(event),
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
                (event) => this.#relay_comment_overlay_click(event),
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

        // Optional headless mode: suppress the viewer's own built-in chrome so a
        // host app can render its own UI over a bare canvas. Nested shadow-root
        // chrome is toggled via the `headless` flag on inner apps.
        const chrome_style = this["hide-chrome"]
            ? (html`<style>
                  tab-header,
                  .bottom-left-icon {
                      display: none !important;
                  }
              </style>` as HTMLStyleElement)
            : "";
        if (this["hide-chrome"]) {
            if (this.#board_app)
                (
                    this.#board_app as unknown as { headless?: boolean }
                ).headless = true;
            if (this.#schematic_app)
                (
                    this.#schematic_app as unknown as { headless?: boolean }
                ).headless = true;
        }
        return html` ${chrome_style} ${this.#content} ${this.#spinner} `;
    }

    override renderedCallback() {
        window.requestAnimationFrame(() => {
            this.#apply_viewer_activity();
            this.#restore_comment_overlay_scenes();
            this.#ensure_camera_hook(this.#board_app?.viewer);
            this.#ensure_camera_hook(this.#schematic_app?.viewer);
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
    // Attributes must not be set in the constructor — React's
    // document.createElement("ecad-blob") throws NotSupportedError otherwise.
    override connectedCallback() {
        super.connectedCallback?.();
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

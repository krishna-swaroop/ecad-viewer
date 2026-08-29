import type { boardProto, schematicProto } from "kicad-parser";
import type { KiCanvasProbeDetail } from "../../ecad-viewer-app/src/viewers/base/events";
import type {
    ProbeHighlightState,
    ViewerNavigationOptions,
} from "../../ecad-viewer-app/src/viewers/base/viewer";

/** Existing parser POD types; no renderer-specific model is introduced. */
export type Pcb = boardProto.I_KicadPCB;
export type Footprint = boardProto.I_Footprint;
export type Schematic = schematicProto.I_KicadSch;
export type Symbol = schematicProto.I_LibSymbol;
export type ProbeEvent = KiCanvasProbeDetail;
export type RenderNavigationOptions = ViewerNavigationOptions;

export interface RenderController {
    zoomBy(factor: number): void;
    resetView(): void;
    /** Returns the number of source objects highlighted for this index. */
    setProbeHighlight(index: string, state: ProbeHighlightState): number;
    clearProbeHighlight(): void;
}

export interface RenderOptions {
    /** Canvas to render into. A canvas is created when omitted. */
    canvas?: HTMLCanvasElement;
    /** Attach a generated canvas to this element so it receives layout dimensions. */
    container?: HTMLElement;
    /** @deprecated Use selectable and navigation. */
    interactive?: boolean;
    selectable?: boolean;
    navigation?: Partial<RenderNavigationOptions>;
    onProbe?: (event: ProbeEvent) => void;
    /**
     * Which unit of a multi-unit symbol to draw. Defaults to 1.
     *
     * KiCad splits a multi-unit part (an opamp package, a relay) across units
     * that share one library entry, so a symbol preview is per unit, not per
     * symbol. Ignored by `renderFootprint`.
     */
    unit?: number;
}

export interface RenderResult<TViewer = unknown> {
    canvas: HTMLCanvasElement;
    controller: RenderController;
    viewer: TViewer;
    dispose(): void;
}

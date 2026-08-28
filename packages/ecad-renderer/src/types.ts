import type { boardProto, schematicProto } from "kicad-parser";

/** Existing parser POD types; no renderer-specific model is introduced. */
export type Pcb = boardProto.I_KicadPCB;
export type Footprint = boardProto.I_Footprint;
export type Schematic = schematicProto.I_KicadSch;
export type Symbol = schematicProto.I_LibSymbol;

export interface RenderOptions {
    /** Canvas to render into. A canvas is created when omitted. */
    canvas?: HTMLCanvasElement;
    /** Attach a generated canvas to this element so it receives layout dimensions. */
    container?: HTMLElement;
    interactive?: boolean;
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
    viewer: TViewer;
    dispose(): void;
}

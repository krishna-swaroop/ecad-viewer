import type { boardProto } from "kicad-parser";

import { renderPcb } from "./render";
import type { RenderOptions, RenderResult } from "./types";

/** Render one footprint through the existing board painter. */
export function renderFootprint(
    footprint: boardProto.I_Footprint,
    options: RenderOptions = {},
): Promise<RenderResult> {
    return renderPcb(
        {
            version: footprint.version ?? 20240108,
            title_block: { title: "", date: "", company: "", comments: [] },
            // `layers` is omitted, not empty: KicadPCB falls back to
            // DEFAULT_LAYERS only when the field is absent, and `[]` is truthy
            // so it would bypass the fallback and leave nothing to draw on.
            nets: [],
            footprints: [footprint],
            zones: [],
            segments: [],
            vias: [],
            drawings: [],
            groups: [],
        } as unknown as boardProto.I_KicadPCB,
        options,
    );
}

import { BoardParser, SchematicParser } from "kicad-parser";

import type { Footprint, Symbol } from "./types";

/**
 * Read a `.kicad_sym` library file.
 *
 * Returned in file order; a library legitimately holds several symbols, so the
 * caller chooses which to render.
 */
export function parseSymbolLibrary(text: string): Symbol[] {
    return new SchematicParser().parseLibSymbols(text);
}

/** Read a `.kicad_mod` file. */
export function parseFootprint(text: string): Footprint {
    return new BoardParser().parseFootprintFile(text);
}

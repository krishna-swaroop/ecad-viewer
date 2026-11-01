import { expose, transfer } from "comlink";
import { BoardParser, SchematicParser, split_board_bytes } from "kicad-parser";
import {
    triangulate_flat,
    triangulation_ready,
} from "../graphics/webgl/triangulate";

export class ParserWorker {
    set_perf_log(enabled: boolean) {
        (globalThis as any).__ECAD_PERF_LOG__ = !!enabled;
    }

    parse_board(buf: ArrayBuffer) {
        const content = new TextDecoder().decode(buf);
        return new BoardParser().parse(content);
    }

    /**
     * Split a board into `k` self-contained board sources for parallel
     * parsing (see kicad-parser's board_split.ts). Runs here rather than on
     * the main thread because it is a full pass over the file. The chunks
     * are transferred back, not copied.
     */
    split_board(buf: ArrayBuffer, k: number) {
        const chunks = split_board_bytes(new Uint8Array(buf), k).map((c) =>
            c.byteOffset === 0 && c.byteLength === c.buffer.byteLength
                ? (c.buffer as ArrayBuffer)
                : (c.slice().buffer as ArrayBuffer),
        );
        return transfer(chunks, chunks);
    }

    /**
     * Triangulate rings (interleaved xy) exactly as the WebGL tesselator
     * would, so large zone fills are done here, in parallel, instead of one
     * after another on the main thread during paint. Results are transferred.
     */
    async triangulate_rings(rings: Float64Array[]) {
        await triangulation_ready();
        const out = rings.map((ring) => triangulate_flat(ring));
        return transfer(
            out,
            out.map((v) => v.buffer as ArrayBuffer),
        );
    }

    parse_schematic(buf: ArrayBuffer) {
        const content = new TextDecoder().decode(buf);
        return new SchematicParser().parse(content);
    }
}

expose(new ParserWorker());

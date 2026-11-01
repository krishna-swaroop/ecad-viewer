/**
 * Parallel board parsing: split_board_bytes + merge_board_pods must give
 * exactly what one BoardParser.parse of the whole file gives, for every
 * board in the test tree and several chunk counts.
 */
import * as fs from "fs";
import * as path from "path";

import { BoardParser } from "../src/board_parser";
import { merge_board_pods, split_board_bytes } from "../src/board_split";

function boards(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...boards(full));
        else if (entry.name.endsWith(".kicad_pcb")) out.push(full);
    }
    return out;
}

const files = boards(__dirname).filter((f) => !f.includes("malformed"));
const decoder = new TextDecoder();

function split_parse(text: string, k: number) {
    const chunks = split_board_bytes(new TextEncoder().encode(text), k);
    const pods = chunks.map((c) => new BoardParser().parse(decoder.decode(c)));
    return { chunks: chunks.length, pod: merge_board_pods(pods) };
}

describe("split_board_bytes + merge_board_pods", () => {
    it("finds board fixtures to test", () => {
        expect(files.length).toBeGreaterThan(3);
    });

    for (const file of files) {
        const name = path.relative(__dirname, file);
        for (const k of [2, 3, 5]) {
            it(`${name}, ${k} chunks, matches a whole parse`, () => {
                const text = fs.readFileSync(file, "utf8");
                const whole = new BoardParser().parse(text);
                const { pod } = split_parse(text, k);
                expect(pod).toEqual(whole);
            });
        }
    }

    it("really splits a board that has enough items", () => {
        const file = files.find((f) => f.endsWith("video.kicad_pcb"))!;
        const { chunks } = split_parse(fs.readFileSync(file, "utf8"), 4);
        expect(chunks).toBe(4);
    });

    it("ignores parentheses inside strings when finding items", () => {
        const text = `(kicad_pcb (version 20240108) (generator "x (y")
  (net 0 "")
  (net 1 "/A)(B")
  (gr_text "a ) (b \\" c" (at 1 2) (layer "F.SilkS"))
  (segment (start 0 0) (end 1 1) (width 0.2) (layer "F.Cu") (net 1))
  (segment (start 1 1) (end 2 2) (width 0.2) (layer "F.Cu") (net 1))
)`;
        const whole = new BoardParser().parse(text);
        const { chunks, pod } = split_parse(text, 3);
        expect(chunks).toBe(3);
        expect(pod).toEqual(whole);
    });

    it("leaves a board with too few items whole", () => {
        const text = `(kicad_pcb (version 20240108) (net 0 "")
  (segment (start 0 0) (end 1 1) (width 0.2) (layer "F.Cu") (net 0)))`;
        expect(
            split_board_bytes(new TextEncoder().encode(text), 4),
        ).toHaveLength(1);
    });
});

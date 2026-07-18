import { expect } from "@esm-bundle/chai";
import {
    COMMENT_OVERLAY_CHANNELS,
    comment_id_from_primitive,
    comment_overlay_scene,
} from "../src/ecad-viewer/comment-overlay";

suite("comment-only overlay API", () => {
    test("owns marker styling and emits only comment primitives", () => {
        const scene = comment_overlay_scene({
            context: "SCH",
            comments: [
                {
                    id: "comment-1",
                    anchor: {
                        kind: "source-item",
                        uuid: "symbol-uuid",
                        page: "root.kicad_sch:/root",
                    },
                    areaBounds: [1, 2, 3, 4],
                    metadata: { threadId: "thread-1" },
                },
            ],
        });

        expect(scene.channelId).to.equal(COMMENT_OVERLAY_CHANNELS.SCH);
        expect(scene.placement).to.equal("foreground");
        expect(
            scene.primitives.map((primitive) => primitive.kind),
        ).to.deep.equal(["marker", "bbox"]);
        const marker = scene.primitives[0];
        expect(marker && "glyph" in marker ? marker.glyph : undefined).to.equal(
            "comment",
        );
        expect(comment_id_from_primitive("comment-1:area")).to.equal(
            "comment-1",
        );
    });
});

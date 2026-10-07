import { expect } from "@esm-bundle/chai";
import {
    COMMENT_OVERLAY_CHANNELS,
    comment_id_from_primitive,
    comment_overlay_scene,
    resolve_comment_overlays,
} from "../src/ecad-viewer/comment-overlay";
import { BBox, Vec2 } from "../src/base/math";

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

    test("reports a missing source UUID without removing its thread", () => {
        const statuses = resolve_comment_overlays(
            {
                context: "PCB",
                comments: [
                    {
                        id: "moved",
                        anchor: {
                            kind: "source-item",
                            uuid: "pad",
                            relativePoint: [0.25, 0.75],
                        },
                    },
                    {
                        id: "deleted",
                        anchor: { kind: "source-item", uuid: "gone" },
                    },
                ],
            },
            (anchor) =>
                anchor.kind === "source-item" && anchor.uuid === "pad"
                    ? {
                          point: new Vec2(12.5, 27.5),
                          bounds: new BBox(10, 20, 10, 10),
                      }
                    : null,
        );
        expect(statuses.map((status) => status.state)).to.deep.equal([
            "resolved",
            "missing",
        ]);
        expect(statuses[0]?.location?.x).to.equal(12.5);
    });
});

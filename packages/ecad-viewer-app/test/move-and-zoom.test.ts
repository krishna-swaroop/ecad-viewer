import { expect } from "@esm-bundle/chai";
import { MoveAndZoom } from "../src/base/dom/move-and-zoom";
import { Camera2, Vec2 } from "../src/base/math";

suite("MoveAndZoom activity contract", () => {
    test("ignores wheel input while inactive and resumes when active", () => {
        const canvas = document.createElement("canvas");
        const camera = new Camera2(new Vec2(100, 100), new Vec2(0, 0), 1);
        let active = false;
        let changes = 0;
        new MoveAndZoom(
            canvas,
            camera,
            () => {
                changes += 1;
            },
            0.5,
            10,
            undefined,
            () => active,
        );

        canvas.dispatchEvent(
            new WheelEvent("wheel", {
                deltaY: -10,
                clientX: 50,
                clientY: 50,
                cancelable: true,
            }),
        );
        expect(camera.zoom).to.equal(1);
        expect(changes).to.equal(0);

        active = true;
        canvas.dispatchEvent(
            new WheelEvent("wheel", {
                deltaY: -10,
                clientX: 50,
                clientY: 50,
                cancelable: true,
            }),
        );
        expect(camera.zoom).to.be.greaterThan(1);
        expect(changes).to.equal(1);
    });
});

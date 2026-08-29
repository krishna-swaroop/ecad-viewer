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

    test("modifier wheel leaves ordinary page scrolling untouched", () => {
        const canvas = document.createElement("canvas");
        const camera = new Camera2(new Vec2(100, 100), new Vec2(0, 0), 1);
        let changes = 0;
        const movement = new MoveAndZoom(
            canvas,
            camera,
            () => {
                changes += 1;
            },
            0.5,
            10,
            undefined,
            () => true,
            { wheel: "modifier", pinch: false, touchPan: false },
        );

        const ordinary = new WheelEvent("wheel", {
            deltaY: -10,
            cancelable: true,
        });
        canvas.dispatchEvent(ordinary);
        expect(ordinary.defaultPrevented).to.equal(false);
        expect(camera.zoom).to.equal(1);

        const modified = new WheelEvent("wheel", {
            deltaY: -10,
            ctrlKey: true,
            cancelable: true,
        });
        canvas.dispatchEvent(modified);
        expect(modified.defaultPrevented).to.equal(true);
        expect(camera.zoom).to.be.greaterThan(1);
        expect(changes).to.equal(1);
        movement.dispose();
    });

    test("disposal removes the wheel listener", () => {
        const canvas = document.createElement("canvas");
        const camera = new Camera2(new Vec2(100, 100), new Vec2(0, 0), 1);
        const movement = new MoveAndZoom(canvas, camera, () => {}, 0.5, 10);
        movement.dispose();

        const wheel = new WheelEvent("wheel", {
            deltaY: -10,
            cancelable: true,
        });
        canvas.dispatchEvent(wheel);
        expect(wheel.defaultPrevented).to.equal(false);
        expect(camera.zoom).to.equal(1);
    });
});

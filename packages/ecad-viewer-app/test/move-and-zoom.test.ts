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
            { wheel: "modifier", pinch: false, touchPan: false, drag: false },
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

    test("drag pans the camera and survives leaving the target", () => {
        const canvas = document.createElement("canvas");
        const camera = new Camera2(new Vec2(0, 0), new Vec2(0, 0), 2);
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
            { wheel: "disabled", pinch: false, touchPan: false, drag: true },
        );

        canvas.dispatchEvent(
            new MouseEvent("mousedown", { clientX: 100, clientY: 100 }),
        );
        // Dispatched on the window: a drag continues past the canvas edge.
        window.dispatchEvent(
            new MouseEvent("mousemove", {
                clientX: 80,
                clientY: 90,
                buttons: 1,
            }),
        );

        // Screen delta divided by zoom, so the world moves with the pointer.
        expect(camera.center.x).to.equal(10);
        expect(camera.center.y).to.equal(5);
        expect(changes).to.equal(1);

        window.dispatchEvent(new MouseEvent("mouseup"));
        window.dispatchEvent(
            new MouseEvent("mousemove", {
                clientX: 0,
                clientY: 0,
                buttons: 1,
            }),
        );
        expect(camera.center.x).to.equal(10);
        expect(camera.center.y).to.equal(5);
        expect(changes).to.equal(1);

        movement.dispose();
    });

    test("a vetoed button does not start a drag", () => {
        const canvas = document.createElement("canvas");
        const camera = new Camera2(new Vec2(0, 0), new Vec2(0, 0), 1);
        const movement = new MoveAndZoom(
            canvas,
            camera,
            () => {},
            0.5,
            10,
            undefined,
            () => true,
            { wheel: "disabled", pinch: false, touchPan: false, drag: true },
        );
        movement.drag_filter = (e) => e.button !== 0;

        canvas.dispatchEvent(
            new MouseEvent("mousedown", {
                button: 0,
                clientX: 100,
                clientY: 100,
            }),
        );
        window.dispatchEvent(
            new MouseEvent("mousemove", {
                clientX: 50,
                clientY: 50,
                buttons: 1,
            }),
        );
        expect(camera.center.x).to.equal(0);
        expect(camera.center.y).to.equal(0);

        canvas.dispatchEvent(
            new MouseEvent("mousedown", {
                button: 2,
                clientX: 100,
                clientY: 100,
            }),
        );
        window.dispatchEvent(
            new MouseEvent("mousemove", {
                clientX: 50,
                clientY: 50,
                buttons: 2,
            }),
        );
        expect(camera.center.x).to.equal(50);
        expect(camera.center.y).to.equal(50);

        movement.dispose();
    });

    test("drag is off unless the option asks for it", () => {
        const canvas = document.createElement("canvas");
        const camera = new Camera2(new Vec2(0, 0), new Vec2(0, 0), 1);
        const movement = new MoveAndZoom(
            canvas,
            camera,
            () => {},
            0.5,
            10,
            undefined,
            () => true,
            { wheel: "direct", pinch: false, touchPan: false, drag: false },
        );

        canvas.dispatchEvent(
            new MouseEvent("mousedown", { clientX: 100, clientY: 100 }),
        );
        window.dispatchEvent(
            new MouseEvent("mousemove", {
                clientX: 50,
                clientY: 50,
                buttons: 1,
            }),
        );
        expect(camera.center.x).to.equal(0);
        expect(camera.center.y).to.equal(0);

        movement.dispose();
    });

    test("disposal removes the drag listener", () => {
        const canvas = document.createElement("canvas");
        const camera = new Camera2(new Vec2(0, 0), new Vec2(0, 0), 1);
        const movement = new MoveAndZoom(
            canvas,
            camera,
            () => {},
            0.5,
            10,
            undefined,
            () => true,
            { wheel: "disabled", pinch: false, touchPan: false, drag: true },
        );
        movement.dispose();

        canvas.dispatchEvent(
            new MouseEvent("mousedown", { clientX: 100, clientY: 100 }),
        );
        window.dispatchEvent(
            new MouseEvent("mousemove", {
                clientX: 50,
                clientY: 50,
                buttons: 1,
            }),
        );
        expect(camera.center.x).to.equal(0);
        expect(camera.center.y).to.equal(0);
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

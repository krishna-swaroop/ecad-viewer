/*
    Inset camera: a 2D view onto another document's scene.

    An inset does not own a scene. It owns this camera and a canvas, and the
    viewer that already holds the document renders the scene through it. The
    camera is centre + zoom + rotation + mirror, applied about the centre of
    the inset's canvas.
*/

import { BBox, Matrix3, Vec2 } from "../../base/math";

export interface InsetCamera {
    /** World point shown at the centre of the inset canvas. */
    center: Vec2;
    /** Screen pixels (CSS) per world unit. */
    zoom: number;
    /** Radians, clockwise on screen. */
    rotation: number;
    /** Mirror about the vertical axis: a bottom-side view. */
    mirror: boolean;
}

/** World → inset canvas (CSS pixels) for a canvas of `w`×`h`. */
export function inset_matrix(camera: InsetCamera, w: number, h: number) {
    // Matrix3.rotation turns counter-clockwise on a y-down screen; the inset
    // camera's rotation is clockwise, like the toolbar's ↻.
    return Matrix3.translation(w / 2, h / 2)
        .rotate_self(-camera.rotation)
        .scale_self(camera.mirror ? -camera.zoom : camera.zoom, camera.zoom)
        .translate_self(-camera.center.x, -camera.center.y);
}

export function world_to_inset(
    camera: InsetCamera,
    w: number,
    h: number,
    point: Vec2,
): Vec2 {
    return inset_matrix(camera, w, h).transform(point);
}

export function inset_to_world(
    camera: InsetCamera,
    w: number,
    h: number,
    point: Vec2,
): Vec2 {
    return inset_matrix(camera, w, h).inverse().transform(point);
}

export interface FitOptions {
    /** Frame this many times the focus box, so neighbours show. */
    span?: number;
    /** Never frame less than this many world units across. */
    min_extent?: number;
}

/**
 * Centre on `focus` and zoom so its neighbourhood fills the canvas. Keeps
 * rotation and mirror as they are.
 */
export function fit_camera(
    camera: InsetCamera,
    focus: BBox,
    w: number,
    h: number,
    { span = 2, min_extent = 4 }: FitOptions = {},
): InsetCamera {
    const extent_x = Math.max(focus.w * span, min_extent);
    const extent_y = Math.max(focus.h * span, min_extent);
    camera.center = new Vec2(focus.x + focus.w / 2, focus.y + focus.h / 2);
    camera.zoom = Math.min(
        Math.max(1, w) / extent_x,
        Math.max(1, h) / extent_y,
    );
    return camera;
}

/** Zoom by `factor` keeping the world point under `cursor` fixed. */
export function zoom_about(
    camera: InsetCamera,
    w: number,
    h: number,
    cursor: Vec2,
    factor: number,
): InsetCamera {
    const before = inset_to_world(camera, w, h, cursor);
    camera.zoom *= factor;
    const after = inset_to_world(camera, w, h, cursor);
    camera.center = new Vec2(
        camera.center.x + (before.x - after.x),
        camera.center.y + (before.y - after.y),
    );
    return camera;
}

/** Drag the scene by a screen delta: the content follows the pointer. */
export function pan_by(
    camera: InsetCamera,
    dx: number,
    dy: number,
): InsetCamera {
    // Only the linear part matters for a delta, so any canvas size works.
    const inverse = inset_matrix(camera, 0, 0).inverse();
    const a = inverse.transform(new Vec2(0, 0));
    const b = inverse.transform(new Vec2(dx, dy));
    camera.center = new Vec2(
        camera.center.x - (b.x - a.x),
        camera.center.y - (b.y - a.y),
    );
    return camera;
}

/*
    Copyright (c) 2023 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

/**
 * Painters for drawing board items.
 *
 * Each item class has a corresponding Painter implementation.
 */

import { Angle, Matrix3, Vec2 } from "../../base/math";
import { Polygon, Polyline } from "../../graphics";
import * as board_items from "../../kicad/board";
import { ViewLayerNames } from "../base/view-layers";
import { ViewLayer } from "./layers";
import { BoardItemPainter } from "./painter-base";

export class FootprintPainter extends BoardItemPainter {
    classes = [board_items.Footprint];

    layers_for(fp: board_items.Footprint): string[] {
        const layers = new Set();
        for (const item of fp.items()) {
            const item_layers = this.view_painter.layers_for(item);
            for (const layer of item_layers) {
                layers.add(layer);
            }
        }
        return Array.from(layers.values()) as string[];
    }

    paint(layer: ViewLayer, fp: board_items.Footprint) {
        if (layer.name === ViewLayerNames.selection_mask) {
            // Exact footprint bounds — do not grow; hatch must not spill outside.
            const bbox = fp.bbox;
            this.gfx.polygon(Polygon.from_BBox(bbox, layer.color));
            const step = Math.max(0.4, Math.min(bbox.w, bbox.h) / 12);
            // 45° diagonals clipped to the bbox (offset = x-relative − y-relative).
            for (let offset = -bbox.h; offset <= bbox.w; offset += step) {
                const t0 = Math.max(0, offset);
                const t1 = Math.min(bbox.w, offset + bbox.h);
                if (t1 <= t0) continue;
                this.gfx.line(
                    new Polyline(
                        [
                            new Vec2(bbox.x + t0, bbox.y + t0 - offset),
                            new Vec2(bbox.x + t1, bbox.y + t1 - offset),
                        ],
                        0.1,
                        layer.color,
                    ),
                );
            }
            return;
        }

        const matrix = Matrix3.translation(
            fp.at.position.x,
            fp.at.position.y,
        ).rotate_self(Angle.deg_to_rad(fp.at.rotation));

        this.gfx.state.push();
        this.gfx.state.multiply(matrix);

        const its = fp.items();

        for (const item of its) {
            const item_layers = this.view_painter.layers_for(item);
            if (
                BoardItemPainter.is_interactive_layer(layer.name) ||
                item_layers.includes(layer.name)
            ) {
                this.view_painter.paint_item(layer, item);
            }
        }

        this.gfx.state.pop();
    }
}

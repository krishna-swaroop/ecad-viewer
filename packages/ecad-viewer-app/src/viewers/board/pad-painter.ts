import { Angle, Matrix3, Vec2 } from "../../base/math";
import * as log from "../../base/log";
import { Circle, Polygon, Polyline } from "../../graphics";
import * as board_items from "../../kicad/board";
import {
    CopperVirtualLayerNames,
    LayerNames,
    ViewLayer,
    virtual_layer_for,
} from "./layers";
import { BoardItemPainter } from "./painter-base";

/**
 * The copper layer whose colour a pad takes when repainted for emphasis:
 * through-hole pads use the through-hole pad colour, SMD pads their side.
 */
function pad_copper_layer(pad: board_items.Pad): string {
    if (pad.type === "thru_hole" || pad.type === "np_thru_hole")
        return LayerNames.pad_holewalls;
    if (pad.layers.includes(LayerNames.b_cu)) return LayerNames.b_cu;
    return LayerNames.f_cu;
}

/**
 * How far a pad's opening on a paste or mask layer extends past its copper,
 * per axis, or null on any other layer.
 *
 * Mirrors KiCad's PAD::GetSolderPasteMargin and ::GetSolderMaskExpansion: a
 * value set on the pad wins, then one set on its footprint, then the board's
 * setup. Paste adds a ratio of the pad size. Neither can shrink the opening
 * below nothing, and a pad with no copper keeps its own shape.
 */
export function pad_layer_margin(
    pad: board_items.Pad,
    layer: string,
): Vec2 | null {
    const paste = layer == LayerNames.f_paste || layer == LayerNames.b_paste;
    const mask = layer == LayerNames.f_mask || layer == LayerNames.b_mask;
    if (!paste && !mask) {
        return null;
    }

    if (!pad.layers.some((l) => l.endsWith(".Cu"))) {
        return new Vec2(0, 0);
    }

    const footprint = pad.parent;
    const setup = footprint?.parent?.setup;

    if (mask) {
        let margin =
            pad.solder_mask_margin ??
            footprint?.solder_mask_margin ??
            setup?.pad_to_mask_clearance ??
            0;
        margin = Math.max(margin, -Math.min(pad.size.x, pad.size.y) / 2);
        return new Vec2(margin, margin);
    }

    const margin =
        pad.solder_paste_margin ??
        footprint?.solder_paste_margin ??
        setup?.pad_to_paste_clearance ??
        0;
    const ratio =
        pad.solder_paste_margin_ratio ??
        footprint?.solder_paste_ratio ??
        setup?.pad_to_paste_clearance_ratio ??
        0;

    return new Vec2(
        Math.max(margin + pad.size.x * ratio, -pad.size.x / 2),
        Math.max(margin + pad.size.y * ratio, -pad.size.y / 2),
    );
}

export class PadPainter extends BoardItemPainter {
    classes = [board_items.Pad];

    layers_for(pad: board_items.Pad): string[] {
        // TODO: Port KiCAD's logic over.
        const layers: string[] = [];

        for (const layer of pad.layers) {
            if (layer == "*.Mask") {
                layers.push(LayerNames.f_mask);
                layers.push(LayerNames.b_mask);
            } else if (layer == "*.Paste") {
                layers.push(LayerNames.f_paste);
                layers.push(LayerNames.b_paste);
            } else if (
                layer == LayerNames.f_mask ||
                layer == LayerNames.b_mask
            ) {
                layers.push(layer);
            } else if (
                layer == LayerNames.f_paste ||
                layer == LayerNames.b_paste
            ) {
                layers.push(layer);
            } else if (
                layer == LayerNames.f_silks ||
                layer == LayerNames.b_silks ||
                layer == LayerNames.f_fab ||
                layer == LayerNames.b_fab ||
                layer == LayerNames.edge_cuts ||
                layer == LayerNames.dwgs_user ||
                layer == LayerNames.cmts_user ||
                layer == LayerNames.f_crtyd ||
                layer == LayerNames.b_crtyd ||
                layer == LayerNames.f_adhes ||
                layer == LayerNames.b_adhes
            ) {
                layers.push(layer);
            } else {
                layers.push(
                    virtual_layer_for(layer, CopperVirtualLayerNames.pads),
                );
            }
        }

        switch (pad.type) {
            case "thru_hole":
                layers.push(LayerNames.pad_holewalls);
                layers.push(LayerNames.pad_holes);
                break;
            case "np_thru_hole":
                layers.push(LayerNames.non_plated_holes);
                break;
            case "smd":
            case "connect":
                break;
            default:
                log.warn(`Unhandled pad type "${pad.type}"`);
                break;
        }

        return layers;
    }

    paint(layer: ViewLayer, pad: board_items.Pad) {
        const margin = pad_layer_margin(pad, layer.name) ?? new Vec2(0, 0);

        // A margin that eats the whole pad leaves no opening, which KiCad
        // does not draw (an imported "no paste" pad, say).
        if (pad.size.x + 2 * margin.x <= 0 || pad.size.y + 2 * margin.y <= 0) {
            return;
        }

        const color = this.emphasis_color(layer, pad_copper_layer(pad));

        const position_mat = Matrix3.translation(
            pad.at.position.x,
            pad.at.position.y,
        );
        position_mat.rotate_self(-Angle.deg_to_rad(pad.parent.at.rotation));
        position_mat.rotate_self(Angle.deg_to_rad(pad.at.rotation));

        this.gfx.state.push();
        this.gfx.state.multiply(position_mat);

        const center = new Vec2(0, 0);

        const is_hole_layer =
            layer.name == LayerNames.pad_holes ||
            layer.name == LayerNames.non_plated_holes;

        if (is_hole_layer && pad.drill != null) {
            if (!pad.drill.oval) {
                const drill_pos = center.add(pad.drill.offset);
                this.gfx.circle(
                    new Circle(drill_pos, pad.drill.diameter / 2, color),
                );
            } else {
                const half_size = new Vec2(
                    pad.drill.diameter / 2,
                    (pad.drill.width ?? 0) / 2,
                );

                const half_width = Math.min(half_size.x, half_size.y);

                const half_len = new Vec2(
                    half_size.x - half_width,
                    half_size.y - half_width,
                );

                const drill_pos = center.add(pad.drill.offset);
                const drill_start = drill_pos.sub(half_len);
                const drill_end = drill_pos.add(half_len);

                this.gfx.line(
                    new Polyline(
                        [drill_start, drill_end],
                        half_width * 2,
                        color,
                    ),
                );
            }
        } else {
            let shape = pad.shape;
            if (shape == "custom" && pad.options?.anchor) {
                shape = pad.options.anchor;
            }

            if (pad.drill?.offset) {
                this.gfx.state.matrix.translate_self(
                    pad.drill.offset.x,
                    pad.drill.offset.y,
                );
            }

            const size = pad.size.add(margin.multiply(2));

            switch (shape) {
                case "circle":
                    this.gfx.circle(new Circle(center, size.x / 2, color));
                    break;
                case "rect":
                case "roundrect":
                case "trapezoid":
                    // KiCAD approximates rounded rectangle using four line segments
                    // with their width set to the round radius. Clever bastards.
                    // Since our polylines aren't filled, we'll add both a polygon
                    // and a polyline.
                    {
                        // A uniform margin grows the outline, so its
                        // corners round off by the margin. KiCad sizes a
                        // per-axis one as a pad of the new size instead.
                        const radius =
                            shape == "roundrect"
                                ? Math.min(pad.size.x, pad.size.y) *
                                  (pad.roundrect_rratio ?? 0)
                                : 0;
                        const rounding = Math.max(
                            margin.x == margin.y
                                ? radius + margin.x
                                : shape == "roundrect"
                                  ? radius + Math.max(margin.x, margin.y)
                                  : 0,
                            0,
                        );
                        let half_size = new Vec2(size.x / 2, size.y / 2);
                        half_size = half_size.sub(new Vec2(rounding, rounding));

                        let trap_delta = pad.rect_delta
                            ? pad.rect_delta.copy()
                            : new Vec2(0, 0);
                        trap_delta = trap_delta.multiply(0.5);

                        const rect_points = [
                            new Vec2(
                                -half_size.x - trap_delta.y,
                                half_size.y + trap_delta.x,
                            ),
                            new Vec2(
                                half_size.x + trap_delta.y,
                                half_size.y - trap_delta.x,
                            ),
                            new Vec2(
                                half_size.x - trap_delta.y,
                                -half_size.y + trap_delta.x,
                            ),
                            new Vec2(
                                -half_size.x + trap_delta.y,
                                -half_size.y - trap_delta.x,
                            ),
                        ];

                        // this.gfx.push_transform(offset_mat);
                        this.gfx.polygon(new Polygon(rect_points, color));
                        if (rounding > 0) {
                            this.gfx.line(
                                new Polyline(
                                    [...rect_points, rect_points[0]!],
                                    rounding * 2,
                                    color,
                                ),
                            );
                        }
                        // this.gfx.pop_transform();
                    }
                    break;

                case "oval":
                    {
                        const half_size = new Vec2(size.x / 2, size.y / 2);
                        const half_width = Math.min(half_size.x, half_size.y);
                        const half_len = new Vec2(
                            half_size.x - half_width,
                            half_size.y - half_width,
                        );

                        const pad_pos = center.add(
                            pad.drill?.offset || new Vec2(0, 0),
                        );
                        const pad_start = pad_pos.sub(half_len);
                        const pad_end = pad_pos.add(half_len);

                        if (pad_start.equals(pad_end)) {
                            this.gfx.circle(
                                new Circle(pad_pos, half_width, color),
                            );
                        } else {
                            this.gfx.line(
                                new Polyline(
                                    [pad_start, pad_end],
                                    half_width * 2,
                                    color,
                                ),
                            );
                        }
                    }
                    break;

                default:
                    log.warn(`Unknown pad shape "${pad.shape}"`);
                    break;
            }

            if (pad.shape == "custom" && pad.primitives) {
                for (const prim of pad.primitives) {
                    this.view_painter.paint_item(layer, prim);
                }
            }
        }

        this.gfx.state.pop();
    }
}

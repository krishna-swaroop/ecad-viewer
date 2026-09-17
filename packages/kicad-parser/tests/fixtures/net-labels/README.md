# Net-label fixture

`net_labels.kicad_pcb` is a hand-written KiCad 10.0.6 board (`version 20260206`,
validated with `kicad-cli 10.0.6 pcb export pos`) for the pad-number / net-name
label renderer in `ecad-viewer-app` (`viewers/board/net-label-*.ts`). UUIDs are
uuid5 of stable labels so the file is byte-reproducible.

It covers every branch the renderer takes:

| Item | Exercises |
| --- | --- |
| `U1` pad `1` — through-hole circle, `GND` | multi-layer pad → `:Pad:NetNames`, circle text shrink |
| `U1` pad `2` — SMD 1×2 mm, `/sig/DATA` | tall pad → text rotated 90°, hierarchical short name `DATA` |
| `U1` pad `3` — SMD 2×1 mm roundrect, `VCC` | wide pad, single-copper → `:F.Cu:NetNames` |
| `U1` pad `4` — `pintype no_connect` | net text `x` |
| `U1` pad `5` — SMD circle, `VCC` | circle text shrink on an SMD pad |
| `U1` pad `""` — no number, no net | skipped |
| `J1` pad `1` — SMD on `B.Cu`, `GND` | back-copper label layer |
| segment (13,10)→(30,10) w 0.5 `DATA` | horizontal, long enough |
| segment (10,12)→(10.5,12) w 0.5 | shorter than `chars × width` → no label |
| segment (12,14)→(20,22) w 0.5 `VCC` | diagonal, angle folded upright |
| segment (35,5)→(35,25) w 0.4 `GND` on `B.Cu` | vertical (90°) |
| arc (20,30)-(25,35)-(30,30) w 0.5 `GND` on `B.Cu` | arc label at the midpoint along the tangent |
| via (25,10) ⌀0.8 through `DATA` | via net name only |
| via (28,14) ⌀0.6 blind F.Cu→In1.Cu `VCC` | layer-pair line `1-2` above the net name |
| zone `GNDPOUR` on `F.Cu`, filled ring (2,20)–(18,36) fractured around a (8,26)–(12,30) cut-out | zone label at the pole of inaccessibility (the centroid (10,28) lies in the cut-out) |
| the same zone's 0.3 mm `(island)` filled polygon at (30,30) | below `ZONE_LABEL_MIN_INSCRIBED_MM` → no label |

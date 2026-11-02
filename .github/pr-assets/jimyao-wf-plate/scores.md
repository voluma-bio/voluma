# `plate_faces.py` scored against Jimmy's hand traces

Midline of the hand traces (mean of his upper and lower polylines, over the U range both cover) against the script's
centre, per section, in µm (median / p90). "Flagged" columns are scored separately. Curve columns are the proposed
curves as `iioc.py` would read them (linear in V between proposed sections, only where a point lies within 5 U), unflagged only.

| scan | V | centre, unflagged | centre, flagged | centre, all | curves midline, unflagged | upper face vs his upper | lower face vs his lower | report's 3D centre (all) |
|---|---|---|---|---|---|---|---|---|
| OA7-1L | 81 | 15 / 48 (n=170) | 44 / 115 (26) | 17 / 57 (196) | 13 / 68 (158 of 199) | 22 / 133 | 15 / 131 | 21 / 89 |
| OA7-1L | 136 | 46 / 290 (143) | 101 / 338 (84) | 59 / 338 (227) | 61 / 321 (147 of 227) | 71 / 392 | 46 / 241 | 44 / 297 |
| OA7-1L | 224 | 68 / 165 (95) | 160 / 341 (117) | 119 / 329 (212) | 77 / 178 (111 of 212) | 68 / 233 | 59 / 158 | 51 / 159 |
| OA6-1RK | 102 | 43 / 131 (129) | 63 / 219 (153) | 55 / 176 (282) | 46 / 141 (158 of 290) | 46 / 121 | 59 / 150 | 53 / 136 |
| OA6-1RK | 231 (eroded) | 140 / 255 (11) | 116 / 317 (186) | 116 / 311 (197) | 198 / 200 (12 of 197) | 255 / 265 | 131 / 149 | 81 / 545 (separate part) |
| OA6-2RK | 154 | 25 / 58 (262) | 164 / 180 (6) | 25 / 61 (268) | 17 / 36 (256 of 268) | 17 / 52 | 24 / 64 | 49 / 247 |
| OA6-2RK | 225 | 16 / 62 (241) | 94 / 140 (17) | 17 / 71 (258) | 19 / 55 (245 of 258) | 22 / 73 | 25 / 104 | 17 / 136 |

Share of the tibia's (V, U) columns flagged: OA7-1L 43%, OA6-1RK 56%, OA6-2RK 25%.
On OA6-1RK V=231 at U >= 296 (where the lab says the plate is gone) 93% of the columns are flagged (calibration set, 43 columns).
Run time 5.5 to 7.7 s per scan, 1.4 to 2.0 GB.

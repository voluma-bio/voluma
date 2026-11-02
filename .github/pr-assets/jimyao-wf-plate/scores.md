# `plate_faces.py` scored against Jimmy's hand traces

Midline of the hand traces (mean of his upper and lower polylines, over the U range both cover) against the script's centre, per
section, in µm (median / p90). "Flagged" columns are scored separately. "Curves" are the proposed curves as `iioc.py` would read
them (linear in V between proposed sections, only where a point lies within 5 U), unflagged columns only; upper and lower compare
each proposed face with his upper and lower line there. Last column: share of the unflagged face columns more than 105 µm (10 voxels)
from his line, upper / lower.

| scan | V | centre, unflagged | centre, flagged | centre, all | curves midline | upper face | lower face | faces > 105 µm |
|---|---|---|---|---|---|---|---|---|
| OA7-1L | 81 | 16 / 47 (n=183) | 80 / 115 (13) | 18 / 58 | 11 / 32 (187 of 199) | 18 / 44 | 16 / 43 | 1% / 2% |
| OA7-1L | 136 | 44 / 259 (147) | 182 / 349 (80) | 60 / 338 | 58 / 337 (163 of 227) | 59 / 360 | 55 / 308 | 20% / 22% |
| OA7-1L | 224 | 66 / 156 (115) | 180 / 360 (97) | 119 / 325 | 78 / 156 (150 of 212) | 69 / 149 | 80 / 159 | 22% / 38% |
| OA6-1RK | 102 | 41 / 115 (152) | 86 / 271 (130) | 54 / 173 | 47 / 130 (195 of 290) | 44 / 133 | 57 / 120 | 14% / 16% |
| OA6-1RK | 231 (eroded) | 265 (1 column) | 117 / 313 (196) | 118 / 313 | 102 / 306 (46 of 197) | 83 / 336 | 121 / 277 | n/a |
| OA6-2RK | 154 | 23 / 58 (255) | 48 / 165 (13) | 24 / 62 | 17 / 38 (263 of 268) | 18 / 48 | 23 / 64 | 0% / 2% |
| OA6-2RK | 225 | 15 / 61 (240) | 90 / 139 (18) | 17 / 69 | 17 / 64 (252 of 258) | 19 / 61 | 20 / 74 | 0% / 4% |

Share of the tibia's (V, U) columns flagged: OA7-1L 35%, OA6-1RK 49%, OA6-2RK 20% (before this change, with padding by dilation and
no face test: 43%, 56%, 25%).
On OA6-1RK V=231 at U >= 296 (where the lab says the plate is gone) 98% of the columns are flagged (43 columns); the whole section 77%.
Run time 6.2 to 8.8 s per scan, 1.4 to 2.0 GB.

Padding (closing + dilation by 2 voxels, against closing alone, same tests): flagged 47 / 58 / 28% against 35 / 49 / 20%; the
unflagged faces more than 105 µm off in 12.7 / 18.9 / 1.1% against 15.3 / 15.5 / 1.5% (OA7-1L / OA6-1RK / OA6-2RK). The dilation costs
a third more flagged area for a change inside the noise of 7 traced sections, so it is gone.

The flags do not catch a convincing sheet on the wrong structure: on OA7-1L V=136 and V=224 and OA6-1RK V=102, 14 to 38% of the
unflagged face columns are still over 105 µm from his lines. Looking at every proposed section is the check for those.

# Proposal vs Jimmy's lines (same band or a different structure)

His lines are rough in height as well as thickness, so this is not an accuracy score: it counts the proposed columns whose midline lies within 150 µm of his midline (same band) and beyond it (a different structure, or his line is off), and says where the beyond ones sit. #455 = the rule before this change (two searches averaged, flagged columns dropped); now = the columns that carry curve points. Nothing was tuned to these lines; `min_run_um` went back from 210 to 315.

| scan | V | traced U cols | #455: proposed / same band / beyond | now: proposed / same band / beyond | beyond-150 runs (U), now |
|---|---:|---:|---|---|---|
| oa6-2rk | 220 | 260 | 23 / 23 / 0 | 147 / 128 / 19 | [[130, 133], [145, 159]] |
| oa6-2rk | 225 | 268 | 28 / 28 / 0 | 157 / 154 / 3 | [[101, 103]] |
| oa7-1l | 81 | 199 | 161 / 159 / 2 | 136 / 133 / 3 | [[77, 79]] |
| oa7-1l | 136 | 227 | 65 / 65 / 0 | 158 / 133 / 25 | [[38, 62]] |
| oa7-1l | 185 | 212 | 21 / 0 / 21 | 32 / 0 / 32 | [[203, 234]] |
| oa7-1l | 220 | 224 | 67 / 62 / 5 | 119 / 119 / 0 | [] |
| oa7-1l | 224 | 212 | 67 / 60 / 7 | 186 / 160 / 26 | [[57, 75], [236, 242]] |
| oa7-1l | 225 | 217 | 70 / 70 / 0 | 186 / 166 / 20 | [[58, 74], [241, 243]] |
| oa6-1rk | 102 | 290 | 88 / 84 / 4 | 200 / 188 / 12 | [[337, 348]] |
| oa6-1rk | 231 | 197 | 0 / 0 / 0 | 7 / 0 / 7 | [[332, 338]] |

Renders: `*-hand-vs-proposal.jpg` (his lines lime; proposal orange proximal, cyan distal, only on columns that carry points); `oa6-2rk-v185-v220-v225.jpg` and `oa6-2rk-back-sections.jpg` (white = the search's centre everywhere, red ticks = flagged); `standin-*-qc-faces-3.jpg`: the delivered-face sheets, from a stand-in annotation set (the proposal's own gap-free sections), not a worker's trace.

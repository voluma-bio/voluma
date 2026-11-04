# segmentation-check: to do

- `label_stats.py`'s swap check copies mouse-oa `tibia_frame.py`'s `largest_piece`, `cap_solidity`, `CAP_MM` and `CAP_GAP` (#585). Move them into one module in `workflows/core` that both import, so the two checks can't drift (c1621 owns it).

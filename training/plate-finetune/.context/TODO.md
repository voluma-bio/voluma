# TODO

- Publish the checkpoints (`upload_weights.py`) once the Hugging Face account (personal `haowjy` or a voluma-bio org) is
  chosen, then replace the "not published yet" line in README.md with the repo URL.
- The README's R2 curl example reads `dev/plate-serve/OA8-19L/`; the test grid was uploaded to `dev/plate-serve-test/OA8-19L/`
  before the key check narrowed. Copy it across (needs R2 credentials). Give the `plate-serve-r2` secret a read-only R2 token
  scoped to the bucket.

## Follow-ups from the #547 reviews

- **One recipe table.** A recipe's facts (prompt, threshold, post-processing, vote mode, checkpoints) are spread over
  `export.TEXT`/`band.TEXT`, `predict.THRESHOLD`, the `if recipe == "band"` branch and prompt dict in `serve.py`, `vote.py`'s
  default and README prose. Make one `RECIPES = {"region": Recipe(...), "band": Recipe(...)}`, record the recipe name in the
  checkpoint (`train.py` reads `split.json`, `model.save` stores it), and have one `predict_scan(model, state, hu, tibia, vs)`
  that `predict.py` and `serve.py` both call. That deletes `--text`/`--threshold` on `predict.py`, `--text` on `export.py`
  and `band.py`, and the README's "the region recipe is the same with ..." paragraph.
- **Serving checkpoints point at experiment directories.** `serve.CHECKPOINTS` reads `/runs/l29-a-s*` and `/runs/l32-band-s*`,
  but `modal_train.py` writes `/runs/<data>-s<seed>`, so retraining changes nothing served. Name the volume directories by
  checkpoint name (`/runs/band-s0/`), so `CHECKPOINTS` is a list of names and the recipe comes from the checkpoint.
- **Small duplications.** `predict.labelled_sections` and `score.labels_of` both search the export splits (`labels_of`
  returns None and crashes later): one helper that raises. `band_to_region.at`/`extend` copy `cutline.region_of`'s `at`
  lambda and `_exit_ends`, including the "direction from the point at least 4 voxels back" rule.
- **Ruff pinned twice:** `0.17.3` in both `project.json` and `workflows/test.sh`.
- **A unit test worth keeping:** a synthetic `band_regions` + `vote` check (empty band, two pieces with a gap, a stray run in
  the gap, every model abstaining). It needs no lab data and covers the band-to-region step, where a bug is silent.

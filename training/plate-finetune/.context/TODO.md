# TODO

- Add L33's band post-processing (lower confidence on empty sections or keep the top instance; drop pieces far from the
  main chain before chaining; refuse a full-width line through bone outside the plate's extent) once its write-up
  (`RESULTS-L33.md`) settles which of them to keep. It goes between `predict.py` and `band_to_region.py`; re-score with
  `score.py` and update the README table.
- Publish the checkpoints (`upload_weights.py`) once the Hugging Face account (personal `haowjy` or a voluma-bio org) is
  chosen, then replace the "not published yet" line in README.md with the repo URL.

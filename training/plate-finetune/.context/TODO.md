# TODO

- Publish the checkpoints (`upload_weights.py`) once the Hugging Face account (personal `haowjy` or a voluma-bio org) is
  chosen, then replace the "not published yet" line in README.md with the repo URL.
- Wire `serve.py` into runs: Voluma runs don't call the endpoint yet. A run would write its tibia grid to R2 under a key the
  endpoint can read, call it with a proxy token kept as a runner secret, and turn `vote.cut` (or the band lines in `meta`) into
  the cut line the workflow uses. Deploy it as `plate-serve` (not the `-dev` test app) first.

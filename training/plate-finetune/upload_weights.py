"""Publish fine-tuned checkpoints to a Hugging Face model repo, with the model card and the SAM License.

  uv run --group release python upload_weights.py --repo <owner>/voluma-plate-sam31 \
      band-s0=runs/band-s0/ckpt-bestval.pt band-s1=... region-s0=...

Uploads only what this repo trained: each checkpoint (the trainable tensors and LoRA rank, model.py; no SAM 3.1 base weights) as
<name>.pt, MODEL_CARD.md as README.md and LICENSE-SAM.txt as LICENSE. Needs a token with write access (`hf auth login`).
"""
import argparse
from pathlib import Path

import torch
from huggingface_hub import HfApi

HERE = Path(__file__).parent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--private", action="store_true")
    ap.add_argument("ckpts", nargs="+", help="NAME=path to a train.py checkpoint")
    a = ap.parse_args()
    ckpts = dict(c.split("=", 1) for c in a.ckpts)
    for name, path in ckpts.items():
        state = torch.load(path, map_location="cpu", weights_only=True)
        assert set(state) == {"lora_rank", "trainable"}, f"{path} is not a train.py checkpoint"
        assert not any(k.startswith(("backbone.vision_backbone.trunk.", "backbone.language_backbone.")) and "lora_" not in k
                       for k in state["trainable"]), f"{path} holds frozen SAM 3.1 tensors"
    api = HfApi()
    api.create_repo(a.repo, repo_type="model", private=a.private, exist_ok=True)
    api.upload_file(path_or_fileobj=str(HERE / "MODEL_CARD.md"), path_in_repo="README.md", repo_id=a.repo)
    api.upload_file(path_or_fileobj=str(HERE / "LICENSE-SAM.txt"), path_in_repo="LICENSE", repo_id=a.repo)
    for name, path in ckpts.items():
        api.upload_file(path_or_fileobj=path, path_in_repo=f"{name}.pt", repo_id=a.repo)
        print("uploaded", name)


if __name__ == "__main__":
    main()

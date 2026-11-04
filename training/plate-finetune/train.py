"""Fine-tune Sam3Image on one GPU on an exported training set (export.py or band.py); the prompt is the set's COCO category name.

  python train.py --data data/band --out runs/band-s0 --seed 0

Reuses Meta's dataset, collator, matcher and losses (with the mask loss) in a plain loop: no Hydra launcher, no process group
beyond the one-process group the loss code asks for. Writes <out>/log.jsonl (loss per step, s/step, VRAM peak, val loss every
--val-every steps on <data>/val), <out>/ckpt-bestval.pt at the lowest val loss (the checkpoint the recipes use) and
<out>/ckpt.pt at the end. Checkpoints hold the trainable tensors only (model.py).
"""
import argparse
import json
import os
import time
from functools import partial
from pathlib import Path

import torch
import torch.distributed as dist
from hydra.utils import instantiate
from omegaconf import OmegaConf
from sam3.model.utils.misc import copy_data_to_device
from sam3.train.data.collator import collate_fn_api
from sam3.train.data.sam3_image_dataset import Sam3ImageDataset
from sam3.train.data.torch_dataset import TorchDataset

import losses  # noqa: F401  patches Meta's focal loss; train_config.yaml names its classes
import model as M

HERE = Path(__file__).parent


def loader(cfg, split_dir, training, workers):
    ds = Sam3ImageDataset(img_folder=str(split_dir / "img"), ann_file=str(split_dir / "_annotations.coco.json"),
                          transforms=instantiate(cfg.transforms if training else cfg.val_transforms), load_segmentation=True,
                          training=training, max_ann_per_img=500000, multiplier=1, max_train_queries=50000,
                          max_val_queries=50000, use_caching=False)
    return TorchDataset(dataset=ds, batch_size=1, num_workers=workers, shuffle=training, pin_memory=True,
                        drop_last=training, collate_fn=partial(collate_fn_api, dict_key="all", with_seg_masks=True))


def step_loss(model, loss_fn, batch):
    (_, batch), = batch.items()
    batch = copy_data_to_device(batch, torch.device("cuda"), non_blocking=True)
    stages = model(batch)
    targets = [model.back_convert(x) for x in batch.find_targets]
    parts = loss_fn(stages, targets)
    return parts["core_loss"], parts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--lora-rank", type=int, default=16, help="LoRA rank on the ViT attention; 0 trains the heads only")
    ap.add_argument("--steps", type=int, default=3000)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--warmup", type=int, default=5)
    ap.add_argument("--val-every", type=int, default=100, help="val loss on <data>/val every N steps")
    ap.add_argument("--seed", type=int, default=0, help="LoRA init and section order")
    ap.add_argument("--workers", type=int, default=4)
    a = ap.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    os.environ.update(MASTER_ADDR="127.0.0.1", MASTER_PORT=str(29500 + os.getpid() % 1000), RANK="0", WORLD_SIZE="1")
    dist.init_process_group("gloo")  # the loss code calls all_reduce; one rank, so it is a no-op
    torch.manual_seed(a.seed)
    cfg = OmegaConf.load(HERE / "train_config.yaml")
    model = M.build(lora_rank=a.lora_rank)
    M.set_trainable(model)
    params = [p for p in model.parameters() if p.requires_grad]
    print(f"trainable {sum(p.numel() for p in params) / 1e6:.1f}M of {sum(p.numel() for p in model.parameters()) / 1e6:.1f}M",
          flush=True)
    opt = torch.optim.AdamW(params, lr=a.lr, weight_decay=0.1)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1, (s + 1) / a.warmup))
    loss_fn = instantiate(cfg.loss).cuda()
    train = loader(cfg, a.data / "train", True, a.workers)
    train.sampler.seed = a.seed
    val = loader(cfg, a.data / "val", False, 0)
    model.train()
    torch.cuda.reset_peak_memory_stats()
    log = (a.out / "log.jsonl").open("w")
    step, epoch, t0 = 0, 0, time.time()
    t_prev = t0
    best_val = float("inf")
    while step < a.steps:
        epoch += 1
        for batch in train.get_loader(epoch):
            with torch.autocast("cuda", dtype=torch.bfloat16):
                loss, parts = step_loss(model, loss_fn, batch)
            opt.zero_grad(set_to_none=True)
            loss.backward()
            gnorm = torch.nn.utils.clip_grad_norm_(params, 0.1)
            assert torch.isfinite(gnorm), f"non-finite gradient at step {step}"
            opt.step()
            sched.step()
            step += 1
            now = time.time()
            rec = {"step": step, "gnorm": round(gnorm.item(), 3), "step_s": round(now - t_prev, 3), "loss": loss.item(),
                   "s_step": (now - t0) / step, "vram_gb": torch.cuda.max_memory_allocated() / 2**30,
                   **{k: round(v.item(), 4) for k, v in parts.items() if k != "core_loss" and "aux" not in k and v.ndim == 0}}
            if step % a.val_every == 0:
                # train mode: the loss needs the training-time matching outputs; the model has no dropout
                with torch.no_grad(), torch.autocast("cuda", dtype=torch.bfloat16):
                    vl = [step_loss(model, loss_fn, b)[0].item() for b in val.get_loader(0)]
                rec["val_loss"] = sum(vl) / len(vl)
                if rec["val_loss"] < best_val:
                    best_val = rec["val_loss"]
                    M.save(model, a.out / "ckpt-bestval.pt", a.lora_rank)
                    rec["best_val_step"] = step
            t_prev = time.time()
            print(json.dumps(rec), flush=True)
            log.write(json.dumps(rec) + "\n")
            log.flush()
            if step >= a.steps:
                break
    M.save(model, a.out / "ckpt.pt", a.lora_rank)
    print("saved", a.out / "ckpt.pt", flush=True)


if __name__ == "__main__":
    main()

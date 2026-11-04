"""Train seeds on Modal, one GPU container each, then predict the test and validation scans with each best-val checkpoint.

  MODAL_GPU=A10,L40S uv run --group release modal run --detach modal_train.py --data band --seeds 0,1,2

Volume `plate-finetune` (upload once with `modal volume put`): /scans/<scan>/ (the prepared scans, as PLATE_SCANS),
/weights/sam3.1_multiplex.pt, /data/<name>/ (exports; a band set needs its region set beside it, its img/ and labels/ are
relative links). Run <data>-s<seed> writes /runs/<that>/: ckpt-bestval.pt, ckpt.pt, log.jsonl, run.log and pred/<scan>.npz
(predict.py, the labelled sections of every heldout and val scan). The prompt is the export's (split.json "text").
Fetch predictions with `modal volume get plate-finetune /runs/<run>/pred/<scan>.npz` per file (a whole directory fetched nothing).
"""
import json
import os
import subprocess
from pathlib import Path

import modal

HERE = Path(__file__).parent
CODE = "/root/plate-finetune"
GPU = os.environ.get("MODAL_GPU", "A10,L40S").split(",")

vol = modal.Volume.from_name("plate-finetune", create_if_missing=True)
image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("git", "libgl1", "libglib2.0-0")
    .uv_sync(str(HERE), groups=["release"])
    .env({"PLATE_SCANS": "/vol/scans", "SAM31_WEIGHTS": "/vol/weights/sam3.1_multiplex.pt", "PYTHONPATH": CODE})
    .add_local_dir(HERE, CODE, ignore=[".venv", "data", "runs", "preds", "scores", "__pycache__"])
)
app = modal.App("plate-finetune", image=image)


def sh(cmd, log):
    print("$", " ".join(cmd), flush=True)
    p = subprocess.Popen(["python", *cmd], cwd=CODE, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    lines = []
    for line in p.stdout:
        lines.append(line)
        print(line, end="", flush=True)
    log.append("".join(lines))
    if p.wait():
        raise RuntimeError(f"{cmd[0]} failed ({p.returncode}); tail:\n{''.join(lines[-40:])}")


@app.function(gpu=GPU, volumes={"/vol": vol}, cpu=4, memory=32768, timeout=4 * 3600, retries=0)
def run_seed(data_name: str, seed: int, steps: int, lora_rank: int) -> dict:
    import shutil
    import time

    data = Path("/tmp/data") / data_name
    shutil.rmtree(data, ignore_errors=True)
    shutil.copytree(f"/vol/data/{data_name}", data)   # follows the band set's links into its region set
    run = Path(f"/vol/runs/{data_name}-s{seed}")
    shutil.rmtree(run, ignore_errors=True)
    run.mkdir(parents=True)
    split = json.loads((data / "split.json").read_text())
    log, t = [], {}
    t0 = time.time()
    sh(["train.py", "--data", str(data), "--out", str(run), "--lora-rank", str(lora_rank), "--steps", str(steps), "--seed", str(seed)], log)
    t["train_s"] = time.time() - t0
    t0 = time.time()
    sh(["predict.py", "--scan", *split["heldout"], *split["val"], "--ckpt", str(run / "ckpt-bestval.pt"), "--text", split["text"],
        "--out", str(run / "pred"), "--sections-from", str(data)], log)
    t["predict_s"] = time.time() - t0
    (run / "run.log").write_text("\n".join(log))
    vol.commit()
    val = [(r["step"], r["val_loss"]) for r in map(json.loads, (run / "log.jsonl").read_text().splitlines()) if "val_loss" in r]
    best = min(val, key=lambda x: x[1])
    return {"run": run.name, "best_val_step": best[0], "best_val_loss": best[1], **t}


@app.local_entrypoint()
def main(data: str, seeds: str = "0,1,2", steps: int = 3000, lora_rank: int = 16):
    for r in run_seed.starmap([(data, int(s), steps, lora_rank) for s in seeds.split(",")]):
        print(r["run"], "best val step", r["best_val_step"], round(r["best_val_loss"], 1),
              "train min", round(r["train_s"] / 60, 1), "predict min", round(r["predict_s"] / 60, 1))

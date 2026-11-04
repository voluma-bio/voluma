"""Serve the plate fine-tune on Modal: one web endpoint that predicts the growth-plate cut line on a tibia grid.

  uv run --group release modal deploy serve.py                         # app "plate-serve"
  PLATE_SERVE_APP=plate-serve-dev uv run --group release modal deploy serve.py

Runs don't call it yet (.context/TODO.md). README "Serving on Modal" has the request, the response and the costs.

Input, the training convention (scans.py): the tibia grid's HU volume and its tibia mask, axes (W, V, U), 10.5 µm voxels; a
coronal section is vol[:, V, :] (rows W, low W = the joint side, columns U). Either the request body is an .npz with `hu` (any
float or int dtype, HU) and `mask` (bool or 0/1), or the body is empty and `hu_key` and `mask_key` name two .npy objects under
dev/ in the R2 bucket. Query options: `ckpt` (comma list of CHECKPOINTS names, default DEFAULT), `vote` (off | all | abstain,
vote.py; ignored with one checkpoint), `sections` (comma list of V, default every V), `threshold` (detector score, default
THRESHOLD by recipe).

Response, an .npz: V; per checkpoint <name>.mask (n, W, U) the detector's mask (the region, or the band for a band model),
<name>.region (the region; a band model's cut on the faces' midline by band_to_region.band_regions), <name>.cut (n, W, U) the
region's cut-side boundary (cutline.cut_boundary, what score.py measures) and, for a band model, <name>.top / <name>.bottom
(n, U) the proximal and distal face rows W per column (NaN: no face; faces.band_faces); with a vote, vote.region and vote.cut.
`meta` is a JSON string: the options, each checkpoint's recipe and threshold, a band model's cut lines {name: {V: [[w, u], ...]}},
the GPU, and timings.

The base SAM 3.1 weights and the checkpoints load once per container (@modal.enter): one model, each checkpoint's trained
tensors swapped in per request (they all share the LoRA rank and tensor names). Checkpoints come from the plate-finetune volume,
or from Hugging Face with PLATE_CKPT_SOURCE=hf PLATE_HF_REPO=<owner>/<repo> at deploy (upload_weights.py's <name>.pt).
"""
import io
import json
import os
import time

import modal

from modal_train import GPU, image, vol

APP = os.environ.get("PLATE_SERVE_APP", "plate-serve")
CKPT_SOURCE = os.environ.get("PLATE_CKPT_SOURCE", "volume")
HF_REPO = os.environ.get("PLATE_HF_REPO", "")
LORA_RANK = 16
# name -> (recipe, checkpoint on the plate-finetune volume). Region = recipe A (prompt "epiphysis"), band = prompt "growth plate".
CHECKPOINTS = {
    **{f"region-s{s}": ("region", f"/runs/l29-a-s{s}/ckpt-bestval.pt") for s in range(3)},
    **{f"band-s{s}": ("band", f"/runs/l32-band-s{s}/ckpt-bestval.pt") for s in range(3)},
}
DEFAULT = "band-s0,band-s1,band-s2"   # the release recipe (RESULTS-L33): the 3 band seeds, voted
THRESHOLD = {"region": 0.5, "band": 0.3}   # detector score; at 0.3 no band section came back empty (L33)

app = modal.App(APP, image=image)

with image.imports():
    import numpy as np
    import torch
    from fastapi import HTTPException, Request, Response
    from sam3.model.sam3_image_processor import Sam3Processor

    import band
    import band_to_region
    import cutline
    import export
    import faces
    import model as M
    import vote as V
    from predict import predict_vol


@app.cls(gpu=GPU, volumes={"/vol": vol}, secrets=[modal.Secret.from_name("plate-serve-r2")],
         env={"PLATE_SERVE_APP": APP, "PLATE_CKPT_SOURCE": CKPT_SOURCE, "PLATE_HF_REPO": HF_REPO}, cpu=4, memory=16384,
         min_containers=0, scaledown_window=120, timeout=1800)
class Plate:
    @modal.enter()
    def load(self):
        t = time.time()
        self.model = M.build(lora_rank=LORA_RANK).eval()
        self.ckpts = {}
        for name, (_, path) in CHECKPOINTS.items():
            if CKPT_SOURCE == "hf":
                from huggingface_hub import hf_hub_download
                path = hf_hub_download(HF_REPO, f"{name}.pt")
            else:
                path = "/vol" + path
            state = torch.load(path, map_location="cuda", weights_only=True)
            assert state["lora_rank"] == LORA_RANK, f"{name}: LoRA rank {state['lora_rank']}"
            self.ckpts[name] = state
        self.load_s = time.time() - t
        print(f"loaded base + {len(self.ckpts)} checkpoints in {self.load_s:.1f} s", flush=True)

    def grid(self, request, body):
        q = request.query_params
        if body:
            z = np.load(io.BytesIO(body))
            return z["hu"], z["mask"]
        keys = q.get("hu_key"), q.get("mask_key")
        if not all(keys) or not all(k.startswith("dev/") for k in keys):
            raise HTTPException(400, "send an .npz body (hu, mask) or hu_key and mask_key under dev/")
        import boto3
        s3 = boto3.client("s3", endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
                          aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"], aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
                          region_name="auto")
        try:
            return [np.load(io.BytesIO(s3.get_object(Bucket=os.environ["R2_BUCKET"], Key=k)["Body"].read())) for k in keys]
        except s3.exceptions.NoSuchKey:
            raise HTTPException(404, f"no object at {keys}") from None

    @modal.fastapi_endpoint(method="POST", requires_proxy_auth=True)
    async def predict(self, request: Request):
        t0 = time.time()
        q = request.query_params
        names = q.get("ckpt", DEFAULT).split(",")
        if unknown := [n for n in names if n not in CHECKPOINTS]:
            raise HTTPException(400, f"unknown checkpoint {unknown}; have {list(CHECKPOINTS)}")
        if (how := q.get("vote", "abstain")) not in ("off", "all", "abstain"):
            raise HTTPException(400, f"vote is off, all or abstain, not {how!r}")
        hu, tibia = self.grid(request, await request.body())
        if hu.ndim != 3 or hu.shape != tibia.shape:
            raise HTTPException(400, f"hu {hu.shape} and mask {tibia.shape} must be one (W, V, U) grid")
        tibia = tibia.astype(bool)
        try:
            vs = [int(v) for v in q["sections"].split(",")] if q.get("sections") else list(range(hu.shape[1]))
            thresholds = {n: float(q.get("threshold") or THRESHOLD[CHECKPOINTS[n][0]]) for n in names}
        except ValueError as e:
            raise HTTPException(400, f"sections and threshold must be numbers: {e}") from None
        if not all(0 <= v < hu.shape[1] for v in vs):
            raise HTTPException(400, f"sections must lie in 0..{hu.shape[1] - 1}")
        t_in = time.time() - t0
        envs = np.stack([cutline.envelope(tibia[:, v, :]) for v in vs])
        out, lines, t_ck = {"V": np.array(vs)}, {}, {}
        for name in names:
            t = time.time()
            recipe = CHECKPOINTS[name][0]
            M.load_trainable(self.model, self.ckpts[name])
            proc = Sam3Processor(self.model, confidence_threshold=thresholds[name])
            with torch.no_grad(), torch.autocast("cuda", dtype=torch.bfloat16):
                mask = predict_vol(proc, hu, {"region": export.TEXT, "band": band.TEXT}[recipe], vs)
            t_pred = time.time() - t
            out[f"{name}.mask"] = mask
            if recipe == "band":
                region, ls = band_to_region.band_regions(mask, vs, tibia)
                fs = [faces.band_faces(m, ls[v]) if v in ls else (np.full(hu.shape[2], np.nan),) * 2 for v, m in zip(vs, mask)]
                out[f"{name}.top"], out[f"{name}.bottom"] = (np.stack(x) for x in zip(*fs))
                lines[name] = {v: p.tolist() for v, p in ls.items()}
            else:
                region = mask
            out[f"{name}.region"] = region
            out[f"{name}.cut"] = np.stack([cutline.cut_boundary(r & e, e) for r, e in zip(region, envs)])
            t_ck[name] = {"predict": round(t_pred, 2), "post": round(time.time() - t - t_pred, 2)}
        if len(names) > 1 and how != "off":
            out["vote.region"] = V.vote(np.stack([out[f"{n}.region"] for n in names]), abstain=how == "abstain")
            out["vote.cut"] = np.stack([cutline.cut_boundary(r & e, e) for r, e in zip(out["vote.region"], envs)])
        meta = {"axes": "mask/region/cut (n, W, U); top/bottom (n, U); lines [w, u]", "um_per_voxel": 10.5, "grid": list(hu.shape),
                "ckpt": {n: {"recipe": CHECKPOINTS[n][0], "threshold": thresholds[n]} for n in names},
                "vote": how if len(names) > 1 else "off", "source": CKPT_SOURCE, "gpu": torch.cuda.get_device_name(), "lines": lines,
                "seconds": {"container_load": round(self.load_s, 1), "input": round(t_in, 2), "per_ckpt": t_ck, "total": round(time.time() - t0, 2)}}
        buf = io.BytesIO()
        np.savez_compressed(buf, meta=np.array(json.dumps(meta)), **out)
        return Response(buf.getvalue(), media_type="application/octet-stream")

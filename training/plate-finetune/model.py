"""Build Sam3Image from the stock SAM 3.1 weights, optionally with LoRA on the ViT and a trained checkpoint.

The ViT trunk and text encoder are always frozen; the neck, fusion encoder, decoder, scoring and mask heads train, and with
lora_rank > 0 so does rank-r LoRA on the ViT attention linears. A checkpoint holds only the trainable tensors plus the LoRA rank,
so it loads on top of the stock weights without any key remap.
"""
import torch
from peft import LoraConfig, inject_adapter_in_model
from sam3.model import vitdet
from sam3.model_builder import build_sam3_image_model

import scans

# Meta's fused MLP op (perflib.fused.addmm_act) raises when autograd is on, so the shipped ViT cannot be trained as
# is. A plain linear + activation is the same maths and differentiable.
vitdet.addmm_act = lambda act, linear, x: act()(linear(x)) if isinstance(act, type) else act(linear(x))

FROZEN = ("backbone.language_backbone.", "backbone.vision_backbone.trunk.")


def build(ckpt=None, lora_rank=0, device="cuda"):
    """Stock weights (ckpt None) or stock + trained tensors from `ckpt`; lora_rank comes from the ckpt if given."""
    state = torch.load(ckpt, map_location="cpu", weights_only=True) if ckpt else None
    if state:
        lora_rank = state["lora_rank"]
    model = build_sam3_image_model(checkpoint_path=str(scans.env_path("SAM31_WEIGHTS")), load_from_HF=False, device="cpu",
                                   eval_mode=False, enable_segmentation=True)
    if lora_rank:
        cfg = LoraConfig(r=lora_rank, lora_alpha=2 * lora_rank, lora_dropout=0.0,
                         target_modules=r".*blocks\.\d+\.attn\.(qkv|proj)")
        model.backbone.vision_backbone.trunk = inject_adapter_in_model(cfg, model.backbone.vision_backbone.trunk)
    if state:
        load_trainable(model, state)
    return model.to(device)


def load_trainable(model, state):
    """Overwrite the model's trainable tensors with a checkpoint's (serve.py swaps checkpoints this way on one model)."""
    bad = model.load_state_dict(state["trainable"], strict=False)
    assert not bad.unexpected_keys, bad.unexpected_keys


def set_trainable(model):
    """Freeze ViT trunk + text encoder (LoRA tensors stay trainable)."""
    for n, p in model.named_parameters():
        p.requires_grad = (not n.startswith(FROZEN)) or "lora_" in n


def save(model, path, lora_rank):
    sd = {n: p.detach().cpu() for n, p in model.named_parameters() if p.requires_grad}
    torch.save({"lora_rank": lora_rank, "trainable": sd}, path)

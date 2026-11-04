"""Ignore voxels in SAM 3's mask loss, and a NaN fix in its focal loss (hydra targets in train_config.yaml).

export.py puts the ignore voxels in each annotation's segmentation dict as an extra "ignore" RLE. DecodeRleIgnore replaces the
stock DecodeRle: it decodes target and ignore into one uint8 mask (1 target, 2 ignore; ignore wins), which the stock flip / resize
transforms carry along unchanged (the datapoint is 1008 square, so resize is a no-op). MasksIgnore is the stock Masks loss with
ignore pixels removed: their logits become a constant -30 with target 0, which adds nothing to the focal or dice sums and passes
no gradient. Box and classification losses use the box of the target only, so ignore voxels never count as positive there either.
"""
import functools

import torch
from pycocotools import mask as mu
from sam3.train.loss import loss_fns
from sam3.train.loss.loss_fns import Masks, dice_loss, sigmoid_focal_loss
from sam3.train.transforms.segmentation import DecodeRle
from torch.nn.functional import interpolate

IGNORE = 2


class DecodeRleIgnore(DecodeRle):
    def __call__(self, datapoint, **kwargs):
        ignore = {}
        for i, img in enumerate(datapoint.images):
            for j, obj in enumerate(img.objects):
                if isinstance(obj.segment, dict) and "ignore" in obj.segment:
                    ignore[i, j] = obj.segment["ignore"]
                    obj.segment = {k: v for k, v in obj.segment.items() if k != "ignore"}
        datapoint = super().__call__(datapoint, **kwargs)
        for (i, j), rle in ignore.items():
            datapoint.images[i].objects[j].segment[torch.from_numpy(mu.decode(rle)).bool()] = IGNORE
        return datapoint


class MasksIgnore(Masks):
    def __init__(self, **kw):
        assert kw.get("num_sample_points") is None, "point-sampled mask loss is not supported with ignore"
        super().__init__(**kw)

    def get_loss(self, outputs, targets, indices, num_boxes):
        assert targets["masks"] is not None
        pick = (lambda x: x) if indices[2] is None else (lambda x: x[indices[2]])
        tm = pick(targets["masks"]).to(outputs["pred_masks"])
        keep = pick(targets["is_valid_mask"])
        src = outputs["pred_masks"][(indices[0], indices[1])][keep][:, None].float()
        tm = tm[keep]
        src = interpolate(src, size=tm.shape[-2:], mode="bilinear", align_corners=False)[:, 0]
        src = torch.where(tm == IGNORE, src.new_tensor(-30.0), src).flatten(1)
        tm = (tm == 1).to(src).flatten(1)
        return {"loss_mask": sigmoid_focal_loss(src, tm, num_boxes, alpha=self.focal_alpha, gamma=self.focal_gamma),
                "loss_dice": dice_loss(src, tm, num_boxes)}


def _focal_gamma0_safe(fn):
    """Meta's fused (Triton) focal loss backward is 0 * pow(0, -1) = NaN when gamma is 0 and the sigmoid saturates to 1
    (logit above ~15.5 in bf16/fp32), which the presence head (presence_gamma 0) reaches once it is confident: an early run lost
    a third of its batches to it. The plain-torch path gives the same loss and a zero gradient there."""
    @functools.wraps(fn)
    def wrapped(inputs, targets, num_boxes, *a, **k):
        if k.get("gamma", 2) == 0:
            k["triton"] = False
        return fn(inputs, targets, num_boxes, *a, **k)
    return wrapped


loss_fns.sigmoid_focal_loss = _focal_gamma0_safe(loss_fns.sigmoid_focal_loss)

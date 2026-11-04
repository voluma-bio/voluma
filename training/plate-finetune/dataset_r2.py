"""Push the exported training sets to R2 with a sha256 manifest, or pull and verify them.

  uv run --group release python dataset_r2.py push data/region data/band     # needs R2_* (below)
  uv run --group release python dataset_r2.py pull --out data                 # checks every sha256

Objects go under PREFIX/<set>/<path>; PREFIX/manifest.json lists each file's size and sha256 and each symlink's target (the band
set's img/ and labels/ point into the region set), and pull recreates the links. Credentials: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
R2_SECRET_ACCESS_KEY, R2_BUCKET from the environment. `dev/` keys are never read by Voluma's staging app.
"""
import argparse
import hashlib
import json
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import boto3

PREFIX = "dev/datasets/plate-finetune/v1"


def client():
    return boto3.client("s3", endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
                        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"], aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
                        region_name="auto")


def sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def walk(root):
    """Files and symlinks under root, not following links: {relative path: Path}."""
    out = {}
    for d, dirs, files in os.walk(root):
        for n in dirs + files:
            p = Path(d) / n
            if p.is_symlink() or p.is_file():
                out[str(p.relative_to(root.parent))] = p
    return out


def push(sets):
    s3, bucket = client(), os.environ["R2_BUCKET"]
    files, links = {}, {}
    for root in sets:
        for rel, p in walk(root.resolve()).items():
            if p.is_symlink():
                links[rel] = os.readlink(p)
            else:
                files[rel] = p
    manifest = {"prefix": PREFIX, "links": links, "files": {}}

    def one(rel):
        p = files[rel]
        manifest["files"][rel] = {"bytes": p.stat().st_size, "sha256": sha256(p)}
        s3.upload_file(str(p), bucket, f"{PREFIX}/{rel}")

    with ThreadPoolExecutor(16) as ex:
        list(ex.map(one, sorted(files)))
    manifest["files"] = dict(sorted(manifest["files"].items()))
    s3.put_object(Bucket=bucket, Key=f"{PREFIX}/manifest.json", Body=json.dumps(manifest, indent=1).encode())
    print(f"pushed {len(files)} files, {sum(f['bytes'] for f in manifest['files'].values()) / 1e6:.0f} MB, {len(links)} links to {PREFIX}/")


def pull(out):
    s3, bucket = client(), os.environ["R2_BUCKET"]
    manifest = json.loads(s3.get_object(Bucket=bucket, Key=f"{PREFIX}/manifest.json")["Body"].read())

    def one(item):
        rel, meta = item
        p = out / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        s3.download_file(bucket, f"{PREFIX}/{rel}", str(p))
        return rel if sha256(p) != meta["sha256"] else None

    with ThreadPoolExecutor(16) as ex:
        bad = [r for r in ex.map(one, manifest["files"].items()) if r]
    for rel, target in manifest["links"].items():
        p = out / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        if not p.is_symlink():
            p.symlink_to(target)
    if bad:
        raise SystemExit(f"sha256 mismatch: {bad}")
    print(f"pulled {len(manifest['files'])} files and {len(manifest['links'])} links into {out}, all sha256 match")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("push")
    p.add_argument("sets", nargs="+", type=Path, help="export directories, each pushed as PREFIX/<its name>/")
    q = sub.add_parser("pull")
    q.add_argument("--out", required=True, type=Path)
    a = ap.parse_args()
    push(a.sets) if a.cmd == "push" else pull(a.out)


if __name__ == "__main__":
    main()

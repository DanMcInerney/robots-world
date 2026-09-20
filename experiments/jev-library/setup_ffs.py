"""Reproduce isolated Windows FFS dependencies and verified official model bytes.

Run with any Python 3.11+ and uv on PATH. Installation does not run GPU inference.
All downloads, third-party code, environments and logs remain in ignored runtime.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_RUNTIME = ROOT / ".runtime/experiments/jev-library-v1/ffs"
REPOSITORY = "https://github.com/NVlabs/Fast-FoundationStereo.git"
COMMIT = "476f4249561f7c79ca707326954f9255643412a6"
DOWNLOADS = {
    "cfg.yaml": ("1DvQrzvR46fsh0dVVbvwdQlSmvO8sVf69",
                 "d45afe99b176454d5aff416edf16c8da6a99579f8f374b927f37907442a7d6bc"),
    "model_best_bp2_serialize.pth": ("1ZsXw3WwBmtNdv1lqdEJ95kyvf7J4YusE",
                 "98b5a9acf39fbfa795025de8cea95ce123daa40f6b6234d719167751024cf692"),
}
DEPENDENCIES = ["numpy==2.2.6", "timm==1.0.22", "einops==0.8.1",
    "omegaconf==2.3.0", "scipy==1.16.3", "opencv-python-headless==4.12.0.88",
    "imageio==2.37.2", "pyyaml==6.0.3", "gdown==5.2.0"]


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-root", type=Path, default=DEFAULT_RUNTIME)
    args = parser.parse_args()
    runtime = args.runtime_root.resolve()
    runtime.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    log_path = runtime / f"setup-{stamp}.log"
    with log_path.open("w", encoding="utf-8") as log:
        def run(command):
            command = list(map(str, command))
            log.write(json.dumps(command) + "\n")
            log.flush()
            result = subprocess.run(command, text=True, encoding="utf-8", errors="replace",
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            log.write(result.stdout + "\n")
            log.flush()
            print(result.stdout, end="", flush=True)
            result.check_returncode()
            return result.stdout

        repo = runtime / "repo"
        if not repo.exists():
            run(["git", "clone", "--no-checkout", REPOSITORY, repo])
            run(["git", "-C", repo, "checkout", COMMIT])
        revision = run(["git", "-C", repo, "rev-parse", "HEAD"]).strip()
        dirty = run(["git", "-C", repo, "status", "--porcelain", "--untracked-files=no"]).strip()
        if revision != COMMIT or dirty:
            raise RuntimeError("Existing FFS checkout differs; preserving it without alteration")
        run(["uv", "python", "install", "3.11.14"])
        venv = runtime / "venv"
        python = venv / "Scripts/python.exe"
        if not venv.exists():
            run(["uv", "venv", "--python", "3.11.14", venv])
        run(["uv", "pip", "install", "--python", python, "torch==2.8.0", "torchvision==0.23.0",
             "--index-url", "https://download.pytorch.org/whl/cu128"])
        run(["uv", "pip", "install", "--python", python, *DEPENDENCIES])
        weights = runtime / "weights/20-30-48"
        weights.mkdir(parents=True, exist_ok=True)
        for name, (file_id, expected) in DOWNLOADS.items():
            target = weights / name
            if not target.exists():
                partial = target.with_suffix(target.suffix + ".partial")
                run([python, "-c", "import gdown,sys; gdown.download(id=sys.argv[1],output=sys.argv[2],quiet=False)",
                     file_id, partial])
                if digest(partial) != expected:
                    raise RuntimeError(f"Official download hash mismatch; preserving {partial}")
                partial.rename(target)
            if digest(target) != expected:
                raise RuntimeError(f"Existing checkpoint/config hash mismatch: {target}")
        versions = run(["uv", "pip", "freeze", "--python", python])
        (runtime / f"requirements-{stamp}.txt").write_text(versions, encoding="utf-8")
        run([python, ROOT / "experiments/jev-library/learned_stereo.py", "--self-test"])
        metadata = {"createdAtUtc": stamp, "repository": REPOSITORY, "commit": revision,
            "checkpoint": "20-30-48", "downloads": {name: {"googleDriveId": item[0], "sha256": item[1]}
                for name, item in DOWNLOADS.items()}, "python": str(python),
            "setupLog": str(log_path), "gpuInferenceExecuted": False,
            "implementation": "Official unmodified eager PyTorch, TORCHDYNAMO_DISABLE=1; no Triton or xformers required.",
            "license": "Research checkpoint/code from NVlabs; upstream license retained in repo/LICENSE.txt."}
        (runtime / f"setup-{stamp}.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
        print(json.dumps(metadata, indent=2))


if __name__ == "__main__":
    main()

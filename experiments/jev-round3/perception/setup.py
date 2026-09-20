"""Record this experiment's isolated runtime and fixed public model provenance."""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import platform
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DEFAULT_OUTPUT = ROOT / ".runtime/experiments/jev-round3-v1/perception"
CHECKPOINT_URL = "https://github.com/ultralytics/assets/releases/download/v8.3.0/yolo11s-seg.pt"
SMOKE_URL = "https://raw.githubusercontent.com/ultralytics/assets/main/im/bus.jpg"


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--record-name", default="environment.json")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "models").mkdir(exist_ok=True)
    (args.output / "setup").mkdir(exist_ok=True)
    checkpoint = args.output / "models/yolo11s-seg.pt"
    if not checkpoint.exists():
        urllib.request.urlretrieve(CHECKPOINT_URL, checkpoint)
    smoke = args.output / "setup/public-bus.jpg"
    if not smoke.exists():
        urllib.request.urlretrieve(SMOKE_URL, smoke)
    import torch
    packages = {dist.metadata["Name"]: dist.version for dist in importlib.metadata.distributions()}
    record = {"python": sys.version, "executable": sys.executable, "platform": platform.platform(),
              "packages": packages, "torchCuda": torch.version.cuda,
              "cudaAvailable": torch.cuda.is_available(),
              "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
              "gpuCapability": list(torch.cuda.get_device_capability(0)) if torch.cuda.is_available() else None,
              "torchCudaArchitectures": torch.cuda.get_arch_list(),
              "checkpoint": {"path": str(checkpoint.resolve()), "url": CHECKPOINT_URL,
                             "sha256": digest(checkpoint), "sizeBytes": checkpoint.stat().st_size},
              "smokeImage": {"path": str(smoke.resolve()), "url": SMOKE_URL,
                             "sha256": digest(smoke), "purpose": "setup only, excluded from scored experiment"},
              "nvidiaSmi": subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total,driver_version",
                  "--format=csv"], capture_output=True, text=True, check=False).stdout}
    (args.output / "setup" / args.record_name).write_text(json.dumps(record, indent=2), encoding="utf-8")
    (args.output / "setup/resolved-packages.txt").write_text("\n".join(
        f"{name}=={version}" for name, version in sorted(packages.items())) + "\n", encoding="utf-8")
    print(json.dumps(record, indent=2))


if __name__ == "__main__":
    main()

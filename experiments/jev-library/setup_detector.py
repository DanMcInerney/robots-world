"""Download/record pinned detector assets; optionally build the local FP16 engine.

Isolated bootstrap (uv uses its existing cache):
  uv venv --python 3.11 .runtime/experiments/jev-library-v1/detector/.venv
  uv pip install --python <venv-python> torch==2.8.0 torchvision==0.23.0 --index-url https://download.pytorch.org/whl/cu128
  uv pip install --python <venv-python> ultralytics==8.4.157 lap==0.5.13 scipy==1.17.1 numpy==2.2.6 opencv-python==4.12.0.88 onnx==1.19.1 onnxslim==0.1.96
  uv pip install --python <venv-python> tensorrt-cu12==10.13.3.9 --extra-index-url https://pypi.nvidia.com --index-strategy unsafe-best-match

Run this using the isolated Python. --export needs exclusive access to the GPU.
Download/environment recording is separate from GPU inference or export.
"""
from __future__ import annotations

import argparse
import contextlib
import importlib.metadata
import json
import platform
import shutil
import subprocess
import sys
import time
import traceback
import urllib.request
from pathlib import Path

from detector import CHECKPOINTS, ROOT, RUNTIME, ULTRALYTICS_VERSION, configure_runtime, sha256

URLS = {"yolo11s-seg.pt": "https://github.com/ultralytics/assets/releases/download/v8.3.0/yolo11s-seg.pt",
        "yolo26s-seg.pt": "https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo26s-seg.pt"}
EXPORT = {"format": "engine", "device": 0, "imgsz": [384, 640], "batch": 1,
          "quantize": 16, "dynamic": False, "simplify": True,
          "workspace": 4, "nms": False, "opset": 17, "verbose": False}


def save_new(path, data):
    with Path(path).open("x", encoding="utf-8") as stream:
        json.dump(data, stream, indent=2, allow_nan=False)


def assets(runtime):
    records = []
    for name, url in URLS.items():
        path = runtime / "models" / name
        previous = ROOT / ".runtime/experiments/jev-round3-v1/perception/models" / name
        if not path.exists():
            if name == "yolo11s-seg.pt" and previous.is_file():
                shutil.copyfile(previous, path)
            else:
                urllib.request.urlretrieve(url, path)
        digest = sha256(path)
        if digest != CHECKPOINTS[name]:
            raise ValueError(f"Unexpected public checkpoint bytes: {name}")
        records.append({"path": str(path.resolve()), "url": url, "sha256": digest,
            "sizeBytes": path.stat().st_size,
            "priorBaselinePath": str(previous) if name == "yolo11s-seg.pt" else None})
    return records


def environment(runtime):
    import torch
    packages = {d.metadata["Name"]: d.version for d in importlib.metadata.distributions()}
    return {"python": sys.version, "executable": sys.executable, "platform": platform.platform(),
        "packages": packages, "torchCuda": torch.version.cuda,
        "cudaAvailable": torch.cuda.is_available(),
        "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "gpuCapability": list(torch.cuda.get_device_capability(0)) if torch.cuda.is_available() else None,
        "torchCudaArchitectures": torch.cuda.get_arch_list(), "checkpoints": assets(runtime),
        "nvidiaSmi": subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total,driver_version",
            "--format=csv"], capture_output=True, text=True, check=False).stdout,
        "sourceDocumentation": ["https://docs.ultralytics.com/models/yolo26/",
            "https://docs.ultralytics.com/integrations/tensorrt/",
            "https://docs.nvidia.com/deeplearning/tensorrt/10.x.x/installing-tensorrt/install-pip.html"],
        "tensorRtSelection": "10.13.3.9 CUDA12 Windows cp311; TRT10 builder FP16 path, no TRT11 ModelOpt conversion",
        "gpuInferencePerformedByThisRecord": False}


def export_engine(runtime):
    import torch
    from ultralytics import YOLO
    import ultralytics
    import tensorrt as trt
    if ultralytics.__version__ != ULTRALYTICS_VERSION or trt.__version__ != "10.13.3.9":
        raise RuntimeError("Export runtime differs from frozen versions")
    if torch.__version__ != "2.8.0+cu128" or not torch.cuda.is_available():
        raise RuntimeError("Pinned CUDA runtime unavailable; no fallback")
    checkpoint = runtime / "models/yolo11s-seg.pt"
    if sha256(checkpoint) != CHECKPOINTS[checkpoint.name]:
        raise ValueError("Export source differs from Round 3 checkpoint")
    destination = checkpoint.with_suffix(".engine")
    if destination.exists():
        raise FileExistsError("Refusing to replace an existing engine")
    record = {"sourceCheckpoint": str(checkpoint.resolve()), "sourceSha256": sha256(checkpoint),
        "arguments": EXPORT, "purpose": "same-checkpoint FP16 backend comparison, no study images",
        "shapeReason": "640x360 RGB with baseline rect=true/imgsz=640 produces 640x384 letterboxed input",
        "startTimeUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    stamp = time.strftime("%Y%m%dT%H%M%S", time.gmtime())
    record_path = runtime / f"setup/export-{stamp}.json"
    started = time.perf_counter()
    try:
        with (runtime / f"setup/export-{stamp}.log").open("x", encoding="utf-8") as log:
            with contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
                model = YOLO(str(checkpoint), task="segment")
                result = Path(model.export(**EXPORT)).resolve()
        if result != destination.resolve() or not destination.is_file():
            raise RuntimeError("Exporter did not return the expected engine artifact")
        record.update(status="complete", enginePath=str(result), engineSha256=sha256(result),
                      engineSizeBytes=result.stat().st_size)
    except Exception as error:
        record.update(status="failed", errorType=type(error).__name__, error=str(error),
                      traceback=traceback.format_exc())
        raise
    finally:
        record["elapsedSeconds"] = time.perf_counter() - started
        save_new(record_path, record)
    return record


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime", type=Path, default=RUNTIME)
    parser.add_argument("--record", default="environment.json")
    parser.add_argument("--export", action="store_true")
    args = parser.parse_args()
    for directory in ("setup", "models"):
        (args.runtime / directory).mkdir(parents=True, exist_ok=True)
    configure_runtime(args.runtime)
    if args.export:
        record = export_engine(args.runtime)
    else:
        record = environment(args.runtime)
        save_new(args.runtime / "setup" / args.record, record)
        packages = record["packages"]
        with (args.runtime / "setup/resolved-packages.txt").open("x", encoding="utf-8") as stream:
            stream.write("\n".join(f"{name}=={version}" for name, version in sorted(packages.items())) + "\n")
    print(json.dumps(record, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()

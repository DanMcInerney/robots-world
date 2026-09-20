"""Pinned detector adapter; only supplied RGB enters inference.

The public output matches Round 3's Detector. PyTorch FP32 is the control for
both the YOLO26 and same-checkpoint TensorRT FP16 comparisons. No auto-download,
package installation, CPU fallback, or model substitution is permitted here.
"""
from __future__ import annotations

import contextlib
import hashlib
import importlib.metadata
import json
import os
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
RUNTIME = ROOT / ".runtime/experiments/jev-library-v1/detector"
ULTRALYTICS_VERSION = "8.4.157"
CHECKPOINTS = {
    "yolo11s-seg.pt": "1caa81c0195412efa411b632bcfb8c184939dddb6ae41f6a80c41b211ff257c3",
    "yolo26s-seg.pt": "3da1d83e31caec96f9300eb4064f4f62882c133c7c264d63dfe61a7c197837a4",
}
PARAMETERS = {"imgsz": 640, "iou": 0.7, "max_det": 100,
              "retina_masks": True, "augment": False, "rect": True}


def sha256(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def configure_runtime(runtime_root=RUNTIME):
    # Must precede the first Ultralytics import in the process.
    config = Path(runtime_root).resolve() / "setup/ultralytics"
    config.mkdir(parents=True, exist_ok=True)
    os.environ["YOLO_CONFIG_DIR"] = str(config)
    os.environ["YOLO_AUTOINSTALL"] = "false"
    os.environ["YOLO_OFFLINE"] = "true"


class Detector:
    def __init__(self, checkpoint, device="0", runtime_root=RUNTIME, half=False, conf=0.25):
        configure_runtime(runtime_root)
        self.device, self.half, self.conf = str(device), bool(half), float(conf)
        self.checkpoint = Path(checkpoint).resolve()
        if not self.checkpoint.is_file():
            raise FileNotFoundError(self.checkpoint)
        self.checkpoint_hash = sha256(self.checkpoint)
        self.engine = self.checkpoint.suffix == ".engine"
        if not 0 < self.conf < 1:
            raise ValueError("conf must lie between zero and one")
        if self.engine:
            if not self.half or self.device == "cpu":
                raise ValueError("This experiment's TensorRT engine requires GPU FP16")
            exports = [json.loads(path.read_text(encoding="utf-8"))
                       for path in (Path(runtime_root) / "setup").glob("export-*.json")]
            matching = [record for record in exports if record.get("status") == "complete"
                        and record.get("engineSha256") == self.checkpoint_hash
                        and record.get("sourceSha256") == CHECKPOINTS["yolo11s-seg.pt"]
                        and record.get("arguments", {}).get("imgsz") == [384, 640]
                        and record.get("arguments", {}).get("quantize") == 16]
            if len(matching) != 1:
                raise ValueError("Engine must match one completed frozen export provenance record")
        elif CHECKPOINTS.get(self.checkpoint.name) != self.checkpoint_hash:
            raise ValueError("Checkpoint is not one of the explicitly pinned model files")
        started = time.perf_counter()
        import torch
        import ultralytics
        from ultralytics import YOLO
        if ultralytics.__version__ != ULTRALYTICS_VERSION:
            raise RuntimeError("Ultralytics differs from the frozen experiment version")
        if torch.__version__ != "2.8.0+cu128":
            raise RuntimeError("Torch differs from the frozen CUDA 12.8 environment")
        torch.set_num_threads(4)
        torch.manual_seed(0)
        np.random.seed(0)
        torch.backends.cudnn.benchmark = False
        if self.device != "cpu" and not torch.cuda.is_available():
            raise RuntimeError("CUDA requested but unavailable; no CPU fallback")
        self.torch = torch
        with contextlib.redirect_stdout(sys.stderr):
            self.model = YOLO(str(self.checkpoint), task="segment")
        self.load_ms = (time.perf_counter() - started) * 1000
        self.metadata = {"checkpointName": self.checkpoint.name,
            "checkpointPath": str(self.checkpoint), "checkpointSha256": self.checkpoint_hash,
            "ultralyticsVersion": ultralytics.__version__, "torchVersion": torch.__version__,
            "torchCuda": torch.version.cuda, "device": self.device, "half": self.half,
            "conf": self.conf, **PARAMETERS, "torchCpuThreads": 4,
            "backend": "TensorRT" if self.engine else "PyTorch",
            "endToEnd": False if self.engine else bool(getattr(self.model.model, "end2end", False)),
            "nmsNote": "External NMS; pinned nms=None selects one-to-many outputs for both checkpoints; conf/iou apply.",
            "precisionArgument": {"quantize": 16 if self.half else 32},
            "engineInputShape": [1, 3, 384, 640] if self.engine else None,
            "tensorRtVersion": importlib.metadata.version("tensorrt-cu12") if self.engine else None,
            "inputEvidence": "supplied BGR only; no evaluator records"}
        if self.engine:
            self.metadata["exportProvenance"] = matching[0]

    def sync(self):
        if self.device != "cpu":
            self.torch.cuda.synchronize()

    def warmup(self):
        blank = np.zeros((360, 640, 3), np.uint8)
        return {"purpose": "startup only, no study pixels", "image": "all-zero BGR 640x360",
                "modelLoadMs": self.load_ms,
                "warmupPredictions": [self.predict(blank)[2] for _ in range(3)]}

    def predict(self, bgr):
        if bgr.dtype != np.uint8 or bgr.ndim != 3 or bgr.shape[2] != 3:
            raise ValueError("Expected uint8 HWC BGR image")
        if self.engine and bgr.shape[:2] != (360, 640):
            raise ValueError("Frozen engine is qualified only for 640x360 source RGB")
        self.sync()
        start = time.perf_counter()
        with contextlib.redirect_stdout(sys.stderr):
            results = self.model.predict(bgr, device=self.device, verbose=False, save=False,
                **PARAMETERS, conf=self.conf, quantize=16 if self.half else 32)
        self.sync()
        predicted = time.perf_counter()
        result = results[0]
        boxes = result.boxes.xyxy.cpu().numpy()
        confidence = result.boxes.conf.cpu().numpy()
        classes = result.boxes.cls.cpu().numpy()
        masks = result.masks.data.cpu().numpy() > 0.5 if result.masks is not None else \
            np.zeros((len(boxes), *bgr.shape[:2]), bool)
        if masks.shape != (len(boxes), *bgr.shape[:2]):
            raise ValueError("Retina segmentation masks are not aligned to RGB/detections")
        detections = [{"detectionId": f"detection-{index:03d}", "classId": int(cls),
            "className": result.names[int(cls)], "confidence": float(conf),
            "boxXyxy": list(map(float, box)), "identity": "tentative-frame-local",
            "maskAvailable": result.masks is not None}
            for index, (box, conf, cls) in enumerate(zip(boxes, confidence, classes))]
        return detections, masks, {"detectorPredictWallMs": (predicted-start)*1000,
            "detectorExtractionMs": (time.perf_counter()-predicted)*1000,
            "ultralyticsInternalMs": {key: float(value) for key, value in result.speed.items()}}

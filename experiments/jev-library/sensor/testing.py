"""Shared CPU-only test fixtures: fake `Detector`/`StereoBackend` doubles and tiny synthetic
stereo pairs written to disk. No GPU, no model weights, no network — every sensor test built on
these fixtures runs anywhere. (Named `testing.py`, not `test_*.py`, so `unittest discover` does
not try to collect it as a test module itself.)
"""
from __future__ import annotations

import copy
import json
import time
from pathlib import Path
from typing import Optional

import cv2
import numpy as np

from .frames import FrameRef, TakeResult


def write_fixture_frame(directory: Path, name: str, width: int = 40, height: int = 30) -> dict:
    """Writes a tiny synthetic rectified stereo pair (flat background + one solid block, offset a
    few pixels between left/right so SGBM has real, if trivial, disparity to find) plus a matching
    calibration.json, and returns a manifest-shaped sample dict pointing at them."""
    left = np.zeros((height, width, 3), np.uint8)
    left[:] = (60, 90, 40)
    left[height // 3 : 2 * height // 3, width // 4 : 3 * width // 4] = (30, 30, 200)  # a reddish block
    right = np.roll(left, shift=3, axis=1)
    directory.mkdir(parents=True, exist_ok=True)
    left_path, right_path = directory / f"{name}-left.png", directory / f"{name}-right.png"
    cv2.imwrite(str(left_path), left)
    cv2.imwrite(str(right_path), right)
    calibration = {
        "width": width, "height": height, "fx": 60.0, "fy": 60.0, "cx": width / 2, "cy": height / 2,
        "baseline_m": 0.2, "doffsPx": 0, "rectified": True, "distortion": [0, 0, 0, 0, 0],
        "pixel_coordinates": "u=column+0.5,v=row+0.5; top-left origin",
    }
    calibration_path = directory / f"{name}-calibration.json"
    calibration_path.write_text(json.dumps(calibration), encoding="utf-8")
    return {"id": name, "leftPath": str(left_path), "rightPath": str(right_path), "calibrationPath": str(calibration_path)}


def make_detection(class_name: str = "car", confidence: float = 0.8, box=(5.0, 5.0, 20.0, 20.0), class_id: int = 2, detection_id: str = "detection-000") -> dict:
    return {"detectionId": detection_id, "classId": class_id, "className": class_name, "confidence": confidence,
            "boxXyxy": list(box), "identity": "tentative-frame-local", "maskAvailable": True}


def make_mask(height: int, width: int, box=(5.0, 5.0, 20.0, 20.0)) -> np.ndarray:
    mask = np.zeros((height, width), bool)
    x0, y0, x1, y1 = [max(0, int(round(v))) for v in box]
    x1, y1 = min(width, x1), min(height, y1)
    mask[y0:y1, x0:x1] = True
    return mask


class FakeDetector:
    """Returns a fixed detections/masks pair for every call by default, or a per-call result via
    `on_predict(bgr, call_index) -> (detections, masks)`. `delay_s` lets tests force a processing
    stage to be slower than a given replay rate, deterministically."""
    def __init__(self, detections: Optional[list] = None, masks: Optional[np.ndarray] = None,
                 delay_s: float = 0.0, on_predict=None) -> None:
        self.detections = detections if detections is not None else []
        self.masks = masks if masks is not None else np.zeros((0, 1, 1), bool)
        self.delay_s = delay_s
        self.on_predict = on_predict
        self.calls = 0
        self.metadata = {"backend": "fake", "checkpointName": "fake.pt"}

    def predict(self, bgr: np.ndarray):
        self.calls += 1
        if self.delay_s:
            time.sleep(self.delay_s)
        if self.on_predict is not None:
            detections, masks = self.on_predict(bgr, self.calls)
        else:
            detections, masks = self.detections, self.masks
        return copy.deepcopy(detections), (masks.copy() if hasattr(masks, "copy") else masks), \
            {"detectorPredictWallMs": 1.0, "detectorExtractionMs": 0.5}

    def warmup(self) -> dict:
        return {"purpose": "fake-startup-only"}


class FakeStereoBackend:
    name = "fake-stereo"

    def __init__(self, depth: Optional[np.ndarray] = None, valid: Optional[np.ndarray] = None, delay_s: float = 0.0) -> None:
        self.depth = depth
        self.valid = valid
        self.delay_s = delay_s
        self.calls = 0

    def estimate_bgr(self, left_bgr: np.ndarray, right_bgr: np.ndarray, calibration: dict) -> dict:
        self.calls += 1
        if self.delay_s:
            time.sleep(self.delay_s)
        height, width = left_bgr.shape[:2]
        depth = self.depth if self.depth is not None else np.full((height, width), 5.0, np.float32)
        valid = self.valid if self.valid is not None else np.ones((height, width), bool)
        return {"depth": depth, "valid": valid, "ms": 1.0, "detail": {}}


class ManualFrameProvider:
    """A fully deterministic, synchronous `FrameProvider` (see frames.py) test double: releases
    frames from a fixed list one at a time as `take_latest` is called — no pacing thread, no real
    wall-clock dependency, never skips. Used by tests that only care about NDJSON
    framing/schema/error-handling, not pacing itself, which a real `ReplayFrameProvider` cannot
    guarantee exact frame-by-frame coverage for under system load (a real, observed flake: see
    `docs/jev-live-sensor-results.md`, "Failures and repairs"). Each `acquired_ms` is still a
    distinct, increasing value (1000 * seq) so acquisition-ordering assertions remain meaningful."""
    def __init__(self, samples: list) -> None:
        self._samples = list(samples)
        self._index = 0

    def start(self) -> None:
        pass

    def take_latest(self, after_seq: int, timeout_s: Optional[float] = None) -> TakeResult:
        if self._index >= len(self._samples):
            return TakeResult(frame=None, skipped=0, exhausted=True)
        sample = self._samples[self._index]
        seq = self._index + 1
        self._index += 1
        frame = FrameRef(seq=seq, id=sample["id"], left_path=sample["leftPath"], right_path=sample["rightPath"],
                          calibration_path=sample["calibrationPath"], acquired_ms=float(seq) * 1000.0)
        return TakeResult(frame=frame, skipped=0, exhausted=False)

    def wake(self) -> None:
        pass

    def stop(self) -> None:
        pass

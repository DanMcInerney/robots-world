"""Per-frame pipeline: decode -> detect -> stereo -> mask-median surface range -> bearing.

This module owns only the wiring and per-stage timing; the algorithms themselves are reused
directly from the batch comparison: `geometry.py`'s `Geometry`/`mask_median` for camera rays,
bearing and the recommended mask-median range aggregation, and whatever `Detector`/`StereoBackend`
the caller supplies (see `../detector.py` and `stereo_backend.py`).

Real live data (see `docs/jev-live-sensor-results.md`, "Failures and repairs") showed the reused,
unmodified detector frequently returning 2-3 overlapping detections for one physical object under
different class labels (e.g. the same car as `car`, `truck` and `bus` in one frame, each above the
score threshold) — a real YOLO11s-seg multi-class ambiguity, not a bug in the detector this sensor
does not modify. Left alone, this floods any appearance-based consumer. `_merge_overlapping` fixes
it at the source, goal-agnostically: detections whose masks overlap heavily are the same physical
object, regardless of which class each one happened to be labelled; the highest-scoring label
becomes `class`, the rest are kept (not discarded — still real, honest detector output) as
`altClasses`.
"""
from __future__ import annotations

import json
import math
import sys
import time
from pathlib import Path
from typing import Optional

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # experiments/jev-library
from geometry import Geometry, mask_median  # noqa: E402

from .records import dominant_color_name

# Declared before inspecting any real data cluster: two detections whose masks overlap at or
# above this fraction (intersection / union) are treated as one physical object.
MERGE_IOU_THRESHOLD = 0.5


class FrameProcessingError(RuntimeError):
    """One frame failed to process (unreadable image/calibration, misaligned arrays, or any other
    unexpected failure while building this frame's objects). The caller skips just this frame and
    keeps the process alive; it is never allowed to crash the sensor."""


class FrameOutcome:
    __slots__ = ("objects", "objects_total", "timing_ms")

    def __init__(self, objects: list, objects_total: int, timing_ms: dict) -> None:
        self.objects = objects
        self.objects_total = objects_total
        self.timing_ms = timing_ms


_MAX_CACHED_GEOMETRIES = 8  # a single-camera run needs exactly one; bounded defensively against unexpected calibration churn


class SensorPipeline:
    def __init__(self, detector, stereo_backend, score_threshold: float, max_objects: int) -> None:
        self.detector = detector
        self.stereo_backend = stereo_backend
        self.score_threshold = score_threshold
        self.max_objects = max_objects
        self._geometries: dict[str, Geometry] = {}

    def _geometry_for(self, calibration: dict) -> Geometry:
        key = json.dumps(calibration, sort_keys=True)
        geometry = self._geometries.get(key)
        if geometry is None:
            if len(self._geometries) >= _MAX_CACHED_GEOMETRIES:
                del self._geometries[next(iter(self._geometries))]  # evict oldest (insertion-ordered dict)
            geometry = Geometry(calibration)
            self._geometries[key] = geometry
        return geometry

    def process(self, left_path: str, right_path: str, calibration_path: str) -> FrameOutcome:
        t_start = time.perf_counter()
        left = cv2.imread(left_path, cv2.IMREAD_COLOR)
        right = cv2.imread(right_path, cv2.IMREAD_COLOR)
        if left is None or right is None:
            raise FrameProcessingError(f"Could not decode stereo pair: {left_path} / {right_path}")
        if left.shape != right.shape:
            raise FrameProcessingError(f"Stereo pair shape mismatch: {left_path} / {right_path}")
        try:
            calibration = json.loads(Path(calibration_path).read_text(encoding="utf-8-sig"))
        except Exception as error:  # noqa: BLE001 - any calibration read/parse failure skips just this frame
            raise FrameProcessingError(f"Could not read calibration {calibration_path}: {error}") from error
        try:
            # Normalizes the raw calibration.json shape (e.g. `baseline_m`/`pixel_coordinates`) to
            # the {baselineM, pixelCenterOffset, doffsPx, ...} form `stereo_cached.CachedStereo`
            # and `mask_median` both expect — the same normalized dict every batch arm uses (see
            # `geometry.py`'s `_calibration`). Cached per unique calibration content, so this is a
            # one-time cost folded into `decode` below, not a per-frame one after the first frame.
            geometry = self._geometry_for(calibration)
        except Exception as error:  # noqa: BLE001
            raise FrameProcessingError(f"Invalid calibration: {error}") from error
        t_decoded = time.perf_counter()

        try:
            detections, masks, detector_timing = self.detector.predict(left)
        except Exception as error:  # noqa: BLE001
            raise FrameProcessingError(f"Detector failed: {error}") from error
        t_detected = time.perf_counter()

        try:
            stereo = self.stereo_backend.estimate_bgr(left, right, geometry.calibration)
        except Exception as error:  # noqa: BLE001
            raise FrameProcessingError(f"Stereo backend failed: {error}") from error
        t_stereo = time.perf_counter()

        try:
            height, width = left.shape[:2]
            eligible = [i for i, d in enumerate(detections) if float(d["confidence"]) >= self.score_threshold]
            groups = _merge_overlapping(eligible, masks, detections)
            objects = [
                _build_object(detections[primary], masks[primary],
                               [{"class": detections[i]["className"], "score": round(float(detections[i]["confidence"]), 4)} for i in others],
                               geometry, stereo, calibration, left, width, height, self.stereo_backend.name)
                for primary, others in groups
            ]
            objects.sort(key=lambda o: -o["score"])
            objects_total = len(objects)
            capped = objects[: self.max_objects]
        except FrameProcessingError:
            raise
        except Exception as error:  # noqa: BLE001 - a single frame's aggregation must never crash the process
            raise FrameProcessingError(f"Aggregation failed: {error}") from error
        t_aggregated = time.perf_counter()

        timing_ms = {
            "decode": (t_decoded - t_start) * 1000.0,
            "detect": (t_detected - t_decoded) * 1000.0,
            "stereo": (t_stereo - t_detected) * 1000.0,
            "aggregate": (t_aggregated - t_stereo) * 1000.0,
            "total": (t_aggregated - t_start) * 1000.0,
        }
        return FrameOutcome(objects=capped, objects_total=objects_total, timing_ms=timing_ms)


def _mask_iou(a: np.ndarray, b: np.ndarray) -> float:
    union = np.logical_or(a, b).sum()
    if union == 0:
        return 0.0
    return float(np.logical_and(a, b).sum()) / float(union)


def _merge_overlapping(eligible_indices: list, masks: np.ndarray, detections: list) -> list:
    """Groups score-eligible detection indices whose masks overlap at IoU >= MERGE_IOU_THRESHOLD
    into one cluster per physical object (union-find over a small O(n^2) IoU matrix — n is at
    most a handful of detections after score filtering). Returns one
    `(primary_index, [other indices, highest score first])` tuple per cluster — the primary is
    the highest-scoring detection in that cluster — in no particular order (the caller sorts the
    resulting objects by score)."""
    n = len(eligible_indices)
    parent = list(range(n))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(x: int, y: int) -> None:
        rx, ry = find(x), find(y)
        if rx != ry:
            parent[rx] = ry

    for i in range(n):
        for j in range(i + 1, n):
            if _mask_iou(masks[eligible_indices[i]], masks[eligible_indices[j]]) >= MERGE_IOU_THRESHOLD:
                union(i, j)

    clusters: dict[int, list] = {}
    for i in range(n):
        clusters.setdefault(find(i), []).append(eligible_indices[i])

    groups = []
    for members in clusters.values():
        members_sorted = sorted(members, key=lambda idx: -float(detections[idx]["confidence"]))
        groups.append((members_sorted[0], members_sorted[1:]))
    return groups


def _build_object(detection, mask, alt_classes: list, geometry: Geometry, stereo, calibration, left_bgr, width, height, stereo_backend_name) -> dict:
    box = detection["boxXyxy"]
    bearing = geometry.bearing(box, mask)
    range_summary = mask_median(stereo["depth"], stereo["valid"], box, mask, calibration, geometry)
    range_valid = range_summary["status"] == "measured"
    obj = {
        "class": detection["className"],
        "score": round(float(detection["confidence"]), 4),
        "bearingRightRad": round(math.radians(bearing["azimuthDeg"]), 6),
        "bearingUpRad": round(math.radians(bearing["elevationDeg"]), 6),
        "surfaceRangeM": round(float(range_summary["estimateM"]), 4) if range_valid else None,
        "rangeValid": range_valid,
        "rangeSource": f"stereo:{stereo_backend_name}+mask_median",
        "maskPixels": int(mask.sum()),
        "boxNorm": [
            round(_clip01(box[0] / width), 4), round(_clip01(box[1] / height), 4),
            round(_clip01(box[2] / width), 4), round(_clip01(box[3] / height), 4),
        ],
    }
    if not range_valid:
        obj["rangeReason"] = range_summary.get("unknownReason") or "unknown"
    color = dominant_color_name(left_bgr, mask, box)
    if color is not None:
        obj["dominantColor"] = color
    if alt_classes:
        obj["altClasses"] = alt_classes
    return obj


def _clip01(value: float) -> float:
    return 0.0 if value < 0.0 else 1.0 if value > 1.0 else value

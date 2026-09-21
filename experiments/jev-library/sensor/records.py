"""Record construction for the sensor's stdout schema (`stereo-objects/1`): the `hello`/`bye`
envelope records and each processed frame's compact, goal-agnostic object list, including the
object-count and line-size caps `main.py` must honor before ever writing to stdout.

Nothing here is goal-specific: there is no target selection, no `blueCarCandidate`-style field,
and every detected object above the declared score threshold is eligible (subject only to the cap
below). `dominant_color_name` is a cheap, generic colour attribute derived only from mask pixels —
the same computation for every class, not a goal-conditioned colour match.
"""
from __future__ import annotations

import json
from typing import Optional

import cv2
import numpy as np

SCHEMA = "stereo-objects/2"
# v2 changelog (repair pass, see docs/jev-live-sensor-results.md "Failures and repairs"):
#  - `acquired.ms`/`emittedMs` are now unix epoch milliseconds (clock "unix-epoch-ms"), derived
#    from a high-resolution monotonic delta (see clock.py) anchored once to real wall-clock time —
#    previously "sensor-wall" mislabelled a `time.monotonic()`-since-start value that was, on this
#    platform, quantized to 15.625 ms (GetTickCount64). A consumer can now compute an age directly
#    as `Date.now() - record.acquired.ms`, no hello lookup required.
#  - Cross-class duplicate detections of one physical object are merged before emission; the
#    non-primary classes are listed in each object's `altClasses` (see pipeline.py).
#  - A frame that fails to process is now represented on the wire as `valid:false` with `reason`
#    (empty `objects`), never silently skipped (see failed_frame_record below).
DEFAULT_MAX_LINE_BYTES = 4000  # "comfortably < 4 KiB"; a line that would still exceed this is shrunk, never emitted whole


def hello_record(*, source: str, manifest_path: str, frame_count: int, rate_hz: float,
                  calibration: dict, model: dict, stereo: dict, score_threshold: float,
                  max_objects: int, max_line_bytes: int, epoch_anchor_ms: float) -> dict:
    return {
        "schema": SCHEMA, "type": "hello", "source": source, "manifestPath": manifest_path,
        "frameCount": frame_count, "rateHz": rate_hz,
        "calibration": calibration, "model": model, "stereo": stereo,
        "thresholds": {"scoreThreshold": score_threshold, "maxObjects": max_objects, "maxLineBytes": max_line_bytes},
        "clock": {"clock": "unix-epoch-ms", "epochAnchorMs": epoch_anchor_ms,
                  "note": "acquired.ms/emittedMs on frame records are already unix epoch milliseconds "
                          "(high-resolution monotonic delta anchored once to wall-clock time at startup; "
                          "see clock.py). This anchor is retained for audit only; a consumer does not need "
                          "it to interpret acquired.ms/emittedMs."},
    }


def bye_record(*, processed: int, skipped_total: int, frame_errors: int, truncated_frames: int, reason: str,
                max_line_bytes_seen: Optional[int] = None) -> dict:
    record = {
        "schema": SCHEMA, "type": "bye", "processed": processed, "skippedTotal": skipped_total,
        "frameErrors": frame_errors, "truncatedFrames": truncated_frames, "reason": reason,
    }
    if max_line_bytes_seen is not None:
        record["maxLineBytesSeen"] = max_line_bytes_seen  # exact wire size of the largest line written (any record type) before this one
    return record


def frame_record(*, seq: int, acquired_ms: float, emitted_ms: float, skipped_since_last: int,
                  objects: list, objects_total: int, timing_ms: dict, max_objects: int,
                  max_line_bytes: int = DEFAULT_MAX_LINE_BYTES) -> tuple[dict, bool]:
    """Builds one frame record. `objects` is expected pre-sorted (highest score first) and is
    capped here to `max_objects`; the record is shrunk further, one lowest-scored object at a
    time, only if it would still exceed `max_line_bytes` (defensive — not expected in practice at
    8 compact objects). Returns `(record, truncated)`; `truncated` is also reported in the record
    itself (`objectsTruncated`) alongside the pre-cap `objectsTotal`, so a consumer can tell "8
    objects, nothing hidden" from "8 objects, N more were cut"."""
    ordered = list(objects)[:max_objects]
    truncated = objects_total > len(ordered)
    record = _assemble(seq, acquired_ms, emitted_ms, skipped_since_last, ordered, objects_total, timing_ms, truncated)
    while _size(record) > max_line_bytes and ordered:
        ordered = ordered[:-1]
        truncated = True
        record = _assemble(seq, acquired_ms, emitted_ms, skipped_since_last, ordered, objects_total, timing_ms, truncated)
    return record, truncated


def failed_frame_record(*, seq: int, acquired_ms: float, emitted_ms: float, skipped_since_last: int, reason: str) -> dict:
    """One frame that failed to process (e.g. a calibration/image mismatch): represented on the
    wire as an explicit, dated `valid:false` record with a `reason` — never silently dropped.
    Without this, a consumer only ever learns of the failure indirectly, much later, from
    ObservationStore's own receipt-staleness fallback (`stale_receipt`), with no reason and no
    acquisition time to reason about."""
    return {
        "schema": SCHEMA, "seq": seq, "acquired": {"clock": "unix-epoch-ms", "ms": acquired_ms},
        "emittedMs": emitted_ms, "skippedSinceLast": skipped_since_last,
        "objects": [], "objectsTotal": 0, "objectsTruncated": False, "timingMs": {},
        "valid": False, "reason": reason[:200],
    }


def _assemble(seq, acquired_ms, emitted_ms, skipped_since_last, objects, objects_total, timing_ms, truncated) -> dict:
    return {
        "schema": SCHEMA, "seq": seq, "acquired": {"clock": "unix-epoch-ms", "ms": acquired_ms},
        "emittedMs": emitted_ms, "skippedSinceLast": skipped_since_last,
        "objects": objects, "objectsTotal": objects_total, "objectsTruncated": truncated,
        "timingMs": timing_ms, "valid": True,
    }


def _size(record: dict) -> int:
    return len(json.dumps(record, allow_nan=False, separators=(",", ":")).encode("utf-8"))


# OpenCV hue is 0-179 (degrees/2); wraps at both ends to red. Buckets cover the full range;
# low saturation/value is handled separately, before these are consulted.
_HUE_BUCKETS = [
    (10, "red"), (25, "orange"), (35, "yellow"), (85, "green"), (100, "cyan"),
    (130, "blue"), (150, "purple"), (170, "magenta"), (180, "red"),
]


def dominant_color_name(bgr_image: np.ndarray, mask: np.ndarray, box) -> Optional[str]:
    """Cheap, generic per-object colour attribute from mask pixels (falls back to the detection
    box region if the mask is empty): mean HSV of the region -> a neutral name at low
    saturation/value, else the nearest named hue bucket. Identical computation for every class —
    contrast with the batch experiment's goal-specific `blueCarCandidate` HSV threshold."""
    region = mask.astype(bool)
    if region.any():
        pixels = bgr_image[region]
    else:
        x0, y0, x1, y1 = [max(0, int(round(v))) for v in box]
        x1, y1 = min(bgr_image.shape[1], x1), min(bgr_image.shape[0], y1)
        if x1 <= x0 or y1 <= y0:
            return None
        pixels = bgr_image[y0:y1, x0:x1].reshape(-1, 3)
    if pixels.size == 0:
        return None
    mean_bgr = pixels.mean(axis=0).astype(np.uint8).reshape(1, 1, 3)
    hue, sat, val = (int(c) for c in cv2.cvtColor(mean_bgr, cv2.COLOR_BGR2HSV)[0, 0])
    if val < 40:
        return "black"
    if sat < 40:
        return "white" if val > 200 else "gray"
    for upper, name in _HUE_BUCKETS:
        if hue < upper:
            return name
    return "red"

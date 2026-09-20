"""BoT-SORT association of supplied detections; no detector or ReID inference.

All output boxes and masks are the current detector measurements, not Kalman
predictions. Track IDs are association hypotheses, never evaluator identities.
Calling reset at each route boundary is required. The 30-frame buffer counts
updates, not wall time; input acquisition cadence must be recorded by callers.
"""
from __future__ import annotations

import logging
import threading
import time
from types import SimpleNamespace

import numpy as np

from detector import RUNTIME, ULTRALYTICS_VERSION, configure_runtime

SETTINGS = {"tracker_type": "botsort", "track_high_thresh": 0.25,
    "track_low_thresh": 0.1, "new_track_thresh": 0.25, "track_buffer": 30,
    "match_thresh": 0.8, "fuse_score": True, "gmc_method": "sparseOptFlow",
    "proximity_thresh": 0.5, "appearance_thresh": 0.8,
    "with_reid": False, "model": "auto"}
_ID_LOCK = threading.RLock()


class _Warnings(logging.Handler):
    def __init__(self):
        super().__init__(logging.WARNING)
        self.messages = []
        self.dropped = 0

    def emit(self, record):
        if len(self.messages) < 16:
            self.messages.append(record.getMessage())
        else:
            self.dropped += 1


class Tracker:
    def __init__(self, runtime_root=RUNTIME):
        configure_runtime(runtime_root)
        import ultralytics
        from ultralytics.engine.results import Boxes
        from ultralytics.trackers.basetrack import BaseTrack
        from ultralytics.trackers.bot_sort import BOTSORT
        from ultralytics.utils import LOGGER
        if ultralytics.__version__ != ULTRALYTICS_VERSION:
            raise RuntimeError("Tracker version differs from frozen Ultralytics")
        self._Boxes, self._BaseTrack, self._logger = Boxes, BaseTrack, LOGGER
        # The upstream ID counter is process-global. Save/restore it under a lock
        # so separate route adapters cannot reset or consume each other's IDs.
        with _ID_LOCK:
            other_count = BaseTrack._count
            try:
                self._tracker = BOTSORT(SimpleNamespace(**SETTINGS))
            finally:
                BaseTrack._count = other_count
        self._count = 0
        self.metadata = {"implementation": "ultralytics.trackers.bot_sort.BOTSORT",
            "ultralyticsVersion": ULTRALYTICS_VERSION, "settings": dict(SETTINGS),
            "additionalNeuralInference": False, "measuredBoxes": "unaltered input detections",
            "bufferUnits": "input frames", "maskAssociation": "original detection index",
            "lowConfidenceCaveat": "Input detections below cached detector cutoff are unavailable",
            "identityCaveat": "IDs are image association hypotheses; similar objects may swap"}

    def reset(self):
        with _ID_LOCK:
            other_count = self._BaseTrack._count
            try:
                self._tracker.reset()
                self._count = 0
            finally:
                self._BaseTrack._count = other_count

    def update(self, detections, masks, bgr):
        if masks.shape != (len(detections), *bgr.shape[:2]):
            raise ValueError("Each supplied detection requires an RGB-aligned mask")
        boxes = np.asarray([[*d["boxXyxy"], d["confidence"], d["classId"]]
                            for d in detections], dtype=np.float32).reshape(-1, 6)
        if not np.isfinite(boxes).all():
            raise ValueError("Nonfinite detector boxes/confidences are not admitted")
        warning_capture = _Warnings()
        started = time.perf_counter()
        with _ID_LOCK:
            other_count = self._BaseTrack._count
            self._BaseTrack._count = self._count
            self._logger.addHandler(warning_capture)
            try:
                associations = self._tracker.update(self._Boxes(boxes, bgr.shape[:2]), bgr)
                self._count = self._BaseTrack._count
            finally:
                self._logger.removeHandler(warning_capture)
                self._BaseTrack._count = other_count
        observed = [{**d, "trackId": None, "measured": True,
                     "identity": "fresh-detection-untracked"} for d in detections]
        seen = set()
        for row in associations:
            index, track_id = int(row[-1]), int(row[4])
            if index in seen or not 0 <= index < len(observed):
                raise RuntimeError("Tracker returned duplicate or invalid detection association")
            seen.add(index)
            observed[index].update(trackId=track_id, identity="tentative-temporal-association")
        current = [{"trackId": d["trackId"], "detectionId": d["detectionId"], "measured": True}
                   for d in observed if d["trackId"] is not None]
        metadata = {"frameIndex": self._tracker.frame_id, "currentAssociations": current,
            "lostTrackIds": sorted(int(t.track_id) for t in self._tracker.lost_stracks),
            "untrackedDetectionIds": [d["detectionId"] for d in observed if d["trackId"] is None],
            "predictedMeasurementsReturned": 0, "warnings": warning_capture.messages,
            "warningsTruncated": warning_capture.dropped,
            "trackerWallMs": (time.perf_counter()-started)*1000}
        return observed, masks, metadata


class TargetBinding:
    """Bind once to one visible blue-car track; never substitute another ID.

The caller supplies measured colour/class evidence. An ID switch inside BoT-SORT
can still fool this binding and must be scored independently against held-out
truth. No promise of real-world identity follows from a persistent number.
"""
    def __init__(self):
        self.reset()

    def reset(self):
        self.bound_track_id = None

    def update(self, detections):
        candidates = [d for d in detections if d.get("measured") is True and d.get("blueCarCandidate")]
        selected = None
        if self.bound_track_id is None:
            status = "ambiguous" if len(candidates) > 1 else "missing"
            if len(candidates) == 1:
                selected = candidates[0] if candidates[0].get("trackId") is not None else None
                status = "acquired" if selected is not None else "untracked"
                if selected is not None:
                    self.bound_track_id = selected["trackId"]
        else:
            matching = [d for d in candidates if d.get("trackId") == self.bound_track_id]
            if len(matching) > 1:
                raise ValueError("Duplicate current observations for a bound track")
            selected = matching[0] if matching else None
            status = "observed" if selected is not None else "lost"
        return {"status": status, "boundTrackId": self.bound_track_id,
            "selectedDetectionId": selected["detectionId"] if selected is not None else None,
            "candidateCount": len(candidates), "measured": selected is not None,
            "automaticSubstitution": False}

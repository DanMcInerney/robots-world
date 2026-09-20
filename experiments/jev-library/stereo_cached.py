"""Frozen Round 3 SGBM algorithm with reusable matchers and one pixel grid.

The last image shape replaces the grid cache; no frames or outputs are retained.
Instances are for serial use, matching the experiment's existing worker model.
"""
from __future__ import annotations

import importlib.util
import time
from pathlib import Path

import cv2
import numpy as np

MATCHING_PATH = Path(__file__).resolve().parents[1] / "jev-spatial-text/stereo/matching.py"
_spec = importlib.util.spec_from_file_location("jev_library_frozen_stereo_matching", MATCHING_PATH)
_matching = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_matching)
PARAMETERS = _matching.PARAMETERS


class CachedStereo:
    def __init__(self):
        self._matcher = None
        self._right_matcher = None
        self._shape = None
        self._grid = None
        self._right_min = -PARAMETERS["numDisparities"] + 1

    def estimate(self, left_gray, right_gray, calibration):
        if left_gray.shape != right_gray.shape or left_gray.ndim != 2:
            raise ValueError("Expected equal-sized rectified grayscale images")
        cv2.setNumThreads(PARAMETERS["threads"])
        start = time.perf_counter()
        if self._matcher is None:
            base_keys = ("minDisparity", "numDisparities", "blockSize", "P1", "P2", "disp12MaxDiff",
                         "preFilterCap", "uniquenessRatio", "speckleWindowSize", "speckleRange")
            settings = {key: PARAMETERS[key] for key in base_keys}
            settings["mode"] = cv2.STEREO_SGBM_MODE_SGBM_3WAY
            self._matcher = cv2.StereoSGBM_create(**settings)
            settings["minDisparity"] = self._right_min
            self._right_matcher = cv2.StereoSGBM_create(**settings)
        if self._shape != left_gray.shape:
            self._grid = np.indices(left_gray.shape)
            self._shape = left_gray.shape
        initialized = time.perf_counter()
        raw_left = self._matcher.compute(left_gray, right_gray)
        raw_right = self._right_matcher.compute(right_gray, left_gray)
        disparity, raw_valid = _matching.fixed_point_disparity(raw_left)
        right_disparity, right_valid = _matching.fixed_point_disparity(raw_right, self._right_min)
        yy, xx = self._grid
        right_x = np.rint(xx - disparity).astype(np.int32)
        inside = (right_x >= 0) & (right_x < left_gray.shape[1])
        safe_x = np.clip(right_x, 0, left_gray.shape[1] - 1)
        lr_error = np.abs(disparity + right_disparity[yy, safe_x])
        lr_ok = inside & right_valid[yy, safe_x] & (lr_error <= PARAMETERS["leftRightTolerancePx"])
        float_left = left_gray.astype(np.float32)
        size = PARAMETERS["textureWindow"]
        mean = cv2.boxFilter(float_left, -1, (size, size))
        variance = cv2.boxFilter(float_left**2, -1, (size, size)) - mean**2
        texture_std = np.sqrt(np.maximum(0, variance))
        texture_ok = texture_std >= PARAMETERS["textureStdMin"]
        depth = _matching.depth_from_disparity(disparity, calibration)
        range_ok = np.isfinite(depth) & (disparity < PARAMETERS["numDisparities"] - 2)
        masks = {"matcherInvalid": ~raw_valid, "leftRightInconsistent": ~lr_ok,
                 "lowTexture": ~texture_ok, "outOfRange": ~range_ok}
        valid = raw_valid & lr_ok & texture_ok & range_ok
        return {"rawLeft": raw_left, "rawRight": raw_right, "disparity": disparity,
                "rawValid": raw_valid & np.isfinite(depth), "valid": valid, "depth": depth,
                "leftRightErrorPx": lr_error, "textureStd": texture_std, "invalidMasks": masks,
                "initializationMs": (initialized - start)*1000,
                "estimateMs": (time.perf_counter() - initialized)*1000}

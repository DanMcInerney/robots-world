"""Image-only stereo estimation and conservative, goal-independent text facts.

This module has no evaluator imports and no access to renderer parameters/GT.
"""
from __future__ import annotations

import math
import time

import cv2
import numpy as np

PARAMETERS = {
    "minDisparity": 0, "numDisparities": 128, "blockSize": 5,
    "P1": 8 * 25, "P2": 32 * 25, "disp12MaxDiff": 1,
    "preFilterCap": 31, "uniquenessRatio": 10,
    "speckleWindowSize": 50, "speckleRange": 2,
    "mode": "SGBM_3WAY", "threads": 1,
    "leftRightTolerancePx": 1.0, "textureWindow": 9, "textureStdMin": 5.0,
    "sectorMinCoverage": 0.20, "clusterMinPixels": 12,
    "clusterDepthBinM": 0.10, "disparityHalfWidthPx": 0.5,
    "distanceBinsM": [1.5, 3.0], "sectors": 9,
}


def fixed_point_disparity(raw: np.ndarray, min_disparity=0):
    """Validity uses the pinned SGBM sentinel, not a universal raw-zero rule."""
    disparity = raw.astype(np.float32) / 16
    return disparity, raw > (min_disparity - 1) * 16


def depthai_quality_fixture(raw_depth_mm, raw_quality):
    """Fixture conversion only; no DepthAI device or SDK was executed."""
    depth = np.asarray(raw_depth_mm, dtype=np.float32) / 1000
    valid = np.isfinite(depth) & (depth > 0)
    quality = 1 - np.asarray(raw_quality, dtype=np.float32) / 255
    return np.where(valid, depth, np.nan), valid, quality


def depth_from_disparity(disparity, calibration):
    denominator = disparity + calibration["doffsPx"]
    output = np.full(disparity.shape, np.nan, np.float32)
    valid = np.isfinite(denominator) & (denominator > 0)
    output[valid] = calibration["fx"] * calibration["baselineM"] / denominator[valid]
    return output


def distance_bin(interval):
    if interval is None:
        return "unknown"
    low, high = interval
    if high < 1.5:
        return "near"
    if low >= 1.5 and high < 3:
        return "mid"
    if low >= 3:
        return "far"
    return "boundary"


def estimate(left, right, calibration):
    if left.shape != right.shape or left.ndim != 2:
        raise ValueError("Expected equal-sized rectified grayscale images")
    cv2.setNumThreads(PARAMETERS["threads"])
    start = time.perf_counter()
    base_keys = ("minDisparity", "numDisparities", "blockSize", "P1", "P2", "disp12MaxDiff",
                 "preFilterCap", "uniquenessRatio", "speckleWindowSize", "speckleRange")
    settings = {key: PARAMETERS[key] for key in base_keys}
    settings["mode"] = cv2.STEREO_SGBM_MODE_SGBM_3WAY
    matcher = cv2.StereoSGBM_create(**settings)
    right_min = -PARAMETERS["numDisparities"] + 1
    settings["minDisparity"] = right_min
    right_matcher = cv2.StereoSGBM_create(**settings)
    initialized = time.perf_counter()
    raw_left, raw_right = matcher.compute(left, right), right_matcher.compute(right, left)
    disparity, raw_valid = fixed_point_disparity(raw_left)
    right_disparity, right_valid = fixed_point_disparity(raw_right, right_min)
    yy, xx = np.indices(left.shape)
    right_x = np.rint(xx - disparity).astype(np.int32)
    inside = (right_x >= 0) & (right_x < left.shape[1])
    safe_x = np.clip(right_x, 0, left.shape[1]-1)
    lr_error = np.abs(disparity + right_disparity[yy, safe_x])
    lr_ok = inside & right_valid[yy, safe_x] & (lr_error <= PARAMETERS["leftRightTolerancePx"])
    float_left = left.astype(np.float32)
    size = PARAMETERS["textureWindow"]
    mean = cv2.boxFilter(float_left, -1, (size, size))
    variance = cv2.boxFilter(float_left**2, -1, (size, size)) - mean**2
    texture_std = np.sqrt(np.maximum(0, variance))
    texture_ok = texture_std >= PARAMETERS["textureStdMin"]
    depth = depth_from_disparity(disparity, calibration)
    range_ok = np.isfinite(depth) & (disparity < PARAMETERS["numDisparities"] - 2)
    masks = {"matcherInvalid": ~raw_valid, "leftRightInconsistent": ~lr_ok,
             "lowTexture": ~texture_ok, "outOfRange": ~range_ok}
    valid = raw_valid & lr_ok & texture_ok & range_ok
    return {"rawLeft": raw_left, "rawRight": raw_right, "disparity": disparity,
            "rawValid": raw_valid & np.isfinite(depth), "valid": valid, "depth": depth,
            "leftRightErrorPx": lr_error, "textureStd": texture_std, "invalidMasks": masks,
            "initializationMs": (initialized-start)*1000,
            "estimateMs": (time.perf_counter()-initialized)*1000}


def supported_nearest(depth, valid, calibration):
    """Nearest measured connected cluster, no object detector or truth mask."""
    if valid.sum() < PARAMETERS["clusterMinPixels"]:
        return None
    step = PARAMETERS["clusterDepthBinM"]
    depth_bins = np.full(depth.shape, -1, np.int32)
    depth_bins[valid] = np.floor(depth[valid]/step).astype(np.int32)
    # Merge adjacent depth bins so quantization edges do not split one surface.
    for index in sorted(np.unique(depth_bins[valid]).tolist()):
        candidate = valid & (depth_bins >= index) & (depth_bins <= index+1)
        count, labels, stats, _ = cv2.connectedComponentsWithStats(candidate.astype(np.uint8), 8)
        components = [label for label in range(1, count) if stats[label, cv2.CC_STAT_AREA] >= PARAMETERS["clusterMinPixels"]]
        if not components:
            continue
        selected = max(components, key=lambda label: int(stats[label, cv2.CC_STAT_AREA]))
        values = depth[labels == selected]
        low, high = map(float, np.quantile(values, [0.05, 0.95]))
        fb = calibration["fx"] * calibration["baselineM"]
        half = PARAMETERS["disparityHalfWidthPx"]
        interval = [fb / (fb/low + half), fb / (fb/high - half)] if fb/high > half else None
        return {"depthIntervalM": interval, "observedDepthQuantilesM": [low, high],
                "pixels": int(len(values)), "intervalMeaning": "5th-95th percentiles of this connected measured cluster, expanded by +/-0.5 disparity pixel; not a confidence interval",
                "positionPixels": [int(stats[selected, cv2.CC_STAT_LEFT]), int(stats[selected, cv2.CC_STAT_TOP]),
                                   int(stats[selected, cv2.CC_STAT_WIDTH]), int(stats[selected, cv2.CC_STAT_HEIGHT])]}
    return None


def make_regions(result, calibration):
    height, width = result["depth"].shape
    regions = []
    for index in range(PARAMETERS["sectors"]):
        x0, x1 = index*width//9, (index+1)*width//9
        valid = result["valid"][:, x0:x1]
        depth = result["depth"][:, x0:x1]
        coverage = float(valid.mean())
        nearest = supported_nearest(depth, valid, calibration)
        supported = coverage >= PARAMETERS["sectorMinCoverage"] and nearest is not None
        interval = nearest["depthIntervalM"] if supported else None
        if nearest:
            nearest["positionPixels"][0] += x0
        regions.append({"id": f"sector-{index}", "kind": "sector", "pixelBounds": [x0, 0, x1, height],
                        "bearingDeg": [math.degrees(math.atan((x-calibration["cx"])/calibration["fx"])) for x in (x0, x1)],
                        "depthIntervalM": interval, "depthBin": distance_bin(interval),
                        "validCoverage": coverage, "unknownFraction": 1-coverage,
                        "supportPixels": int(valid.sum()), "totalPixels": int(valid.size),
                        "observedDepthQuantilesM": list(map(float, np.quantile(depth[valid], [.05, .95]))) if valid.any() else None,
                        "nearestSupportedCluster": nearest,
                        "invalidReasons": {name: int(mask[:, x0:x1].sum()) for name, mask in result["invalidMasks"].items()},
                        "invalidReasonCountsOverlap": True, "clearance": "unknown",
                        "wholeSectorClearCertified": False,
                        "supportStatus": "measured-patch" if supported else "insufficient-support"})
    return regions

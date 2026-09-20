"""Image/calibration-only matching. All arms share the old support/aggregation rules."""
from __future__ import annotations
import time
import cv2
import numpy as np
import baseline_matching as baseline

PARAMETERS = {
    "sgbm5": dict(baseline.PARAMETERS),
    "sgbm3": dict(baseline.PARAMETERS, blockSize=3, P1=72, P2=288),
    "bm9": dict(baseline.PARAMETERS, blockSize=9, P1=None, P2=None, mode="BM",
                preFilterType="XSOBEL", preFilterSize=9, textureThreshold=0, smallerBlockSize=0),
}


def matcher(arm, minimum):
    p = PARAMETERS[arm]
    if arm != "bm9":
        keys = ("numDisparities", "blockSize", "P1", "P2", "disp12MaxDiff", "preFilterCap",
                "uniquenessRatio", "speckleWindowSize", "speckleRange")
        return cv2.StereoSGBM_create(minDisparity=minimum,
            mode=cv2.STEREO_SGBM_MODE_SGBM_3WAY, **{key: p[key] for key in keys})
    result = cv2.StereoBM_create(numDisparities=p["numDisparities"], blockSize=p["blockSize"])
    result.setMinDisparity(minimum)
    result.setPreFilterType(cv2.STEREO_BM_PREFILTER_XSOBEL)
    result.setPreFilterSize(p["preFilterSize"])
    result.setPreFilterCap(p["preFilterCap"])
    result.setTextureThreshold(p["textureThreshold"])
    result.setUniquenessRatio(p["uniquenessRatio"])
    result.setSpeckleWindowSize(p["speckleWindowSize"])
    result.setSpeckleRange(p["speckleRange"])
    result.setDisp12MaxDiff(p["disp12MaxDiff"])
    result.setSmallerBlockSize(p["smallerBlockSize"])
    return result


def estimate(arm, left, right, calibration):
    if left.shape != right.shape or left.ndim != 2:
        raise ValueError("Equal rectified grayscale images required")
    cv2.setNumThreads(1)
    p = PARAMETERS[arm]
    start = time.perf_counter()
    right_min = -p["numDisparities"] + 1
    lm, rm = matcher(arm, 0), matcher(arm, right_min)
    initialized = time.perf_counter()
    raw_left, raw_right = lm.compute(left, right), rm.compute(right, left)
    disparity, raw_valid = baseline.fixed_point_disparity(raw_left)
    right_disparity, right_valid = baseline.fixed_point_disparity(raw_right, right_min)
    yy, xx = np.indices(left.shape)
    right_x = np.rint(xx - disparity).astype(np.int32)
    inside = (right_x >= 0) & (right_x < left.shape[1])
    safe_x = np.clip(right_x, 0, left.shape[1] - 1)
    lr_error = np.abs(disparity + right_disparity[yy, safe_x])
    lr_ok = inside & right_valid[yy, safe_x] & (lr_error <= p["leftRightTolerancePx"])
    float_left = left.astype(np.float32)
    size = p["textureWindow"]
    mean = cv2.boxFilter(float_left, -1, (size, size))
    variance = cv2.boxFilter(float_left**2, -1, (size, size)) - mean**2
    texture_std = np.sqrt(np.maximum(0, variance))
    texture_ok = texture_std >= p["textureStdMin"]
    depth = baseline.depth_from_disparity(disparity, calibration)
    range_ok = np.isfinite(depth) & (disparity < p["numDisparities"] - 2)
    masks = dict(matcherInvalid=~raw_valid, leftRightInconsistent=~lr_ok,
                 lowTexture=~texture_ok, outOfRange=~range_ok)
    valid = raw_valid & lr_ok & texture_ok & range_ok
    return dict(rawLeft=raw_left, rawRight=raw_right, disparity=disparity,
                rawValid=raw_valid & np.isfinite(depth), valid=valid, depth=depth,
                leftRightErrorPx=lr_error, textureStd=texture_std, invalidMasks=masks,
                initializationMs=(initialized-start)*1000,
                estimateMs=(time.perf_counter()-initialized)*1000)


def make_regions(result, calibration):
    return baseline.make_regions(result, calibration)

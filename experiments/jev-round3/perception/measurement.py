"""Round 3 image/calibration-only association; no simulator or evaluator imports."""
from __future__ import annotations

import math

import cv2
import numpy as np

PARAMETERS = {
    "minValidPixels": 12, "minValidCoverage": 0.10,
    "clusterRangeBinM": 0.5, "clusterAdjacentBins": 2,
    "clusterMinPixels": 12, "clusterMinMaskFraction": 0.02,
    "blueHueOpenCv": [95, 135], "blueMinSaturation": 70, "blueMinValue": 35,
    "blueMinPixels": 12, "blueMinMaskFraction": 0.08,
}


def calibration_from_json(raw, shape):
    """Copy only declared camera intrinsics; never pass arbitrary input metadata."""
    height, width = shape
    keys = ("width", "height", "fx", "fy", "cx", "cy")
    cal = {key: raw[key] for key in keys}
    cal["baselineM"] = raw.get("baselineM", raw.get("baseline_m"))
    cal["doffsPx"] = raw.get("doffsPx", 0)
    convention = raw.get("pixel_coordinates", "u=column,v=row; top-left origin")
    if convention == "u=column+0.5,v=row+0.5; top-left origin":
        cal["pixelCenterOffset"] = 0.5
    elif convention == "u=column,v=row; top-left origin":
        cal["pixelCenterOffset"] = 0.0
    else:
        raise ValueError("Unsupported pixel coordinate convention")
    if raw.get("rectified", True) is not True or any(raw.get("distortion", [0])):
        raise ValueError("SGBM requires rectified, distortion-free RGB")
    if any(isinstance(value, bool) or not isinstance(value, (int, float))
           or not math.isfinite(value) for value in cal.values()):
        raise ValueError("Calibration fields must be finite numbers")
    if (cal["height"], cal["width"]) != (height, width):
        raise ValueError("Calibration and image dimensions differ")
    if min(cal["fx"], cal["fy"], cal["baselineM"]) <= 0:
        raise ValueError("Focal lengths and stereo baseline must be positive")
    if not 0 <= cal["cx"] <= width or not 0 <= cal["cy"] <= height:
        raise ValueError("Principal point must be within the image")
    return cal


def radial_ranges(axial_depth, calibration):
    """Pinhole Euclidean range with explicitly declared pixel centre convention."""
    yy, xx = np.indices(axial_depth.shape, dtype=np.float64)
    xx += calibration.get("pixelCenterOffset", 0)
    yy += calibration.get("pixelCenterOffset", 0)
    multiplier = np.sqrt(1 + ((xx-calibration["cx"])/calibration["fx"])**2
                         + ((yy-calibration["cy"])/calibration["fy"])**2)
    return axial_depth * multiplier


def box_region(box, shape):
    height, width = shape
    if len(box) != 4 or not all(math.isfinite(float(value)) for value in box):
        raise ValueError("Detection box must contain four finite pixel coordinates")
    x0, y0 = max(0, math.floor(box[0])), max(0, math.floor(box[1]))
    x1, y1 = min(width, math.ceil(box[2])), min(height, math.ceil(box[3]))
    region = np.zeros(shape, dtype=bool)
    if x1 > x0 and y1 > y0:
        region[y0:y1, x0:x1] = True
    return region


def color_evidence(bgr, mask):
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    blue = mask & (hsv[:, :, 0] >= PARAMETERS["blueHueOpenCv"][0]) \
        & (hsv[:, :, 0] <= PARAMETERS["blueHueOpenCv"][1]) \
        & (hsv[:, :, 1] >= PARAMETERS["blueMinSaturation"]) \
        & (hsv[:, :, 2] >= PARAMETERS["blueMinValue"])
    count, total = int(blue.sum()), int(mask.sum())
    fraction = count / total if total else 0
    return {"bluePixels": count, "maskPixels": total, "blueFraction": fraction,
            "blueSupported": count >= PARAMETERS["blueMinPixels"]
            and fraction >= PARAMETERS["blueMinMaskFraction"],
            "source": "HSV threshold on original RGB pixels inside predicted mask"}


def bearing(box, mask, calibration):
    yy, xx = np.nonzero(mask)
    offset = calibration.get("pixelCenterOffset", 0)
    x, y = (float(np.mean(xx))+offset, float(np.mean(yy))+offset) if xx.size else \
        ((box[0]+box[2])/2, (box[1]+box[3])/2)
    nx, ny = (x-calibration["cx"])/calibration["fx"], (y-calibration["cy"])/calibration["fy"]
    return {"azimuthDeg": math.degrees(math.atan(nx)),
            "elevationDeg": math.degrees(math.atan2(-ny, math.sqrt(1+nx*nx))),
            "pixel": [x, y], "source": "predicted-mask centroid" if xx.size else "box midpoint",
            "convention": "camera-relative; azimuth positive right, elevation positive up"}


def nearest_supported_cluster(ranges, valid, region):
    eligible = valid & region & np.isfinite(ranges) & (ranges > 0)
    minimum = max(PARAMETERS["clusterMinPixels"],
                  math.ceil(PARAMETERS["clusterMinMaskFraction"] * int(region.sum())))
    if int(eligible.sum()) < minimum:
        return np.zeros(region.shape, bool), None
    bins = np.full(region.shape, -1, dtype=np.int64)
    bins[eligible] = np.floor(ranges[eligible] / PARAMETERS["clusterRangeBinM"]).astype(np.int64)
    # Ascending range bands; ties choose largest connected patch, then label order.
    # This is a measured foreground heuristic, not proof of target identity.
    for index in np.unique(bins[eligible]):
        band = eligible & (bins >= index) & (bins < index + PARAMETERS["clusterAdjacentBins"])
        count, labels, stats, _ = cv2.connectedComponentsWithStats(band.astype(np.uint8), 8)
        candidates = [label for label in range(1, count)
                      if int(stats[label, cv2.CC_STAT_AREA]) >= minimum]
        if candidates:
            label = max(candidates, key=lambda item: int(stats[item, cv2.CC_STAT_AREA]))
            return labels == label, {"rangeBandM": [float(index)*PARAMETERS["clusterRangeBinM"],
                float(index+PARAMETERS["clusterAdjacentBins"])*PARAMETERS["clusterRangeBinM"]],
                "minimumRequiredPixels": minimum,
                "selection": "nearest two-bin radial-range band with a sufficiently large 8-connected component"}
    return np.zeros(region.shape, bool), None


def summarize(ranges, valid, region, selected=None, cluster=None):
    eligible = valid & region & np.isfinite(ranges) & (ranges > 0)
    region_pixels, valid_pixels = int(region.sum()), int(eligible.sum())
    coverage = valid_pixels / region_pixels if region_pixels else 0
    chosen = eligible if selected is None else eligible & selected
    count = int(chosen.sum())
    reason = "empty-region" if not region_pixels else \
        "insufficient-valid-pixels" if valid_pixels < PARAMETERS["minValidPixels"] else \
        "insufficient-valid-coverage" if coverage < PARAMETERS["minValidCoverage"] else \
        "no-supported-foreground-cluster" if count < PARAMETERS["minValidPixels"] else None
    values = ranges[chosen]
    supported = reason is None
    quantiles = list(map(float, np.quantile(values, [0.05, 0.10, 0.50, 0.95]))) if count else None
    return {"status": "measured" if supported else "unknown", "unknownReason": reason,
        "estimateM": quantiles[2] if supported else None,
        "robustNearestProxyM": quantiles[1] if supported else None,
        "minimumMeasuredRangeM": float(values.min()) if supported else None,
        "descriptiveSpreadM": [quantiles[0], quantiles[3]] if supported else None,
        "diagnosticSelectedQuantilesM": quantiles,
        "regionPixels": region_pixels, "validPixels": valid_pixels, "supportPixels": count,
        "validCoverage": coverage, "selectedFraction": count/region_pixels if region_pixels else 0,
        "cluster": cluster,
        "aggregationDefinition": "median Euclidean camera-to-surface range over selected measured pixels",
        "nearestProxyDefinition": "10th percentile of selected measured radial ranges, not exact nearest surface",
        "spreadMeaning": "descriptive p05-p95 of selected pixels; not calibrated uncertainty",
        "clearance": "unknown"}


def compare_arms(axial_depth, valid, box, mask, calibration):
    if mask.shape != axial_depth.shape or valid.shape != axial_depth.shape:
        raise ValueError("Depth, validity, and segmentation masks must align")
    ranges = radial_ranges(axial_depth, calibration)
    bbox = box_region(box, ranges.shape)
    mask = mask.astype(bool) & bbox
    selected, cluster = nearest_supported_cluster(ranges, valid, mask)
    return {"bboxMedian": summarize(ranges, valid, bbox),
            "maskForegroundCluster": summarize(ranges, valid, mask, selected, cluster)}, selected

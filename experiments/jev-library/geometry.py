"""Cached OpenCV camera rays and a plain predicted-mask median.

Only camera calibration and acquired image measurements are inputs. The Round 3
summary helper remains the owner of support thresholds and unknown states.
"""
from __future__ import annotations

import importlib.util
import math
from pathlib import Path

import cv2
import numpy as np

MEASUREMENT_PATH = Path(__file__).resolve().parents[1] / "jev-round3/perception/measurement.py"
_spec = importlib.util.spec_from_file_location("jev_library_round3_measurement", MEASUREMENT_PATH)
_measurement = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_measurement)


def _calibration(calibration):
    """Accept raw or Round 3-normalized calibration without losing its offset."""
    raw = dict(calibration)
    if "pixelCenterOffset" in raw:
        offset = raw["pixelCenterOffset"]
        if isinstance(offset, bool) or offset not in (0, 0.5):
            raise ValueError("Unsupported pixel centre offset")
        convention = ("u=column+0.5,v=row+0.5; top-left origin" if offset else
                      "u=column,v=row; top-left origin")
        if raw.get("pixel_coordinates", convention) != convention:
            raise ValueError("Conflicting pixel coordinate conventions")
        raw["pixel_coordinates"] = convention
    shape = (raw["height"], raw["width"])
    if any(isinstance(value, bool) or not isinstance(value, (int, float))
           or not math.isfinite(value) or value <= 0 or int(value) != value for value in shape):
        raise ValueError("Image dimensions must be positive integers")
    return _measurement.calibration_from_json(raw, shape)


class Geometry:
    """One immutable-by-convention calibration and its reusable camera rays."""

    def __init__(self, calibration):
        self.calibration = _calibration(calibration)
        cal = self.calibration
        self.shape = (int(cal["height"]), int(cal["width"]))
        self._camera_matrix = np.array([[cal["fx"], 0, cal["cx"]],
                                        [0, cal["fy"], cal["cy"]],
                                        [0, 0, 1]], dtype=np.float64)
        yy, xx = np.indices(self.shape, dtype=np.float64)
        pixels = np.stack((xx, yy), axis=-1) + cal["pixelCenterOffset"]
        self._rays = cv2.undistortPoints(pixels.reshape(-1, 1, 2), self._camera_matrix,
                                       None).reshape(*self.shape, 2)
        # Preserve Round 3's operation order as well as its camera convention.
        self._range_scale = np.sqrt(1 + self._rays[..., 0]**2 + self._rays[..., 1]**2)

    def radial_ranges(self, axial_depth):
        if axial_depth.shape != self.shape:
            raise ValueError("Depth and calibration dimensions differ")
        return axial_depth * self._range_scale

    def bearing(self, box, mask):
        if mask.shape != self.shape:
            raise ValueError("Segmentation mask and calibration dimensions differ")
        if len(box) != 4 or not all(math.isfinite(float(value)) for value in box):
            raise ValueError("Detection box must contain four finite pixel coordinates")
        yy, xx = np.nonzero(mask)
        offset = self.calibration["pixelCenterOffset"]
        x, y = (float(np.mean(xx)) + offset, float(np.mean(yy)) + offset) if xx.size else \
            ((box[0] + box[2])/2, (box[1] + box[3])/2)
        # For rectified rays the centroid projects linearly. Project this one
        # point so the result uses exactly the reported centroid, including an
        # empty mask's unshifted box midpoint.
        nx, ny = cv2.undistortPoints(np.array([[[x, y]]], dtype=np.float64),
                                     self._camera_matrix, None)[0, 0]
        return {"azimuthDeg": math.degrees(math.atan(nx)),
                "elevationDeg": math.degrees(math.atan2(-ny, math.sqrt(1 + nx*nx))),
                "pixel": [x, y], "source": "predicted-mask centroid" if xx.size else "box midpoint",
                "convention": "camera-relative; azimuth positive right, elevation positive up"}


def mask_median(depth, valid, box, mask, calibration, geometry=None):
    """Median all valid radial ranges in predicted mask intersected with bbox."""
    if mask.shape != depth.shape or valid.shape != depth.shape:
        raise ValueError("Depth, validity, and segmentation masks must align")
    if geometry is None:
        geometry = Geometry(calibration)
    elif geometry.calibration != _calibration(calibration):
        raise ValueError("Cached geometry and supplied calibration differ")
    ranges = geometry.radial_ranges(depth)
    region = mask.astype(bool) & _measurement.box_region(box, depth.shape)
    return _measurement.summarize(ranges, valid, region)

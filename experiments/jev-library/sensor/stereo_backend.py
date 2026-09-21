"""Pluggable stereo backends behind one uniform interface: a BGR stereo pair plus calibration in,
`{depth, valid, ms, detail}` out. Nothing here re-implements stereo matching — both backends
delegate to the batch comparison's own modules.

`SgbmBackend` wraps `stereo_cached.CachedStereo` (the default; matches the library comparison's
measured recommendation — see `../README.md` and `docs/jev-library-comparison-results.md`).

`FfsBackend` wraps `learned_stereo.FastStereo` (Fast-FoundationStereo) and is a real, working
class, not a stub — but constructing it inside this sensor's own process (the pinned *detector*
venv, so YOLO detection can run in the same process) is expected to fail today. See its docstring
for the concrete, verified reason; `docs/jev-live-sensor-results.md` records the exact failure.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Protocol

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # experiments/jev-library (no hyphen; a plain sibling import)
from stereo_cached import CachedStereo  # noqa: E402


class StereoBackend(Protocol):
    name: str

    def estimate_bgr(self, left_bgr: np.ndarray, right_bgr: np.ndarray, calibration: dict) -> dict: ...


class SgbmBackend:
    """Default: the frozen OpenCV SGBM matcher, reused verbatim (same class, same parameters) from
    the batch comparison's `mask_median`/`yolo11_current` arms. One persistent `CachedStereo`
    instance is kept for the process lifetime so its matcher/pixel-grid caching (see
    `stereo_cached.py`) actually helps across frames, matching the batch benchmark's usage."""
    name = "sgbm"

    def __init__(self) -> None:
        self._stereo = CachedStereo()

    def estimate_bgr(self, left_bgr: np.ndarray, right_bgr: np.ndarray, calibration: dict) -> dict:
        left_gray = cv2.cvtColor(left_bgr, cv2.COLOR_BGR2GRAY)
        right_gray = cv2.cvtColor(right_bgr, cv2.COLOR_BGR2GRAY)
        result = self._stereo.estimate(left_gray, right_gray, calibration)
        return {
            "depth": result["depth"], "valid": result["valid"],
            "ms": result["initializationMs"] + result["estimateMs"],
            "detail": {"initializationMs": result["initializationMs"], "estimateMs": result["estimateMs"]},
        }


class FfsBackend:
    """Optional: Fast-FoundationStereo, reused verbatim from `learned_stereo.FastStereo`.

    Known, declared gap: constructing this backend imports `learned_stereo`, which in turn (once a
    model is actually built) imports the official FFS repository's own modules — its backbone
    needs `timm`, `einops` and `omegaconf` at minimum. Those packages are NOT installed in the
    pinned *detector* venv this sensor's detection stage needs to run in (empirically verified
    absent: `timm`, `einops`, `omegaconf`, `scikit-image`, `imageio`, `open3d`); conversely
    `ultralytics` is not installed in the pinned FFS venv. The two pinned, read-only venvs cannot
    run one live detect+stereo process together, and installing packages into either is out of
    scope for this pass (`AGENTS.md`/assignment: do not pip-install into these environments).

    `--stereo ffs` therefore attempts this construction for real and fails fast with the
    interpreter's own `ModuleNotFoundError` surfaced through `main.py`'s ordinary startup-failure
    path (clear stderr message, non-zero exit) instead of silently falling back to SGBM. The
    concrete next step for a live FFS sensor is a two-process bridge: a detector-venv process
    performs decode+detect+bearing and pipes each mask/box over stdio to a second, FFS-venv
    process that computes depth for just that region and pipes the range back — out of scope here.
    """
    name = "ffs"

    def __init__(self, runtime_root) -> None:
        from learned_stereo import FastStereo  # imports the FFS repo tree; see class docstring for why this fails today in this venv
        self._model = FastStereo(runtime_root)

    def estimate_bgr(self, left_bgr: np.ndarray, right_bgr: np.ndarray, calibration: dict) -> dict:
        start = time.perf_counter()
        result = self._model.estimate(left_bgr, right_bgr, calibration)
        elapsed_ms = (time.perf_counter() - start) * 1000.0
        return {
            "depth": result["depth"], "valid": result["valid"],
            "ms": result["timing"].get("estimateMs", elapsed_ms), "detail": result["timing"],
        }

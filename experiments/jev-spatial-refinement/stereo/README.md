# Thin-obstacle matcher refinement

This offline experiment follows F45. It compares the historical SGBM5 pipeline,
SGBM3 with correspondingly scaled smoothness penalties, and StereoBM9 on the same
56 fresh image pairs. It never changes the historical source or uses API/hardware.

Use the existing Python runtime from the repository root:

```powershell
.runtime/vision-env/Scripts/python.exe experiments/jev-spatial-refinement/stereo/test_contract.py
.runtime/vision-env/Scripts/python.exe experiments/jev-spatial-refinement/stereo/run.py
.runtime/vision-env/Scripts/python.exe experiments/jev-spatial-refinement/stereo/audit.py
```

Execution refuses an existing nonempty output directory. Sources, all planned
cases and the exploratory usefulness/hazard gate freeze before any development
or confirmation evaluation. No tuning step exists. The baseline copy is pinned
by SHA-256 to `experiments/jev-spatial-text/stereo/matching.py`; the original
remains unchanged. Tests establish exact old/new SGBM5 numerical parity.

The estimator accepts grayscale images and calibration only. Renderer geometry,
truth masks, case names and evaluator scores never enter matching/support/text
aggregation. Every pixel with any rendered near-hazard subpixel is counted,
including mixed boundary pixels. Only metric depth error excludes mixed optical
footprints because they have no unique scalar reference depth. Unknown, retained
wrong, raw wrong, and correct-near coverage are reported separately. There are
no whole-sector-clear assertions.

These are correlated synthetic factorial challenges, not independent real
environments. OpenCV BM is an alternative matcher in the same library, not a
separate production stereo/VIO stack. The gate is exploratory, not flight
qualification, and a run may correctly produce no winner.

"""Read-only post-run diagnostics and report; no parameter search or tuning."""
import argparse
import json
from pathlib import Path

import numpy as np

from assets import sha, write_json


def analyze(root):
    summary = json.loads((root/"summary.json").read_text())
    scenes = json.loads((root/"scene-manifest-evaluator-only.json").read_text())
    records = json.loads((root/"sensor-records.json").read_text())["records"]
    mapping = json.loads((root/"exports/id-mapping-evaluator-only.json").read_text())
    grades = json.loads((root/"exports/grades.json").read_text())["records"]
    rows, acquisition_metadata = [], []
    for scene in scenes:
        record = next(x for x in records if x["id"] == scene["id"])
        with np.load(Path(scene["inputDirectory"])/"evaluator-only.npz") as gt:
            truth, truth_valid = gt["depth"], gt["valid"]
        with np.load(root/"results"/scene["id"]/"estimated.npz") as estimates:
            retained = estimates["valid"] & truth_valid
            disparity = estimates["disparity"]
        calibration = record["calibration"]
        fb = calibration["fx"] * calibration["baselineM"]
        denominator = disparity + calibration["doffsPx"]
        valid_band = retained & (denominator > .5)
        lower = np.full(truth.shape, np.nan)
        upper = np.full(truth.shape, np.nan)
        lower[valid_band] = fb/(denominator[valid_band]+.5)
        upper[valid_band] = fb/(denominator[valid_band]-.5)
        contains = valid_band & (lower <= truth) & (truth <= upper)
        row = {"sceneId": scene["id"], "recordId": mapping[scene["id"]], "split": scene["split"],
               "retainedReferencePixels": int(retained.sum()), "pixelsWithFiniteHalfPixelBand": int(valid_band.sum()),
               "referenceInsideHalfPixelBand": int(contains.sum()),
               "referenceInsideBandFractionOfRetained": float(contains.sum()/retained.sum()) if retained.any() else None,
               "meaning": "diagnostic empirical support of +/-0.5px disparity band, not confidence calibration or gate tuning"}
        rows.append(row)
        times = scene["metadata"].get("syntheticAcquisitionTimeMs")
        acquisition_metadata.append({"recordId": mapping[scene["id"]], "clock": "synthetic per-pair local clock" if times else "original capture clock unavailable",
                                     "leftAcquiredAtMs": times[0] if times else None, "rightAcquiredAtMs": times[1] if times else None,
                                     "pairSkewMs": times[1]-times[0] if times else None,
                                     "originalCaptureTimeKnown": bool(times), "theseArePhysicalMeasurementTimestamps": False,
                                     "runtimeAgeAvailable": False})
    write_json(root/"interval-diagnostics.json", {"sourceSha256": sha(Path(__file__)), "records": rows})
    write_json(root/"exports/acquisition-metadata.json", {"records": acquisition_metadata,
              "meaning": "sensor acquisition provenance; optional supplement to immutable exported records. Synthetic pair clocks only, no evaluator geometry."})
    heldout = [x for x in summary["results"] if x["split"] == "evaluation"]
    all_latency = [v for x in summary["results"] for v in x["latencyMs"]["samePairReplay"]]
    text = ["# Stereo execution report — 19 September 2026", "",
            "**The challenge sensing gate failed.** Static textured synthetic boards produced useful depth at the three sampled distances; nearby thin poles and asynchronous views produced materially wrong depth. This result supports text-interpretation experiments on the recorded estimates, including their failures. It does not support a moving-drone sensing envelope, full-sector clearance, obstacle avoidance, or persistent metric mapping.", "",
            "40 image pairs were processed: four development and 36 evaluation, yielding 360 region records. Three public Middlebury 2014 scenes supply real calibrated imagery; one exposure variant repeats Motorcycle's scene and is not a fourth independent scene. The remaining 36 pairs are procedural synthetic renders, with related variants grouped by scene family. Pixels, sectors and timing replays are not independent environmental trials.", "",
            "## Frozen method and source boundary", "",
            "The matcher uses rectified grayscale images plus calibration only: OpenCV 5.0.0 SGBM, 128 disparities, block size 5, independent right matcher, 1px left/right consistency, 9px local texture standard deviation at least 5, and fixed connected cluster/coverage rules. Python 3.14.6 and NumPy 2.5.3 were already installed. No dependency was changed. Four numerical source files and all settings were snapshotted before the first matching/evaluation pass. Development ran first; no tuning occurred before evaluation.", "",
            "The source is [Middlebury 2014](https://vision.middlebury.edu/stereo/data/scenes2014/), using perfect-calibration Adirondack (development), Motorcycle and Pipes (evaluation). The [official archives](https://vision.middlebury.edu/stereo/data/scenes2014/zip/) supplied 102,074,243 transferred bytes through explicit byte-range requests, below the 200 MB cap. Individual PNG/PFM downloads returned HTTP 403; this preparation failure was resolved using the site's publicly linked archives. Every fetched range and extracted input has a SHA256 record. Camera principal-point offset and millimetre baseline conversion were applied; resized GT uses nearest neighbors and original validity.", "",
            "Every estimate, original validity mask, retained support mask and image is saved. GT only grades the frozen output. No GT mask fills, corrects or rejects a sensor estimate. Quantile/half-disparity intervals are descriptive algorithmic bands, not confidence intervals. Current returns never certify a whole sector clear.", "",
            "## Main observations", "",
            "| Case | Retained GT-pixel coverage | p95 axial absolute error | Within tolerance among retained |", "|---|---:|---:|---:|"]
    for item in summary["results"]:
        if "middlebury" in item["sceneId"] or "skew-" in item["sceneId"] or "blank" in item["sceneId"] or "vertical-misalignment" in item["sceneId"]:
            m = item["retained"]
            err = "unknown" if m["p95AbsoluteErrorM"] is None else f"{m['p95AbsoluteErrorM']:.3f} m"
            within = "none" if m["withinToleranceAmongRetained"] is None else f"{100*m['withinToleranceAmongRetained']:.1f}%"
            text.append(f"| {item['sceneId']} | {100*m['validCoverage']:.1f}% | {err} | {within} |")
    text += ["", "Tolerance is max(5 cm, 5% reference depth). Every denominator is also retained in machine-readable metrics, including raw SGBM output, unknown pixels and boundary/interior masks.", "",
             "The six held-out synthetic textured boards at 1/2/4 m retain 61.1–63.9% coverage, with zero p95 error and no near-to-far pixels. These frontal planes have exact integer disparities under an ideal pinhole renderer. That favorable, narrow result is not proof of accuracy between the sampled ranges or on real surfaces. Other synthetic cases include noninteger disparities. The half-resolution 320px-wide case retains only 21.3% coverage because the frozen search range consumes much of the image.", "",
             "Of 324 evaluation sectors, 193 emit an unambiguous depth bin and 12 disagree with the independent nearest-reference bin. Five are near-to-far errors: both one-pixel poles, both two-pixel poles, and the centered four-pixel pole. Across evaluation images, 5,080 retained pixels with a reference depth below 1.5 m are assigned at least 3 m. False-far pixels also occur around wider poles even when the nearest-sector statement correctly detects a near patch. Thus a good sector answer can still conceal dangerous local leakage. The 50 ms skew fixture moves a 2 m object horizontally at 1 m/s between views and reaches 10 m p95 depth error; LR consistency cannot reliably detect this physically inconsistent stereo pair.", "",
             "Blank texture yields zero retained support. A 2px vertical misalignment yields 0.87% coverage with 3.78 m p95 error among those surviving pixels; sector statements remain unknown under the frozen 20% threshold. These unknown results are not clearance. There are zero clear-sector claims by construction, so this count alone is vacuous as a safety test.", "",
             f"Pooled desktop image-to-record timing across 40 pairs × three timing-only replays is p50 {np.quantile(all_latency,.5):.1f} ms, p95 {np.quantile(all_latency,.95):.1f} ms, maximum {max(all_latency):.1f} ms, with one OpenCV thread. These repeats reuse identical images and are not reacquisitions. Timing excludes camera acquisition, original recording age, image loading and disk writes, and includes matcher construction plus record aggregation. It is not onboard performance or acquisition-to-action latency.", "",
             "## Stage-0 status", "", "| Test | Executed evidence | Remaining dependency |", "|---|---|---|",
             "| S01 | Ideal synthetic 1/2/4m repeats and three calibrated real scenes; error/coverage/interval diagnostics | Physical tape-measured reacquired clips; confidence calibration; WLS comparison |",
             "| S02 | Equal angular-size foreground cards at different stereo depths, with swapped positions | Real objects and recognition/association qualification |",
             "| S03 | 1/2/4/8/16px poles at two positions; pixel/sector false-far and 2/5px boundary metrics | Gate failed; independent thin-obstacle support needed before clearance use |",
             "| S04 | Blank/repeated texture; rendered exposure/blur and real alternate exposure | Glass, mirror, vegetation and live lighting challenges unrun |",
             "| S05 | Rendered 0/5/20/50ms moving-object skew and 2px vertical misalignment | Real synchronization, moving video, detection delay and temporal ghosting unrun |",
             "| S06 | Baseline, range/search bound and resolution fixtures; resized real images | Camera/compute-specific usable range and real mounting qualification |",
             "| S07 | Unimplemented; no invented pose is supplied | Actual feature-based stereo ego-motion; then drift, reset and moving-object rejection tests |",
             "| S08 | Six executable conversion/support tests, including nonzero SGBM sentinel and reversed DepthAI quality direction | DepthAI is a conversion fixture only; no device or SDK run. WLS absent |", "",
             "## Data for Jev and exact execution", "",
             "Use `exports/sensor-records.json` and retain every record. `exports/grades.json` contains separate reading-the-measured-statement keys and physical-truth grades. The optional `qualifiedEvidenceEligible` is posthoc audited correctness, unavailable at runtime; it must never become a perception confidence score or filter. 164/324 evaluation sectors have both a correct nearest bin and an interval containing the nearest reference; all excluded regions remain in aggregate sensing statistics and the export. Root elected to test interpretation on all 40 records. A correct Jev reading of a wrong sensor statement does not repair the perception failure.", "",
             "A separate pre-inference serialization amendment replaces scene names and image paths that encode synthetic distances with opaque IDs. It does not rematch, alter estimates or remove failures. Original descriptive diagnostics remain immutable. The export manifest records this change and its hashes. `exports/acquisition-metadata.json` supplements synthetic per-pair capture offsets without revealing geometry; original real capture times and end-to-end age remain unavailable.", "",
             "Commands executed from `C:/Users/danhm/tools/robots-world`:", "", "```powershell",
             "# Public downloads were initially executed by importing assets.download; this equivalent command is for a fresh output:",
             "& .runtime/vision-env/Scripts/python.exe -B experiments/jev-spatial-text/stereo/run.py --download --output .runtime/experiments/jev-spatial-text-v1/stereo-new",
             "# Actual matching execution after download:",
             "& .runtime/vision-env/Scripts/python.exe -u experiments/jev-spatial-text/stereo/run.py",
             "& .runtime/vision-env/Scripts/python.exe -B experiments/jev-spatial-text/stereo/test_contract.py",
             "& .runtime/vision-env/Scripts/python.exe -B experiments/jev-spatial-text/stereo/export.py",
             "& .runtime/vision-env/Scripts/python.exe -B experiments/jev-spatial-text/stereo/audit.py",
             "node --test test/jev-spatial-text-stereo.test.ts", "```", "",
             "Audit verifies four frozen source files, 13 downloaded inputs, all 40 measured pairs, all 360 region/grade joins, raw fixed-point/metric reconstruction, unchanged exported measurements, source hashes and absence of evaluator scene labels in inference data. Six Python mechanical tests and the optional Node test passed. Repository-wide verification is owned by the parent task.", "",
             "Next dependency: repair/qualify thin-obstacle handling and synchronization with new frozen development/confirmation scenes; obtain real timestamped stereo clips and implement/qualify actual ego-motion before persistent geometry or dependent mission flights. Do not tune this cohort and relabel it held-out success. WLS is a possible separately installed comparison only when explicitly authorized; it cannot be claimed to solve these failures without evidence."]
    (root/"report.md").write_text("\n".join(text)+"\n", encoding="utf-8")
    print(json.dumps({"report": str(root/"report.md"), "intervalRows": len(rows), "acquisitionRows": len(acquisition_metadata)}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default=".runtime/experiments/jev-spatial-text-v1/stereo")
    analyze(Path(parser.parse_args().input).resolve())

"""Explicit offline qualification; no inference, hardware or package install."""
from __future__ import annotations

import argparse
import datetime
import json
from pathlib import Path
import platform
import shutil
import sys
import time

import cv2
import numpy as np

from assets import calibrated_recorded, download, render_synthetic, sha, synthetic_specs, write_json
from grading import grade
from matching import PARAMETERS, estimate, make_regions


def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def freeze(root):
    path = root / "freeze.json"
    if path.exists():
        raise ValueError("Refusing to overwrite existing freeze; choose a new output directory")
    source = Path(__file__).parent
    frozen = root / "source"
    frozen.mkdir(parents=True)
    files = []
    for file in sorted(source.glob("*.py")):
        shutil.copyfile(file, frozen / file.name)
        files.append(dict(path=file.name, sha256=sha(file)))
    configuration = {"frozenAt": utc(), "parameters": PARAMETERS, "sources": files,
                     "versions": dict(python=sys.version, opencv=cv2.__version__, numpy=np.__version__, platform=platform.platform()),
                     "splits": {"development": ["Adirondack", "synthetic seed110 ladder"],
                                "evaluation": ["Motorcycle", "Pipes", "synthetic seeds220/330 ladder and440-770 challenges"]},
                     "selection": "all predeclared generated cases and all three public scenes; no parameter fitting or threshold search on evaluation",
                     "syntheticSpecs": synthetic_specs(), "recorded": ["Adirondack", "Motorcycle", "Pipes"],
                     "measurementGate": {"population": "held-out synthetic textured static ladder 1/2/4m", "minValidCoverage": .6,
                                         "p95Tolerance": "max(0.05m,5%depth)", "maxNearFalseFarPixels": 0, "maxP95ProcessToTextMs": 250},
                     "challengeGate": "zero near-to-far retained pixels and zero missed-near sector claims, plus no unsupported clear; no-clear alone is vacuous",
                     "limits": ["WLS unrun: cv2.ximgproc unavailable", "S07 ego-motion estimator unimplemented; no measured movement/map claim",
                                "no actual camera hardware, moving video, power/thermal or onboard compute", "S04 glass/mirror/vegetation unrun",
                                "S05 skew is controlled rendering, not synchronized camera recordings; temporal ghost persistence unrun",
                                "acquisition-to-text age unavailable for recorded stills; timing is desktop processing latency"]}
    write_json(path, configuration)
    return configuration


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default=".runtime/experiments/jev-spatial-text-v1/stereo")
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--synthetic-only", action="store_true")
    args = parser.parse_args()
    root = Path(args.output).resolve()
    root.mkdir(parents=True, exist_ok=True)
    if args.download:
        download(root)
    frozen = freeze(root)
    scenes = [render_synthetic(root, spec) for spec in synthetic_specs()]
    if not args.synthetic_only:
        scenes += [calibrated_recorded(root, name) for name in ("Adirondack", "Motorcycle", "Pipes")]
        scenes += [calibrated_recorded(root, "Motorcycle", exposure=True)]
    write_json(root / "scene-manifest-evaluator-only.json", scenes)
    # Development runs precede all evaluation; no adaptive changes in this run.
    scenes.sort(key=lambda scene: scene["split"] != "development")
    sensor_records, grade_records, results = [], [], []
    for scene in scenes:
        directory = Path(scene["inputDirectory"])
        calibration = json.loads((directory / "calibration.json").read_text())
        left, right = [cv2.imread(str(directory / f"{name}.png"), cv2.IMREAD_GRAYSCALE) for name in ("left", "right")]
        began = utc()
        start = time.perf_counter()
        result = estimate(left, right, calibration)
        regions = make_regions(result, calibration)
        process_to_text = (time.perf_counter()-start)*1000
        # Repetitions are timing-only replays of identical images, not new samples.
        latency = [process_to_text]
        for _ in range(2):
            tick = time.perf_counter()
            repeated = estimate(left, right, calibration)
            make_regions(repeated, calibration)
            latency.append((time.perf_counter()-tick)*1000)
        result_directory = root / "results" / scene["id"]
        result_directory.mkdir(parents=True)
        np.savez_compressed(result_directory / "estimated.npz", **{key: result[key] for key in
                            ("rawLeft", "rawRight", "disparity", "depth", "rawValid", "valid", "leftRightErrorPx", "textureStd")})
        view = np.zeros(left.shape, np.uint8)
        view[result["valid"]] = np.clip(result["depth"][result["valid"]]*35, 1, 255).astype(np.uint8)
        cv2.imwrite(str(result_directory / "depth-preview.png"), cv2.applyColorMap(view, cv2.COLORMAP_TURBO))
        cv2.imwrite(str(result_directory / "valid-mask.png"), result["valid"].astype(np.uint8)*255)
        record = {"id": scene["id"], "sceneId": scene["id"], "split": scene["split"], "sourceType": scene["sourceType"],
                  "calibrationId": sha(directory/"calibration.json"), "calibration": calibration,
                  "acquisition": {"id": scene["id"], "leftImage": str(directory/"left.png"), "rightImage": str(directory/"right.png"),
                                  "sourceSha256": {name: sha(directory/f"{name}.png") for name in ("left", "right")},
                                  "captureTimeKnown": scene["captureTimeKnown"], "processingStartedAt": began,
                                  "acquisitionToTextAgeMs": None},
                  "depthConvention": "camera-forward axial metres; bearings camera-relative, negative left",
                  "intervalMeaning": "measured connected-cluster 5th-95th percentile range plus +/-0.5 disparity pixel; not calibrated confidence",
                  "regions": regions, "clearanceContract": "returns measure visible patches; invalid, occluded and unsampled volume unknown; never full-sector clearance",
                  "latencyMs": {"initialization": result["initializationMs"], "firstProcessToText": process_to_text,
                                "samePairReplay": latency, "p50": float(np.median(latency)), "p95": float(np.quantile(latency,.95))}}
        sensor_records.append(record)
        scored, keys = grade(scene, result, regions, directory/"evaluator-only.npz")
        scored["latencyMs"] = record["latencyMs"]
        results.append(scored)
        grade_records += keys
        write_json(result_directory/"metrics.json", scored)
        print(json.dumps({"scene": scene["id"], "coverage": scored["retained"]["validCoverage"],
                          "p95error": scored["retained"]["p95AbsoluteErrorM"], "regions": scored["regionCounts"]}), flush=True)
        write_json(root/"sensor-records.json", {"schemaVersion": "stereo-sector-v1", "records": sensor_records})
        write_json(root/"grades.json", {"schemaVersion": "stereo-grades-v1", "records": grade_records})
    heldout = [x for x in results if x["split"] == "evaluation"]
    ladder = [x for x in heldout if "synthetic-ladder-" in x["sceneId"]]
    measurement_pass = all(x["retained"]["validCoverage"] >= .6 and x["retained"]["p95AbsoluteErrorM"] <= max(.05,.05*float(x["sceneId"].split("-")[2]))
                           and x["retained"]["nearFalseFarPixels"] == 0 and x["latencyMs"]["p95"] <= 250 for x in ladder)
    challenges_pass = all(x["retained"]["nearFalseFarPixels"] == 0 and x["regionCounts"]["missedNear"] == 0 and x["regionCounts"]["falseClear"] == 0 for x in heldout)
    summary = {"completedAt": utc(), "freezeSha256": sha(root/"freeze.json"), "sceneCount": len(results),
               "developmentScenes": len(results)-len(heldout), "evaluationScenes": len(heldout),
               "regionCounts": {key: sum(x["regionCounts"][key] for x in heldout) for key in heldout[0]["regionCounts"]},
               "gates": {"staticTexturedSyntheticLadder": measurement_pass, "allChallengeNearHazards": challenges_pass,
                         "fullSectorClearance": "unqualified: never asserted", "S07EgoMotion": "unimplemented", "WLS": "unrun"},
               "limits": frozen["limits"], "results": results}
    write_json(root/"summary.json", summary)
    print(json.dumps({key: value for key, value in summary.items() if key != "results"}), flush=True)


if __name__ == "__main__":
    main()

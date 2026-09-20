"""Evaluator-only retrospective joins; never import this module into perception.

The sealed Round 3 handoff owns reference values. New predictions never receive
these values. This evaluator uses only the standard library and no GPU runtime.
"""
from __future__ import annotations

import argparse
from collections import Counter
import json
import math
import os
from pathlib import Path
from statistics import mean

from integrity import existing_path, read, sha as sha256, seal_analysis, verify_arm, verify_predictions

REPO = Path(__file__).resolve().parents[2]
ARCHIVED = {"archived_bbox": "bboxMedian", "archived_cluster": "maskForegroundCluster"}
BANDS = (("below8M", None, 8), ("8To12M", 8, 12), ("above12M", 12, None))
SCOPE = "Retrospective paired comparison on the same 1,200 Round 3 images; old confirmation is reused, not fresh held-out evidence."


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def quantile(values, fraction):
    if not values:
        return None
    values = sorted(values)
    position = (len(values) - 1) * fraction
    lower, upper = math.floor(position), math.ceil(position)
    return values[lower] + (values[upper] - values[lower]) * (position - lower)


def iou(a, b):
    if a is None or b is None:
        return 0.0
    intersection = max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1]))
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - intersection
    return intersection / union if union > 0 else 0.0


def indexed(records, label, expected=None, key="id"):
    result = {}
    for record in records:
        identity = record[key]
        if identity in result:
            raise ValueError(f"{label}: duplicate {key} {identity}")
        result[identity] = record
    if expected is not None and set(result) != set(expected):
        missing, extra = set(expected) - set(result), set(result) - set(expected)
        raise ValueError(f"{label}: incomplete frame population; missing={len(missing)} {sorted(missing)[:3]}, extra={len(extra)} {sorted(extra)[:3]}")
    return result


def verify_sealed_file(path, seal):
    path = Path(path).resolve()
    entry = next((item for item in seal["files"] if Path(item["path"]).resolve() == path), None)
    if entry is None or sha256(path) != entry["sha256"]:
        raise ValueError(f"Missing or changed sealed evidence: {path}")


def load_baseline(root):
    seal = read(root / "analysis-seal.json")
    for name in ("perception-handoff.json", "prediction-seal.json"):
        verify_sealed_file(root / name, seal)
    handoff = read(root / "perception-handoff.json")
    frames = []
    for route in handoff["routes"]:
        if sorted(f["frameIndex"] for f in route["frames"]) != list(range(100)):
            raise ValueError("Archived routes must contain exactly frame indices 0..99")
        for frame in route["frames"]:
            frames.append({**frame, "routeId": route["id"], "family": route["family"], "split": route["split"]})
    by_id = indexed(frames, "archived handoff")
    if len(frames) != 1200 or sum(f["split"] == "confirmation" for f in frames) != 400:
        raise ValueError("Expected exact archived 1200-frame / 400 old-confirmation population")
    prediction_seal = read(root / "prediction-seal.json")
    originals = []
    for split in ("development", "confirmation"):
        path = root / "perception/scored" / split / "results.json"
        verify_sealed_file(path, prediction_seal)
        originals.extend(read(path)["results"])
    return handoff, by_id, indexed(originals, "archived predictions", by_id)


def archived_records(originals):
    records = []
    for original in originals.values():
        candidates = [d for d in original["detections"] if d["blueCarCandidate"]]
        records.append({**original, "selectedDetectionId": candidates[0]["detectionId"] if len(candidates) == 1 else None,
                        "selectionStatus": "single" if len(candidates) == 1 else "missing" if not candidates else "ambiguous"})
    return records


def score_record(record, reference, measurement_key):
    """Score the supplied policy selection; never bind/select using reference truth."""
    detections = indexed(record["detections"], record["id"], key="detectionId")
    for detection in detections.values():
        box = detection["boxXyxy"]
        if len(box) != 4 or not all(finite(v) for v in box) or box[2] <= box[0] or box[3] <= box[1]:
            raise ValueError(f"Invalid detection box in {record['id']}")
    selected_id = record["selectedDetectionId"]
    if selected_id is not None and selected_id not in detections:
        raise ValueError(f"Selected detection absent in {record['id']}: {selected_id}")
    selected = detections.get(selected_id)
    candidates = [d for d in detections.values() if d["blueCarCandidate"]]
    overlap = iou(selected["boxXyxy"], reference["visibleBox"]) if selected else 0.0
    correct = selected is not None and overlap >= .5
    if selected:
        measurement = selected["arms"][measurement_key]
    else:
        measurement = {"status": "unknown", "estimateM": None, "unknownReason": record["selectionStatus"]}
    estimate = measurement["estimateM"]
    if measurement["status"] == "measured" and not finite(estimate):
        raise ValueError(f"Measured range must be finite in {record['id']}")
    accepted = selected is not None and measurement["status"] == "measured" and finite(estimate)
    target_range = reference["medianVisibleRangeM"]
    error = estimate - target_range if accepted and finite(target_range) else None
    grade = {"accepted": accepted, "associationCorrect": correct, "correctUsable": accepted and correct,
             "acceptedWrongAssociation": accepted and not correct, "selectedDetectionIoU": overlap,
             "detectorCorrectCandidate": any(iou(d["boxXyxy"], reference["visibleBox"]) >= .5 for d in candidates),
             "errorM": error, "absoluteErrorM": abs(error) if error is not None else None,
             "falseFarOver2M": error is not None and error > 2,
             "falseNearOver2M": error is not None and error < -2}
    return {"id": record["id"], "grade": grade, "measurement": measurement,
            "selectedDetectionId": selected_id, "selectionStatus": record["selectionStatus"],
            "candidateCount": len(candidates),
            "detections": [{key: d[key] for key in ("detectionId", "className", "confidence", "boxXyxy", "blueCarCandidate", "trackId", "bearing") if key in d} for d in record["detections"]],
            "tracking": record.get("tracking"), "timing": record.get("timing", {}),
            "artifacts": record.get("artifacts", {})}


def aggregate(frames):
    grades = [frame["grade"] for frame in frames]
    errors = [g["absoluteErrorM"] for g in grades if g["absoluteErrorM"] is not None]
    visible = [f for f in frames if f["evaluator"]["visiblePixels"] > 0]
    count = lambda key: sum(g[key] for g in grades)
    return {"frames": len(frames), "visibleReferenceFrames": len(visible),
            "rawCorrectCandidateFrames": count("detectorCorrectCandidate"),
            "detectorRecall": sum(f["grade"]["detectorCorrectCandidate"] for f in visible) / len(visible) if visible else None,
            "detectorRecallDenominator": len(visible),
            "correctAssociations": count("associationCorrect"), "acceptedRanges": count("accepted"),
            "correctUsableRanges": count("correctUsable"), "unknownRanges": sum(not g["accepted"] for g in grades),
            "correctUsableFraction": count("correctUsable") / len(frames) if frames else None,
            "acceptedWrongAssociations": count("acceptedWrongAssociation"),
            "falseFarOver2M": count("falseFarOver2M"), "falseNearOver2M": count("falseNearOver2M"),
            "absoluteErrorsOver2M": sum(error > 2 for error in errors),
            "meanAbsoluteErrorM": mean(errors) if errors else None,
            "p95AbsoluteErrorM": quantile(errors, .95), "errorDenominator": len(errors),
            "acceptedWithoutReferenceRange": sum(g["accepted"] and g["absoluteErrorM"] is None for g in grades),
            "missingCandidateFrames": sum(f["candidateCount"] == 0 for f in frames),
            "ambiguousCandidateFrames": sum(f["candidateCount"] > 1 for f in frames),
            "selectedFrames": sum(f["selectedDetectionId"] is not None for f in frames),
            "selectionStatuses": dict(Counter(f["selectionStatus"] for f in frames))}


def timing_summary(frames):
    values = {}
    def collect(timing, prefix=""):
        for key, value in timing.items():
            name = prefix + key
            if isinstance(value, dict):
                collect(value, name + ".")
            elif finite(value) and key.endswith("Ms"):
                values.setdefault(name, []).append(value)
    for frame in frames:
        collect(frame["timing"])
    return {key: {"n": len(v), "medianMs": quantile(v, .5), "p95Ms": quantile(v, .95)} for key, v in sorted(values.items())}


def tracking_summary(frames):
    tracked = [f for f in frames if isinstance(f.get("tracking"), dict)]
    if not tracked:
        return None
    acquisitions = losses = changes = observations = 0
    previous = {}
    for frame in sorted(tracked, key=lambda f: (f["routeId"], f["frameIndex"])):
        tracking, route = frame["tracking"], frame["routeId"]
        target = tracking.get("target", tracking)
        bound = target.get("boundTrackId")
        observed = target.get("measured", target.get("currentObserved", frame["selectedDetectionId"] is not None))
        observations += bool(observed)
        old_bound, old_observed = previous.get(route, (None, False))
        acquisitions += bound is not None and old_bound is None
        changes += bound is not None and old_bound is not None and bound != old_bound
        losses += bool(old_observed) and not observed
        previous[route] = (bound, observed)
    return {"framesWithTracking": len(tracked), "currentObservationFrames": observations,
            "currentObservationFraction": observations / len(frames),
            "bindingAcquisitions": acquisitions, "currentObservationLosses": losses,
            "boundIdChanges": changes, "definition": "Route-reset transitions of reported binding/current observation; ID changes are not truth-identity switches."}


def summarize_arm(frames):
    populations = {"all1200": frames, "oldConfirmation400": [f for f in frames if f["split"] == "confirmation"]}
    result = {name: aggregate(group) for name, group in populations.items()}
    result["perFamily"], result["rangeBands"] = {}, {}
    for name, group in populations.items():
        result["perFamily"][name] = {family: aggregate([f for f in group if f["family"] == family]) for family in sorted({f["family"] for f in group})}
        result["rangeBands"][name] = {}
        for label, low, high in BANDS:
            def inside(frame):
                value = frame["evaluator"]["medianVisibleRangeM"]
                return finite(value) and (low is None or (value >= low if high is not None else value > low)) and (high is None or (value < high if low is None else value <= high))
            result["rangeBands"][name][label] = aggregate([f for f in group if inside(f)])
        result["rangeBands"][name]["unknownReference"] = aggregate([f for f in group if not finite(f["evaluator"]["medianVisibleRangeM"])])
    result["timing"] = timing_summary(frames)
    result["tracking"] = tracking_summary(frames)
    result["trackingByPopulation"] = {name: tracking_summary(group) for name, group in populations.items()}
    result["perRoute"] = {route: aggregate([f for f in frames if f["routeId"] == route]) for route in sorted({f["routeId"] for f in frames})}
    return result


def verify_archived_metrics(summary, handoff):
    for arm, old_key in (("archived_bbox", "box"), ("archived_cluster", "mask")):
        actual = summary[arm]["oldConfirmation400"]
        expected = handoff["summary"]["maskPromotion"][old_key]
        for key in ("frames", "correctAssociations", "acceptedRanges", "correctUsableRanges", "unknownRanges", "acceptedWrongAssociations", "falseFarOver2M", "falseNearOver2M", "errorDenominator", "meanAbsoluteErrorM", "p95AbsoluteErrorM"):
            if not math.isclose(actual[key], expected[key], rel_tol=1e-12, abs_tol=1e-12):
                raise ValueError(f"Archived reproduction failed: {arm}.{key}: {actual[key]} != {expected[key]}")


def load_arms(root, expected, originals):
    manifest = read(root / "manifest.json")
    if manifest["expectedFrames"] != len(expected):
        raise ValueError("Manifest expectedFrames must match the archived population")
    declarations = indexed(manifest["arms"], "arm manifest", key="arm")
    if set(declarations) & set(ARCHIVED):
        raise ValueError("Archived arm names are reserved")
    discovered = {path.parent.name for path in (root / "arms").glob("*/results.json")}
    if discovered - set(declarations):
        raise ValueError(f"Undeclared result arms: {sorted(discovered - set(declarations))}")
    arms, unavailable = {}, {}
    for arm, declaration in declarations.items():
        status = declaration["status"]
        if status in ("unavailable", "benchmark-only"):
            if not declaration.get("reason"):
                raise ValueError(f"{arm}: {status} requires an explicit reason")
            unavailable[arm] = declaration
            continue
        if status != "complete":
            raise ValueError(f"{arm}: incomplete or unknown arm status {status}")
        data = read(root / "arms" / arm / "results.json")
        if data["arm"] != arm:
            raise ValueError(f"Arm identity mismatch: {arm}")
        records = indexed(data["records"], arm, expected)
        for identity, record in records.items():
            if record["input"] != originals[identity]["input"]:
                raise ValueError(f"{arm}: frozen input path/hash mismatch: {identity}")
        arms[arm] = verify_arm(root, root / 'arms' / arm / 'results.json', originals)
    verify_predictions(root, originals)
    return manifest, arms, unavailable


def web_path(path, root, base):
    path = Path(path)
    return Path(os.path.relpath(existing_path(path if path.is_absolute() else base / path), existing_path(root))).as_posix()


def analyze(root, baseline):
    root, baseline = Path(root).resolve(), Path(baseline).resolve()
    if root == baseline or baseline in root.parents:
        raise ValueError("New output root must be outside the archived baseline directory")
    outputs = [root / name for name in ("summary.json", "replay.json", "index.html")]
    if (root / "analysis-seal.json").exists() or any(path.exists() for path in outputs):
        raise FileExistsError("Preserve existing analysis; choose a new output root rather than overwrite")
    handoff, references, originals = load_baseline(baseline)
    manifest, arms, unavailable = load_arms(root, references, originals)
    records = archived_records(originals)
    data = {arm: {"records": records, "measurementKey": key, "metadata": {"source": "sealed archived predictions", "freshCompute": False}} for arm, key in ARCHIVED.items()}
    data.update(arms)
    scored, summaries = {}, {}
    for arm, batch in data.items():
        frames = []
        for record in batch["records"]:
            ref = references[record["id"]]
            frame = score_record(record, ref["evaluator"], batch["measurementKey"])
            frame.update({key: ref[key] for key in ("routeId", "family", "split", "frameIndex", "evaluator")})
            frame["artifacts"] = {key: web_path(value, root, baseline if arm in ARCHIVED else root) for key, value in frame["artifacts"].items() if isinstance(value, str)}
            frames.append(frame)
        scored[arm] = indexed(frames, arm, references)
        summaries[arm] = {"metadata": batch.get("metadata", {}), "measurementKey": batch["measurementKey"], **summarize_arm(frames)}
    verify_archived_metrics(summaries, handoff)
    summary = {"schemaVersion": "jev-library-summary-v1", "scope": SCOPE, "frames": len(references),
               "statisticalUnit": "12 correlated scripted routes; frame counts are not independent trials",
               "errorPopulation": "Every accepted finite range with finite reference, including wrong target selections; primary reference is median visible surface range.",
               "detectorRecallDefinition": "At least one raw blue-car candidate box with IoU >= 0.5 against visible reference box, independent of policy selection.",
               "timingCaveat": "Per-arm measurements retain their recorded scope. Cached-stereo quality runs are not live serial pipeline timings; component quantiles are never summed.",
               "archivedReproduction": "passed against sealed old-confirmation summary", "arms": summaries,
               "unavailableArms": unavailable, "manifest": manifest,
               "referenceSha256": sha256(baseline / "perception-handoff.json")}
    routes = {}
    for identity, ref in references.items():
        route = routes.setdefault(ref["routeId"], {"id": ref["routeId"], "family": ref["family"], "split": ref["split"], "frames": []})
        route["frames"].append({key: ref[key] for key in ("id", "frameIndex", "atMs", "evaluator")} | {
            "left": web_path(ref["left"], root, baseline), "right": web_path(ref["right"], root, baseline),
            "arms": {arm: {k: v for k, v in scored[arm][identity].items() if k not in ("evaluator", "routeId", "family", "split", "frameIndex")} for arm in scored}})
    for route in routes.values():
        route["frames"].sort(key=lambda f: f["frameIndex"])
    replay = {"title": "Perception library comparison", "scope": SCOPE, "summary": summary, "routes": list(routes.values())}
    root.mkdir(parents=True, exist_ok=True)
    for path, value in zip(outputs[:2], (summary, replay)):
        with path.open("x", encoding="utf-8") as stream:
            json.dump(value, stream, indent=2, allow_nan=False)
            stream.write("\n")
    with outputs[2].open('x', encoding='utf-8') as stream:
        stream.write(Path(__file__).with_name('replay.html').read_text(encoding='utf-8'))
    seal_analysis(root, originals)
    return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=REPO / ".runtime/experiments/jev-library-v1")
    parser.add_argument("--baseline", type=Path, default=REPO / ".runtime/experiments/jev-round3-v1")
    args = parser.parse_args()
    result = analyze(args.root, args.baseline)
    print(json.dumps({"frames": result["frames"], "arms": list(result["arms"]), "archivedReproduction": result["archivedReproduction"]}))

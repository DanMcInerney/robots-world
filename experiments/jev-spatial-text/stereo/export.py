"""Export measurements with opaque inference IDs, retaining every failure.

This post-run serialization amendment does not rematch or alter estimated depth.
The original record/grade files and source snapshot remain unchanged.
"""
from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path
import shutil

from assets import sha, write_json


def export(root):
    destination = root / "exports"
    destination.mkdir(parents=True, exist_ok=False)
    records = json.loads((root/"sensor-records.json").read_text())
    grades = json.loads((root/"grades.json").read_text())
    mapping = {}
    for index, record in enumerate(records["records"]):
        original = record["id"]
        opaque = f"stereo-{index:04d}"
        mapping[original] = opaque
        record["id"] = record["sceneId"] = opaque
        record["acquisition"]["id"] = opaque
        images = destination / "images" / opaque
        images.mkdir(parents=True)
        for field, name in (("leftImage", "left"), ("rightImage", "right")):
            source = Path(record["acquisition"][field])
            shutil.copyfile(source, images/f"{name}.png")
            record["acquisition"][field] = str(images/f"{name}.png")
    for item in grades["records"]:
        item["recordId"] = mapping[item["recordId"]]
        record = next(record for record in records["records"] if record["id"] == item["recordId"])
        region = next(region for region in record["regions"] if region["id"] == item["regionId"])
        interval = region["depthIntervalM"]
        reference = item["referenceNearestDepthM"]
        interval_support = interval is not None and reference is not None and interval[0] <= reference <= interval[1]
        item["intervalContainsReferenceNearest"] = interval_support
        item["binOnlyEvidenceEligible"] = item["qualifiedEvidenceEligible"]
        item["qualifiedEvidenceEligible"] = item["qualifiedEvidenceEligible"] and interval_support
        item["eligibilityMeaning"] = "post-grading interpretation subset requires correct nearest-depth bin AND reported interval containing evaluator nearest reference; all failures remain in sensing denominators"
        if not item["qualifiedEvidenceEligible"]:
            item["exclusionReason"] = "insufficient support, wrong bin, or interval excludes evaluator nearest reference"
    write_json(destination/"sensor-records.json", records)
    write_json(destination/"grades.json", grades)
    write_json(destination/"id-mapping-evaluator-only.json", mapping)
    qualification = {"allRegions": len(grades["records"]),
                     "qualifiedEvidence": sum(x["qualifiedEvidenceEligible"] for x in grades["records"]),
                     "bySplit": {split: {"allRegions": sum(x["split"] == split for x in grades["records"]),
                                         "qualifiedEvidence": sum(x["split"] == split and x["qualifiedEvidenceEligible"] for x in grades["records"])}
                                 for split in ("development", "evaluation")}}
    write_json(destination/"export-manifest.json", {
        "reason": "Before any inference, remove scene names that contain evaluator ranges from IDs/image paths. Tighten interpreter eligibility from bin-only agreement to interval support as well. No estimate, region, bin, original metric, matcher or parameter is changed.",
        "sourceSha256": {str(path): sha(path) for path in (root/"sensor-records.json", root/"grades.json", Path(__file__))},
        "outputSha256": {path.name: sha(path) for path in (destination/"sensor-records.json", destination/"grades.json")},
        "qualification": qualification})
    print(json.dumps(qualification))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default=".runtime/experiments/jev-spatial-text-v1/stereo")
    export(Path(parser.parse_args().input).resolve())

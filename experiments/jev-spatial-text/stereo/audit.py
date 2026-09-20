"""Read-only replay and source/export audit; writes a separate audit result."""
import argparse
import json
from pathlib import Path
import subprocess
import sys

import numpy as np

from assets import sha, write_json
from matching import depth_from_disparity, fixed_point_disparity


def audit(root):
    frozen = json.loads((root/"freeze.json").read_text())
    for source in frozen["sources"]:
        assert sha(root/"source"/source["path"]) == source["sha256"]
        assert sha(Path(__file__).parent/source["path"]) == source["sha256"]
    sources = json.loads((root/"download-manifest.json").read_text())
    for source in sources["files"]:
        assert sha(root/source["path"]) == source["sha256"]
    assert sources["totalBytes"] <= sources["capBytes"]
    original = json.loads((root/"sensor-records.json").read_text())["records"]
    safe = json.loads((root/"exports/sensor-records.json").read_text())["records"]
    grades = json.loads((root/"exports/grades.json").read_text())["records"]
    mapping = json.loads((root/"exports/id-mapping-evaluator-only.json").read_text())
    assert len(original) == len(safe) == 40
    for raw_record, record in zip(original, safe):
        assert record["id"] == record["sceneId"] == mapping[raw_record["id"]]
        assert record["regions"] == raw_record["regions"]
        for name in ("left", "right"):
            assert sha(Path(record["acquisition"][name+"Image"])) == record["acquisition"]["sourceSha256"][name]
        with np.load(root/"results"/raw_record["id"]/"estimated.npz") as data:
            disparity, valid = fixed_point_disparity(data["rawLeft"])
            np.testing.assert_array_equal(disparity, data["disparity"])
            depth = depth_from_disparity(disparity, record["calibration"])
            np.testing.assert_allclose(depth, data["depth"], equal_nan=True)
            np.testing.assert_array_equal(valid & np.isfinite(depth), data["rawValid"])
            for region in record["regions"]:
                x0,y0,x1,y1 = region["pixelBounds"]
                assert region["supportPixels"] == int(data["valid"][y0:y1,x0:x1].sum())
                assert region["wholeSectorClearCertified"] is False
                assert region["clearance"] == "unknown"
                assert len([grade for grade in grades if grade["recordId"] == record["id"] and grade["regionId"] == region["id"]]) == 1
    serialized = json.dumps(safe)
    assert "referenceNearest" not in serialized and "evaluator-only" not in serialized
    assert all(name not in serialized for name in mapping)
    tests = subprocess.run([sys.executable, "-B", str(Path(__file__).parent/"test_contract.py")], capture_output=True, text=True)
    assert tests.returncode == 0, tests.stderr
    output = {"passed": True, "sourceFilesVerified": len(frozen["sources"]), "downloadFilesVerified": len(sources["files"]),
              "downloadBytes": sources["totalBytes"], "pairsVerified": len(safe), "regionsVerified": len(grades),
              "checks": ["frozen/current numerical source matches", "official source hashes", "download cap", "raw fixed-point conversion",
                         "metric depth reconstruction from calibration", "sentinel validity", "support pixel count", "all-grade join cardinality",
                         "export measurements unchanged", "opaque IDs and image paths", "no evaluator keys/scene names", "clearance always unknown"],
              "mechanicalTestOutput": tests.stderr, "auditSourceSha256": sha(Path(__file__))}
    write_json(root/"audit.json", output)
    print(json.dumps({key:value for key,value in output.items() if key != "mechanicalTestOutput"}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default=".runtime/experiments/jev-spatial-text-v1/stereo")
    audit(Path(parser.parse_args().input).resolve())

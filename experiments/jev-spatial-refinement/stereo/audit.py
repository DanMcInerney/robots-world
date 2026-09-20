"""Replay frozen sources and compare every input, result array and grade."""
from __future__ import annotations
import argparse
import importlib
import json
from pathlib import Path
import sys
import cv2
import numpy as np
from run import sha, write


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--output",default=".runtime/experiments/jev-spatial-refinement-v1/stereo")
    args=parser.parse_args();root=Path(args.output).resolve()
    freeze=json.loads((root/"freeze.json").read_text())
    manifest=json.loads((root/"manifest.json").read_text())
    assert manifest["freezeSha256"]==sha(root/"freeze.json")
    assert freeze["opencvBuildInfoSha256"]==sha(root/"opencv-build-info.txt")
    for file in freeze["sources"]:assert sha(root/"source"/file["path"])==file["sha256"]
    expected={f["path"] for f in manifest["files"]}
    actual={p.relative_to(root).as_posix() for sub in ("inputs","results") for p in (root/sub).rglob("*") if p.is_file()}
    assert actual==expected
    for file in manifest["files"]:
        assert sha(root/file["path"])==file["sha256"]
        assert (root/file["path"]).stat().st_size==file["bytes"]
    assert sha(root/"summary.json")==manifest["summarySha256"]
    assert sha(root/"report.md")==manifest["reportSha256"]
    sys.path.insert(0,str(root/"source"))
    for name in ("baseline_matching","pipeline","scenes","evaluation"):
        sys.modules.pop(name,None)
    pipeline=importlib.import_module("pipeline");scenes=importlib.import_module("scenes");evaluation=importlib.import_module("evaluation")
    assert pipeline.PARAMETERS==freeze["parameters"]
    assert scenes.specs()==freeze["cases"]
    source_paths={name:str(sys.modules[name].__file__) for name in ("baseline_matching","pipeline","scenes","evaluation")}
    for path in source_paths.values():assert Path(path).parent==root/"source"
    comparisons=0
    for i,spec in enumerate(freeze["cases"]):
        directory=root/"inputs"/spec["id"]
        generated,generated_truth=scenes.render(spec)
        images=[cv2.imread(str(directory/f"{eye}.png"),cv2.IMREAD_GRAYSCALE) for eye in ("left","right")]
        for before,after in zip(images,generated):np.testing.assert_array_equal(before,after)
        truth=dict(np.load(directory/"truth-evaluator-only.npz"))
        for key in truth:np.testing.assert_array_equal(truth[key],generated_truth[key])
        calibration=json.loads((directory/"calibration.json").read_text());assert calibration==freeze["calibration"]
        for arm in pipeline.PARAMETERS:
            destination=root/"results"/spec["id"]/arm
            recorded=np.load(destination/"estimated.npz")
            result=pipeline.estimate(arm,*images,calibration)
            for key in recorded.files:np.testing.assert_array_equal(recorded[key],result[key]);comparisons+=1
            sensor=json.loads((destination/"sensor.json").read_text());regions=pipeline.make_regions(result,calibration)
            assert regions==sensor["regions"]
            assert evaluation.grade(result,regions,truth)==json.loads((destination/"grade-evaluator-only.json").read_text())
        if i%8==7:print(f"replayed {i+1}/56 pairs",flush=True)
    output=dict(passed=True,pairs=56,matchRuns=168,pngsReconstructed=112,arrayComparisons=comparisons,
                sectorRecordsReconstructed=56*3*9,hashedEvidenceFiles=len(manifest["files"]),
                frozenSourceModules=source_paths,freezeSha256=sha(root/"freeze.json"),
                latencyReproduction=False,meaning="exact numerical/image replay; latency was not asserted reproducible")
    write(root/"audit.json",output);print(json.dumps(output),flush=True)


if __name__=="__main__":main()

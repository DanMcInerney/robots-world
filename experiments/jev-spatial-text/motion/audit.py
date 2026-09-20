"""Independent replay checks for source, images, estimated poses and resets."""
import argparse
import json
from pathlib import Path

import cv2
import numpy as np

from estimate import Odometry
from render import sha, write_json


def audit(root):
    freeze=json.loads((root/"freeze.json").read_text())
    for source in freeze["sourceFiles"]:
        assert sha(Path(source["original"]))==source["sha256"]
        assert sha(root/"source"/source["frozen"])==source["sha256"]
    summaries=json.loads((root/"summary.json").read_text())
    assert summaries["complete"]
    frames,poses,unknowns,resets,landmark_observations=0,0,0,0,0
    for summary in summaries["sequences"]:
        directory=root/"inputs"/summary["id"]
        inputs=json.loads((directory/"sensor-sequence.json").read_text())
        measured=json.loads((root/"results"/summary["id"]/"sensor-estimates.json").read_text())["records"]
        truth=json.loads((root/"results"/summary["id"]/"grades-evaluator-only.json").read_text())["grades"]
        assert len(inputs["frames"])==len(measured)==len(truth)==summary["frames"]
        engine=Odometry(inputs["calibration"])
        for frame,expected,grade in zip(inputs["frames"],measured,truth):
            assert frame["id"]==expected["frameId"]==grade["frameId"]
            for name in ("left","right"):
                assert sha(Path(frame[name+"Image"]))==frame["sourceSha256"][name]
            if frame["resetEpoch"]:
                old_epoch=engine.epoch
                old_id=next(iter(engine.landmarks))
                engine.reset()
                assert engine.join(old_epoch,old_id)==dict(status="stale-epoch",position=None)
                assert not engine.landmarks and engine.reference is None
                resets+=1
            left,right=[cv2.imread(frame[key],cv2.IMREAD_GRAYSCALE) for key in ("leftImage","rightImage")]
            actual,stereo=engine.process(left,right,frame["id"])
            assert actual["status"]==expected["status"] and actual["epoch"]==expected["epoch"]
            assert actual["failureReason"]==expected["failureReason"]
            for key in ("trackedPoints","pnpCandidates","inliers","mapLandmarkCount"):
                assert actual[key]==expected[key]
            if actual["pose"] is None:
                assert expected["pose"] is None and grade["translationErrorM"] is None
                unknowns+=1
            else:
                np.testing.assert_allclose(actual["pose"],expected["pose"],atol=1e-10,rtol=0)
                poses+=1
            assert len(actual["landmarkObservations"])==len(expected["landmarkObservations"])
            for current,prior in zip(actual["landmarkObservations"],expected["landmarkObservations"]):
                assert current["id"]==prior["id"]
                np.testing.assert_allclose(current["mapMeasured"],prior["mapMeasured"],atol=1e-9,rtol=0)
                np.testing.assert_allclose(current["anchoredMap"],prior["anchoredMap"],atol=1e-9,rtol=0)
            landmark_observations+=len(actual["landmarkObservations"])
            with np.load(root/"results"/summary["id"]/f"{frame['id']}-stereo.npz") as recorded:
                np.testing.assert_allclose(stereo["depth"],recorded["depth"],equal_nan=True)
                np.testing.assert_array_equal(stereo["valid"],recorded["valid"])
            frames+=1
        print(f"replayed {summary['id']} ({summary['frames']} frames)",flush=True)
    result=dict(passed=True,sourceFilesVerified=len(freeze["sourceFiles"]),imageFilesVerified=frames*2,
                framesReplayed=frames,posesReplayedIncludingAnchors=poses,unknownPosesReplayed=unknowns,
                landmarkObservationsReplayed=landmark_observations,resetOldJoinRejections=resets,
                checks=["frozen/current source hashes","original acquired PNG hashes","sensor-only estimator replay",
                        "exact status and feature/inlier counts","pose matrices 1e-10 absolute tolerance",
                        "sensor-anchored map coordinates 1e-9 tolerance","actual stereo depth and validity",
                        "unknown never carries current pose or invented GT error","old epoch joins rejected"],
                auditSourceSha256=sha(Path(__file__)))
    write_json(root/"audit.json",result)
    print(json.dumps(result))


if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--input",default=".runtime/experiments/jev-spatial-text-v1/motion")
    audit(Path(parser.parse_args().input).resolve())

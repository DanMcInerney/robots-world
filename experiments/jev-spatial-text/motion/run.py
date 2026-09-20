"""Freeze, run and grade S07 without exposing evaluator poses to estimation."""
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

from estimate import Odometry, SETTINGS, rotation_degrees
from render import CALIBRATION, render_sequence, sha, specs, write_json


def freeze(root):
    if (root/"freeze.json").exists():
        raise ValueError("Existing freeze is immutable; use a fresh output")
    source=Path(__file__).parent
    destination=root/"source"
    destination.mkdir(parents=True,exist_ok=False)
    files=[]
    for path in list(source.glob("*.py"))+[source.parent/"stereo/matching.py"]:
        output=destination/("stereo-matching.py" if path.name=="matching.py" else path.name)
        shutil.copyfile(path,output)
        files.append(dict(original=str(path.resolve()),frozen=output.name,sha256=sha(path)))
    data=dict(frozenAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),sourceFiles=files,settings=SETTINGS,
              calibration=CALIBRATION,sequences=specs(),
              versions=dict(python=sys.version,opencv=cv2.__version__,numpy=np.__version__,platform=platform.platform()),
              gates=dict(staticSequenceCoverage=.9,maxTranslationErrorM=.10,maxRotationErrorDeg=2.0,resetRejectsOldEpoch=True),
              semantics="Pose estimate derives from actual stereo matching and tracked image correspondences; initial pose identity defines each map epoch. Render poses/labels enter grading only.",
              limitations=["ideal synthetic pinhole stereo; no hardware, VIO, loop closure, relocalization, dynamic segmentation or production SLAM",
                           "feature inlier gates are fallible; current pose is null on failure, not last pose relabelled current",
                           "landmarks are sparse, observed patches only; no occupancy or clear-space certification",
                           "frame acquisition at100ms simulated cadence; offline replay need not keep up; no real acquisition-to-state age claim"])
    write_json(root/"freeze.json",data)
    return data


def unproject(pixel,depth,calibration):
    return np.array([(pixel[0]-calibration["cx"])*depth/calibration["fx"],
                     (pixel[1]-calibration["cy"])*depth/calibration["fy"],depth])


def run_sequence(root,directory,split,name):
    sensor=json.loads((directory/"sensor-sequence.json").read_text())
    truth=json.loads((directory/"evaluator-only.json").read_text())
    # Evaluator values stay in this runner; the estimator API gets only images,
    # calibration and opaque acquisition identity. Public reset is a protocol event.
    engine=Odometry(sensor["calibration"])
    anchor_truth=None
    records,grades,resets=[],[],[]
    for frame,reference in zip(sensor["frames"],truth["truth"]):
        if frame["resetEpoch"]:
            old_epoch=engine.epoch
            old_id=next(iter(engine.landmarks),"unavailable")
            engine.reset()
            resets.append(dict(frameId=frame["id"],oldEpoch=old_epoch,newEpoch=engine.epoch,
                               oldJoin=engine.join(old_epoch,old_id),oldMapCleared=len(engine.landmarks)==0))
            anchor_truth=None
        left,right=[cv2.imread(frame[key],cv2.IMREAD_GRAYSCALE) for key in ("leftImage","rightImage")]
        start=time.perf_counter()
        measured,stereo=engine.process(left,right,frame["id"])
        measured["processingMs"]=(time.perf_counter()-start)*1000
        measured["acquisitionMs"]=frame["acquisitionMs"]
        measured["acquisition"]=frame
        records.append(measured)
        output=root/"results"/sensor["id"]
        output.mkdir(parents=True,exist_ok=True)
        np.savez_compressed(output/f"{frame['id']}-stereo.npz",disparity=stereo["disparity"],valid=stereo["valid"],depth=stereo["depth"])
        true_pose=np.array(reference["worldFromCamera"])
        if measured["status"]=="epoch-anchor":
            anchor_truth=true_pose
        grade=dict(frameId=frame["id"],epoch=engine.epoch,status=measured["status"],translationErrorM=None,
                   rotationErrorDeg=None,staticLandmarkCount=0,staticLandmarkMedianErrorM=None,
                   staticLandmarkP95ErrorM=None,staticConsistencyMedianM=None,staticConsistencyP95M=None,
                   dynamicInlierLandmarkCount=0)
        if measured["pose"] is not None:
            estimated_world=anchor_truth@np.array(measured["pose"])
            grade["translationErrorM"]=float(np.linalg.norm(estimated_world[:3,3]-true_pose[:3,3]))
            grade["rotationErrorDeg"]=rotation_degrees(estimated_world[:3,:3].T@true_pose[:3,:3])
            with np.load(reference["truthPath"]) as gt:
                depth,dynamic=gt["depth"],gt["dynamic"]
            errors,consistency=[],[]
            for point in measured["landmarkObservations"]:
                x,y=np.rint(point["pixel"]).astype(int)
                if not (0<=x<depth.shape[1] and 0<=y<depth.shape[0]) or not np.isfinite(depth[y,x]):
                    continue
                if dynamic[y,x]:
                    grade["dynamicInlierLandmarkCount"]+=1
                    continue
                actual=true_pose[:3,:3]@unproject(point["pixel"],depth[y,x],sensor["calibration"])+true_pose[:3,3]
                estimated=anchor_truth[:3,:3]@np.array(point["mapMeasured"])+anchor_truth[:3,3]
                errors.append(float(np.linalg.norm(estimated-actual)))
                consistency.append(point["selfConsistencyResidualM"])
            if errors:
                grade.update(staticLandmarkCount=len(errors),staticLandmarkMedianErrorM=float(np.median(errors)),
                             staticLandmarkP95ErrorM=float(np.quantile(errors,.95)),staticConsistencyMedianM=float(np.median(consistency)),
                             staticConsistencyP95M=float(np.quantile(consistency,.95)))
        grades.append(grade)
    write_json(output/"sensor-estimates.json",dict(id=sensor["id"],split=split,records=records))
    write_json(output/"grades-evaluator-only.json",dict(id=sensor["id"],name=name,split=split,grades=grades,resets=resets))
    poses=[x for x in grades if x["status"]=="estimated"]
    applicable=[x for x in grades if x["status"]!="epoch-anchor"]
    trans=[x["translationErrorM"] for x in poses]
    rotations=[x["rotationErrorDeg"] for x in poses]
    landmark=[x["staticLandmarkP95ErrorM"] for x in poses if x["staticLandmarkP95ErrorM"] is not None]
    summary=dict(id=sensor["id"],name=name,split=split,frames=len(records),motionIntervals=len(applicable),estimatedIntervals=len(poses),
                 estimateCoverage=len(poses)/len(applicable) if applicable else 0,
                 unknownFrames=[x["frameId"] for x in records if x["status"]=="unknown"],
                 failures=[dict(frameId=x["frameId"],reason=x["failureReason"]) for x in records if x["failureReason"]],
                 maxTranslationErrorM=max(trans) if trans else None,p95TranslationErrorM=float(np.quantile(trans,.95)) if trans else None,
                 maxRotationErrorDeg=max(rotations) if rotations else None,
                 lastEstimatedTranslationErrorM=trans[-1] if trans else None,lastEstimatedRotationErrorDeg=rotations[-1] if rotations else None,
                 maxPerFrameStaticLandmarkP95ErrorM=max(landmark) if landmark else None,
                 dynamicInlierLandmarkObservations=sum(x["dynamicInlierLandmarkCount"] for x in grades),
                 medianProcessingMs=float(np.median([x["processingMs"] for x in records])),p95ProcessingMs=float(np.quantile([x["processingMs"] for x in records],.95)),
                 resets=resets)
    summary["finiteDiagnosticGatePassed"]=bool(summary["estimateCoverage"]>=.9 and trans and max(trans)<=.1 and max(rotations)<=2
                                               and all(x["oldJoin"]["status"]=="stale-epoch" and x["oldMapCleared"] for x in resets))
    write_json(output/"summary.json",summary)
    return summary


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--output",default=".runtime/experiments/jev-spatial-text-v1/motion")
    args=parser.parse_args()
    root=Path(args.output).resolve()
    root.mkdir(parents=True,exist_ok=True)
    configuration=freeze(root)
    summaries=[]
    for index,spec in enumerate(configuration["sequences"]):
        directory=render_sequence(root,spec,index)
        summary=run_sequence(root,directory,spec["split"],spec["name"])
        summaries.append(summary)
        write_json(root/"summary.json",dict(freezeSha256=sha(root/"freeze.json"),sequences=summaries,complete=len(summaries)==len(configuration["sequences"])))
        print(json.dumps(summary),flush=True)


if __name__=="__main__":
    main()

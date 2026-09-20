"""Frozen, bounded offline matching contrast. No API, hardware, downloads or tuning."""
from __future__ import annotations
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import platform
import shutil
import sys
import time
import cv2
import numpy as np
from pipeline import PARAMETERS, estimate, make_regions
from scenes import CALIBRATION, SUPERSAMPLING, render, specs
from evaluation import aggregate, grade

BASELINE_SHA="45334a119049e2c8e38c1142ad00e01fcb38380cac9c22449a9ca8c6665dd1c9"
ARMS=tuple(PARAMETERS)
ARRAYS=("rawLeft","rawRight","disparity","depth","rawValid","valid","leftRightErrorPx","textureStd")
GATE={"population":"each confirmation thin pole of width >=4 pixels, no skew",
      "minimumHazardRetainedFractionPerPair":.60,"minimumHazardCorrectNearFractionPerPair":.60,
      "maximumNearToFarSectorClaimsAcrossAllStaticThinPairs":0,
      "maximumFalseFarPixelsAcrossAllStaticThinPairs":0,"maximumP95ProcessToTextMs":250,
      "meaning":"exploratory engineering admission criterion, not a derived drone requirement or flight qualification; all-unknown cannot pass"}


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write(path,value):
    path=Path(path)
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(value,indent=2,allow_nan=False)+"\n",encoding="utf-8")


def inventory(root,subdirs):
    return [dict(path=p.relative_to(root).as_posix(),bytes=p.stat().st_size,sha256=sha(p))
            for sub in subdirs for p in sorted((root/sub).rglob("*")) if p.is_file()]


def freeze(root):
    if any(root.iterdir()):
        raise ValueError("Refusing nonempty output directory; use a fresh evidence directory")
    source=Path(__file__).parent
    if sha(source/"baseline_matching.py") != BASELINE_SHA:
        raise ValueError("Copied historical baseline hash mismatch")
    (root/"source").mkdir()
    files=[]
    for path in sorted(source.iterdir()):
        if path.suffix in (".py",".md"):
            shutil.copyfile(path,root/"source"/path.name)
            files.append(dict(path=path.name,sha256=sha(path)))
    (root/"opencv-build-info.txt").write_text(cv2.getBuildInformation(),encoding="utf-8")
    document=dict(frozenAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  sources=files,baselineOrigin="experiments/jev-spatial-text/stereo/matching.py",
                  baselineSha256=BASELINE_SHA,parameters=PARAMETERS,
                  calibration=CALIBRATION,supersampling=SUPERSAMPLING,cases=specs(),gate=GATE,
                  versions=dict(python=sys.version,opencv=cv2.__version__,numpy=np.__version__,platform=platform.platform()),
                  opencvBuildInfoSha256=sha(root/"opencv-build-info.txt"),
                  selection="All parameters fixed before development and confirmation; development is a mechanical sanity split, not tuned",
                  docs=["https://docs.opencv.org/4.13.0/d2/d85/classcv_1_1StereoSGBM.html",
                        "https://docs.opencv.org/4.13.0/d9/dba/classcv_1_1StereoBM.html"],
                  independentEnvironments=False,
                  assumptions=["Synthetic pinhole cameras, known perfect calibration and rectification, Lambertian textured planes",
                    "4x4 subpixel integration, no photon/read noise, lens distortion, rolling shutter or exposure mismatch",
                    "Shared texture seed within a factorial family; pixels, phases and scene factors are not independent environments",
                    "BM9 is an alternative matcher in the same OpenCV build, not an independent complete production stereo/VIO stack",
                    "Camera-forward axial depth, no ray-distance mixing; no full-sector-clear assertions",
                    "Mixed hazard pixels remain in every hazard denominator; metric depth errors use homogeneous footprints only",
                    "Recorded latency includes matcher construction, both matching directions, support and sector aggregation; excludes image rendering/loading, acquisition and logging"])
    write(root/"freeze.json",document)
    return document


def summaries(rows):
    result={}
    for arm in ARMS:
        selected=[r for r in rows if r["arm"]==arm and r["spec"]["split"]=="confirmation"]
        thin=[r for r in selected if r["spec"]["family"]=="thin"]
        useful=[r for r in thin if r["spec"]["widthPx"]>=4]
        totals=aggregate(thin)
        result[arm]=dict(allConfirmation=aggregate(selected),staticThin=totals,
                        byWidth={str(w):aggregate([r for r in thin if r["spec"]["widthPx"]==w]) for w in (1,2,4,8)},
                        skew=aggregate([r for r in selected if r["spec"]["family"]=="skew"]),
                        controls=[r for r in selected if r["spec"]["family"] in ("plane","blank")])
        checks=dict(usefulRetainedCoverage=all(r["grade"]["retained"]["hazardCoverage"]>=.60 for r in useful),
                    usefulCorrectNearCoverage=all(r["grade"]["retained"]["hazardNearOverAll"]>=.60 for r in useful),
                    zeroFalseFarSectors=totals["hazardSectors"]["nearToFar"]==0,
                    zeroFalseFarPixels=totals["retained"]["hazardFalseFarPixels"]==0,
                    boundedDesktopLatency=totals["latencyMs"]["p95"]<=250)
        result[arm]["gate"]=dict(checks=checks,passed=all(checks.values()),usefulCoverageCases=len(useful),
                                retainedCoveragePassedCases=sum(r["grade"]["retained"]["hazardCoverage"]>=.6 for r in useful),
                                correctNearCoveragePassedCases=sum(r["grade"]["retained"]["hazardNearOverAll"]>=.6 for r in useful))
    return result


def report(root,summary):
    out=["# Fresh thin-obstacle stereo contrast", "",
         "Executed 56 fresh rendered stereo pairs: eight development and 48 confirmation. Each pair was processed by SGBM5, SGBM3 and BM9 with identical downstream support and sector aggregation. No parameter was tuned after observing either split. This is a matcher ablation on a deliberately narrow synthetic renderer, not flight or production-stack qualification.","",
         "The static challenge crosses 1/2/4/8 pixel pole widths, 0/0.25/0.5 pixel phases and 3.6/5.2/7.3 m backgrounds. Near poles are 1.17 m axial depth. Eight separate cases cross 4/8 pixel poles with 0/5/20/50 ms camera skew at 1 m/s, plus three textured-plane and one blank control. Mixed pixels count as hazards whenever any of their 16 render samples hits the pole; only homogeneous footprints enter metric depth errors.","",
         "All arms use 128 disparities, one CPU thread, independent right matching, 1 pixel left/right tolerance, a 9 pixel texture standard deviation rule (minimum 5), 20% sector coverage, and a 12 pixel connected cluster. SGBM3 changes block size and its prescribed smoothness penalties together (P1=72, P2=288); SGBM5 keeps P1=200/P2=800. BM9 uses XSOBEL and disables its extra texture threshold so the same external texture rule applies. This is not a one-parameter block-size causal experiment.","",
         "[OpenCV documents](https://docs.opencv.org/4.13.0/d2/d85/classcv_1_1StereoSGBM.html) the block-based SGBM behavior and block-size-related penalties; [StereoBM](https://docs.opencv.org/4.13.0/d9/dba/classcv_1_1StereoBM.html) is a separate block matcher. Documentation was 4.13.0; the executed installed library was OpenCV 5.0.0. Exact settings and build/runtime identity are frozen locally.","",
         "## Static thin poles: confirmation", "",
         "| Matcher | Far sector claims / hazard sectors | False-far pixels / ALL hazard pixels | Retained hazard coverage | Correct-near / ALL hazard pixels | Overall coverage | p95 desktop ms | Gate |",
         "|---|---:|---:|---:|---:|---:|---:|---|" ]
    for arm,s in summary["arms"].items():
        a=s["staticThin"]; p=a["retained"]; q=a["hazardSectors"]
        out.append(f"| {arm} | {q['nearToFar']}/{q['total']} | {p['hazardFalseFarPixels']}/{p['hazardPixels']} | {p['hazardCoverage']:.1%} | {p['hazardNearOverAll']:.1%} | {p['overallCoverage']:.1%} | {a['latencyMs']['p95']:.1f} | {'PASS' if s['gate']['passed'] else 'FAIL'} |")
    out += ["","The frozen exploratory gate requires at least 60% retained and correct-near coverage on **each** >=4 pixel static pole, zero near-to-far sectors and zero false-far pixels across all static thin poles, and p95 desktop processing at most 250 ms. These thresholds prevent an all-unknown winner; they are not derived from an actual drone speed, braking distance or required detection envelope. Failed narrow poles remain failures even when wider poles improve.","",
            "| Matcher / width | Far sectors | Retained hazard % | Correct-near % | Unknown pixels | False-far pixels |",
            "|---|---:|---:|---:|---:|---:|"]
    for arm,s in summary["arms"].items():
        for width,a in s["byWidth"].items():
            p=a["retained"]; q=a["hazardSectors"]
            out.append(f"| {arm} / {width}px | {q['nearToFar']}/{q['total']} | {p['hazardCoverage']:.1%} | {p['hazardNearOverAll']:.1%} | {p['hazardUnknownPixels']} | {p['hazardFalseFarPixels']} |")
    out += ["","## Separate skew and controls","",
            "| Matcher | Skew false-far pixels / hazard pixels | Skew far sectors | Skew correct-near % |",
            "|---|---:|---:|---:|"]
    for arm,s in summary["arms"].items():
        p=s["skew"]["retained"];q=s["skew"]["hazardSectors"]
        out.append(f"| {arm} | {p['hazardFalseFarPixels']}/{p['hazardPixels']} | {q['nearToFar']}/{q['total']} | {p['hazardNearOverAll']:.1%} |")
    out += ["","Skew is a separate adverse measurement condition, not another static-pole sample. See per-case grades for 0/5/20/50 ms contrasts; apparent disparity combines baseline parallax with foreground movement.","",
            "| Matcher / control | Retained pixels | Homogeneous-depth p95 error m |",
            "|---|---:|---:|"]
    for arm,s in summary["arms"].items():
        for row in s["controls"]:
            p=row["grade"]["retained"]; sp=row["spec"]
            out.append(f"| {arm} / {sp['family']} {sp['backgroundM']}m | {p['overallCoverage']:.1%} | {p['p95AbsoluteErrorM'] if p['p95AbsoluteErrorM'] is not None else 'unknown'} |")
    out += ["","## What this can decide","",
            "A smaller block or alternative matcher can be compared for retaining a measured nearby surface, but no winner is forced when every arm violates the safety/coverage gate. One-pixel poles, mixed boundary footprints and nonsimultaneous images remain explicit failure populations. A far patch is never a clear-sector assertion, and quantile/disparity bands are not calibrated confidence.","",
            "The next discriminating test should hold the matcher fixed and separately cross image sampling/resolution and synchronization using fresh image pairs, then compare a pinned production stereo implementation on the same eligible physical recording. Include narrower projected hazards and image-derived edge/ambiguity support; any edge rule must process pixels without the evaluator hazard mask. Vary SGBM block size and smoothness penalties independently if attributing their individual effect matters. Define useful minimum projected hazard size and latency from the actual camera and flight envelope before promotion. The present experiment cannot establish that two arbitrary cameras reliably see every thin obstacle.","",
            "Raw PNGs and calibration are under inputs/, sensor-only numerical arrays and region text under results/, and evaluator masks/grades are separate files. freeze.json records source copies, settings and all planned cases before execution; manifest.json hashes every input/result. audit.json independently reconstructs image pairs, raw disparities, support masks, regions and grades from the frozen copy. Latency is measured once per arm/pair in rotated arm order; no hardware, acquisition age, power or thermal measurement was made.","",
            "Replay: `.runtime/vision-env/Scripts/python.exe experiments/jev-spatial-refinement/stereo/audit.py --output .runtime/experiments/jev-spatial-refinement-v1/stereo`. Fresh execution requires a new empty output directory. Historical F45 evidence remains unchanged."]
    (root/"report.md").write_text("\n".join(out)+"\n",encoding="utf-8")


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--output",default=".runtime/experiments/jev-spatial-refinement-v1/stereo")
    args=parser.parse_args()
    root=Path(args.output).resolve();root.mkdir(parents=True,exist_ok=True)
    frozen=freeze(root)
    rows=[]
    for i,spec in enumerate(frozen["cases"]):
        directory=root/"inputs"/spec["id"];directory.mkdir(parents=True)
        images,truth=render(spec)
        for eye,image in zip(("left","right"),images):
            if not cv2.imwrite(str(directory/f"{eye}.png"),image):raise ValueError("PNG write failed")
        write(directory/"calibration.json",CALIBRATION)
        write(directory/"spec-evaluator-only.json",spec)
        np.savez_compressed(directory/"truth-evaluator-only.npz",**truth)
        # Matching sees reloaded persisted sensor inputs, never the renderer's
        # spec, mask, ground truth or grading. Rotate order to reduce timing bias.
        left,right=[cv2.imread(str(directory/f"{eye}.png"),cv2.IMREAD_GRAYSCALE) for eye in ("left","right")]
        calibration=json.loads((directory/"calibration.json").read_text())
        for arm in ARMS[i%3:]+ARMS[:i%3]:
            start=time.perf_counter();result=estimate(arm,left,right,calibration)
            regions=make_regions(result,calibration);latency=(time.perf_counter()-start)*1000
            destination=root/"results"/spec["id"]/arm;destination.mkdir(parents=True)
            np.savez_compressed(destination/"estimated.npz",**{k:result[k] for k in ARRAYS})
            write(destination/"sensor.json",dict(id=spec["id"],arm=arm,calibration=calibration,
                  sourceSha256={eye:sha(directory/f"{eye}.png") for eye in ("left","right")},
                  regions=regions,depthConvention="camera-forward axial metres",
                  clearance="unknown; visible patches only",processToTextMs=latency))
            scored=grade(result,regions,truth)
            write(destination/"grade-evaluator-only.json",scored)
            rows.append(dict(spec=spec,arm=arm,grade=scored,processToTextMs=latency))
        print(json.dumps(dict(completedPair=i+1,total=56,id=spec["id"],split=spec["split"])),flush=True)
    summary=dict(freezeSha256=sha(root/"freeze.json"),pairs=len(frozen["cases"]),evaluations=len(rows),
                 developmentPairs=8,confirmationPairs=48,arms=summaries(rows),rows=rows)
    write(root/"summary.json",summary)
    report(root,summary)
    write(root/"manifest.json",dict(freezeSha256=sha(root/"freeze.json"),files=inventory(root,("inputs","results")),
                                  summarySha256=sha(root/"summary.json"),reportSha256=sha(root/"report.md")))
    print(json.dumps({a:v["gate"] for a,v in summary["arms"].items()}),flush=True)


if __name__=="__main__":main()

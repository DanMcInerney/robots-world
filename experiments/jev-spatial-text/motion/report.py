"""Summarize retained S07 evidence without changing estimates or scores."""
import argparse
import json
from pathlib import Path

import numpy as np

from render import write_json


def report(root):
    summary=json.loads((root/"summary.json").read_text())
    audit=json.loads((root/"audit.json").read_text())
    details=[]
    for sequence in summary["sequences"]:
        grades=json.loads((root/"results"/sequence["id"]/"grades-evaluator-only.json").read_text())["grades"]
        medians=[x["staticConsistencyMedianM"] for x in grades if x["staticConsistencyMedianM"] is not None]
        tails=[x["staticConsistencyP95M"] for x in grades if x["staticConsistencyP95M"] is not None]
        details.append(dict(id=sequence["id"],name=sequence["name"],maxFrameMedianStaticConsistencyM=max(medians) if medians else None,
                            maxFrameP95StaticConsistencyM=max(tails) if tails else None))
    write_json(root/"landmark-diagnostics.json",dict(records=details,meaning="static-only grading of repeat-measurement deviation from sensor-anchored landmark coordinates; not ground-truth filtering in estimation"))
    lines=["# S07 stereo motion diagnostic — 19 September 2026", "",
           "**S07 now has executed image-based motion evidence, but dynamic mapping remains unqualified.** In short ideal static sequences, stereo/KLT/PnP estimates follow translation, pure rotation and return, and an announced epoch reset rejects old map joins. A moving foreground object produces accepted poses wrong by up to 0.634 m and 4.19 degrees, plus eleven missing estimates. A successful static pose estimate is not a qualified persistent environment model.", "",
           "This follow-up is separate from the earlier frozen stereo/text campaign. It changes no stereo matcher source, sensor exports, text candidate, request or control. The original S07-unimplemented entry describes that earlier freeze; this later diagnostic adds evidence and retains its own freeze/results.", "",
           "## Frozen experiment", "",
           "Seven short sequences contain 137 stereo pairs (274 original PNGs): one 11-frame development translation and six 21-frame evaluation sequences. Evaluation uses fresh texture seeds and different motion/fault patterns but the same basic room layout; these are not six independent real environments or new-topology tests. Static surfaces include a textured wall, floor, side walls and foreground boards at different depths. Dynamic evaluation adds one independently moving textured foreground panel. Acquisition uses an ideal rectified 640×360 pinhole rig, f=400px, B=0.12m, sampled every 100ms. Rendering is ENU; the estimator map is an arbitrary local frame aligned to each epoch's first optical camera.", "",
           "Source and settings were frozen before rendering/estimation, development was executed first, and no thresholds were adjusted after observing it. The estimator receives only left/right grayscale images, calibration, opaque acquisition identity and an announced reset event. Rendered camera poses, depth and dynamic labels are separate evaluator inputs and never determine feature admission, estimated pose or landmark updates.", "",
           "The unchanged stereo module performs SGBM and left/right/texture validity checks. Depth-supported corners are tracked using pyramidal KLT with forward/backward checks. Their previous-frame stereo depth yields measured 3D points, and current image coordinates enter PnP RANSAC with LM refinement. Accepted relative transforms compose into the current map frame. Sparse landmark anchors and current measured points derive only from those estimates. No IMU, simulator pose, semantic segmentation, route, future motion, loop closure or hidden controller assists estimation.", "",
           "The predeclared finite diagnostic gate requires at least 90% current-pose coverage, maximum translation error at most 0.10m, maximum rotation error at most 2 degrees, and valid reset rejection. That tests these finite camera-pose traces; it does not include a calibrated landmark-accuracy gate and is not a flight-safety or mapping gate.", "",
           "## Per-sequence outcomes", "", "| Sequence | Estimated / opportunities | Max translation error | Max rotation error | Max per-frame static-landmark p95 error | Finite pose gate |", "|---|---:|---:|---:|---:|---|"]
    for x in summary["sequences"]:
        lines.append(f"| {x['name']} ({x['split']}) | {x['estimatedIntervals']}/{x['motionIntervals']} | {x['maxTranslationErrorM']:.4f} m | {x['maxRotationErrorDeg']:.3f}° | {x['maxPerFrameStaticLandmarkP95ErrorM']:.3f} m | {'pass' if x['finiteDiagnosticGatePassed'] else 'fail'} |")
    lines += ["", "Estimate opportunities exclude epoch-anchor identity poses. The reset sequence therefore has 19 opportunities; other 21-frame sequences have 20. Evaluation completes 105/119 current estimates, with 14 unknowns. Anchors are coordinate definitions and are not counted as motion-estimation successes. Source `summary.json` retains every frame ID and failure reason.", "",
              "Static evaluation translation traverses about 0.85m; its largest pose error is 2.26cm/0.391°. Pure yaw spans 20° with 1.02cm spurious translation and 0.133° maximum orientation error. Return travels 0.5m out and back, ending 1.14mm/0.017° from its initial pose in this short ideal sequence. There is no loop closure; this favorable return is not evidence of robust long-term drift correction.", "",
              "Sparse geometry is substantially worse than pose. Static landmark per-frame p95 world error reaches about 0.32m in translation/rotation/reset. Repeated measured points also move relative to their earlier sensor anchors: maximum per-frame p95 internal consistency residual is 0.326m for translation, 0.328m for pure rotation and 0.391m after the reset sequence. These are measurements of error, not calibrated uncertainty bounds. Aggregated map clarity must not be inferred from centimetre camera-pose error.", "",
              "The dynamic-foreground sequence retains 2,413 moving-panel inlier landmark observations. Nine accepted estimates include up to 0.634m translation error and 4.19° orientation error; frames 8–18 return unknown after their quality checks reject estimates. RANSAC/inlier concentration can follow a moving object and still report an apparently acceptable pose. After rejection, the old reference image remains dated and the current pose is null; no last pose is relabelled current. Later acceptance does not repair accumulated erroneous pose.", "",
              "The dropout sequence blacks out acquisitions 8–10. All three correctly produce unknown, preserving their failures in the denominator, and frame 11 recovers against the last accepted dated reference. Its maximum known-pose error is 2.38cm/0.368°; 85% coverage fails the declared 90% pose gate even though explicit unknown handling works. Missing frames are never interpolated or graded as perfect poses.", "",
              "At frame 10 of the announced reset, epoch 0 is revoked, all old map entries are cleared, the new image anchors epoch 1, and an attempted old-epoch lookup returns stale-epoch with a null position. This is a tested protocol boundary, not relocalization or a measured transform joining maps. A cross-epoch static landmark is deliberately unavailable.", "",
              "## Runtime, reproducibility and limitations", "",
              "Per-sequence median processing spans roughly 75–107ms, and p95 spans 80–132ms on this Windows desktop with the existing OpenCV environment. Processing excludes rendering, image reads and evidence writes. The offline sequence is not paced in real time; 100ms acquisition spacing does not establish a sustainable 10Hz perception loop, end-to-end age or onboard performance.", "",
              f"The read-only audit replayed all {audit['framesReplayed']} pairs, {audit['posesReplayedIncludingAnchors']} poses including coordinate anchors, {audit['unknownPosesReplayed']} explicit unknown poses, and {audit['landmarkObservationsReplayed']:,} landmark observations. Pose matrices reproduce within 1e-10 absolute tolerance, landmark coordinates within 1e-9; image hashes, raw stereo depth/masks, feature/inlier counts and reset rejection match. All four frozen numerical-source hashes match current code. Two mechanical tests also pass: a blank initial pair cannot invent an anchor, and reset invalidates old point authority. Audit success establishes reconstruction, not physical accuracy.", "",
              "These data contain no real camera motion, rolling shutter, IMU, hardware, real synchronization error or real dynamic scene. Sparse tracks are neither object identities nor dense persistent surfaces. No surface fusion, current occupancy, clearance, loop closure or robust recovery exists. Per-landmark anchor creation times are not individually exported; current observations and reference frames retain acquisition provenance. Lifetime/age and association contracts need further implementation before a persistent spatial-memory adapter uses these landmarks.", "",
              "The next dependency is to distinguish camera motion from moving-scene support, qualify actual camera recordings and a separately frozen pose/map uncertainty contract, then test resets, stale geometry and long gaps. The dynamic failure must remain in selection evidence. The earlier thin-pole/false-far stereo failures still block dependent obstacle-avoidance claims even where static pose estimation works.", "",
              "Files: `freeze.json`, `inputs/sequence-*/sensor-sequence.json`, original PNGs, separate evaluator truth files, `results/sequence-*/sensor-estimates.json`, `grades-evaluator-only.json`, stored stereo arrays, `summary.json`, `landmark-diagnostics.json` and `audit.json`. To restore the original relative source layout, place frozen `render.py`, `estimate.py`, `run.py` in a motion directory and frozen `stereo-matching.py` as sibling `stereo/matching.py`; hashes are listed in the freeze. Do not overwrite this completed run.", "",
              "Exact executed commands from C:/Users/danhm/tools/robots-world:", "", "```powershell",
              "& .runtime/vision-env/Scripts/python.exe -B -u experiments/jev-spatial-text/motion/run.py",
              "& .runtime/vision-env/Scripts/python.exe -B experiments/jev-spatial-text/motion/test_motion.py",
              "& .runtime/vision-env/Scripts/python.exe -B -u experiments/jev-spatial-text/motion/audit.py",
              "& .runtime/vision-env/Scripts/python.exe -B experiments/jev-spatial-text/motion/report.py",
              "git diff --check", "```", "",
              "No package installation, Jev request, hardware action, deletion or change to the frozen stereo pipeline occurred in this follow-up."]
    (root/"report.md").write_text("\n".join(lines)+"\n",encoding="utf-8")
    print(str(root/"report.md"))


if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--input",default=".runtime/experiments/jev-spatial-text-v1/motion")
    report(Path(parser.parse_args().input).resolve())

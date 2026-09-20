# Offline stereo qualification

This experiment estimates axial depth from stereo images with OpenCV SGBM. It does not call Jev, run a robot, estimate camera motion, or certify clearance. The optional existing `.runtime/vision-env` is used without changing packages. No world-core changes are involved.

Run from the repository root in PowerShell:

```powershell
& .runtime/vision-env/Scripts/python.exe -B experiments/jev-spatial-text/stereo/test_contract.py
& .runtime/vision-env/Scripts/python.exe -B experiments/jev-spatial-text/stereo/run.py --download --output .runtime/experiments/jev-spatial-text-v1/stereo-new
& .runtime/vision-env/Scripts/python.exe -B experiments/jev-spatial-text/stereo/export.py --input .runtime/experiments/jev-spatial-text-v1/stereo-new
& .runtime/vision-env/Scripts/python.exe -B experiments/jev-spatial-text/stereo/audit.py --input .runtime/experiments/jev-spatial-text-v1/stereo-new
```

`run.py` refuses an existing freeze. Development and evaluation cases are declared before matching; no settings are fitted or changed between them. The source snapshot and explicit parameters are saved with the evidence. Synthetic planes have independently rendered left/right optical views; only the renderer and grader read scene geometry. Every depth estimate comes from matching the images. Ground truth never rejects or corrects an estimate.

Public input is three [Middlebury 2014](https://vision.middlebury.edu/stereo/data/scenes2014/) calibrated scenes: Adirondack for development, Motorcycle and Pipes for evaluation, plus Motorcycle's alternate exposure. The officially linked [ZIP archives](https://vision.middlebury.edu/stereo/data/scenes2014/zip/) permit byte-range retrieval of the needed members when individual image/disparity URLs return HTTP 403. Downloads are capped at 200 MB across the recorded transfer manifest. SHA256 hashes cover both fetched archive ranges and extracted inputs. For these calibrations, baseline is converted from millimetres and depth uses `f × B / (disparity + doffs)`. Inputs are resized to 768 pixels wide with intrinsics/offsets transformed accordingly; GT resampling uses nearest neighbors to preserve invalid samples.

Raw 1/16-pixel disparity and its original sentinel mask are preserved. The retained mask adds independently computed left/right consistency, local image texture, positive depth denominator and search-range checks. Connected clusters of at least 12 pixels prevent an isolated near speckle from becoming the nearest observed patch. That rule preserves a one-pixel-wide *measured* vertical return; it cannot recover a pole the matcher has assigned background depth. The experiment measures that failure explicitly.

Each of nine horizontal image sectors contains support counts, valid coverage, overlapping invalidity reasons, all-return depth quantiles and a separate nearest supported cluster. Its reported interval is the cluster's 5th–95th percentile depth expanded by an assumed half-pixel disparity band. **This is not a calibrated confidence interval.** Near is below 1.5 m, mid is 1.5–3 m, far starts at 3 m; an interval crossing a boundary is `boundary`. Below 20% sector coverage, the depth statement is `unknown`. Every sector's clearance stays unknown, including sectors with far returns.

Use only `exports/sensor-records.json` for interpretation tests. It has opaque acquisition IDs and image paths, with no true scene ranges encoded in metadata. The original diagnostic files retain descriptive evaluator IDs. `exports/grades.json` is evaluator-only: `interpreterExpectedBin` grades reading the measured statement; `referenceNearestBin` grades physical correctness. Its optional `qualifiedEvidenceEligible` is **posthoc audited correctness, unavailable at runtime and never a perception confidence/filter**. All records, including unknown and wrong estimates, remain exported. Send all records when testing end-to-end interpretation; a correct reading of a wrong measurement is still a perception failure.

The first execution has 40 pairs, four development and 36 evaluation. The full frozen result is under ignored `.runtime/experiments/jev-spatial-text-v1/stereo/`. Its six held-out synthetic textured 1/2/4 m planes pass the narrow processing/coverage gate. The challenge gate fails: five nearest-sector near-to-far mistakes and 5,080 retained near-reference pixels assigned at least 3 m. It does not qualify obstacle avoidance. Middlebury error, exposure, skew, resolution and boundary results remain per scene in `summary.json`; the report distinguishes uncertainty from physical correctness.

S01–S06 have partial offline component evidence, not physical bench qualification. S08 has executable OpenCV/DepthAI conversion fixtures. WLS is unrun because `cv2.ximgproc` is absent. S07 is unimplemented: there is no actual feature-based ego-motion estimator or qualified motion-aware map. Transparent surfaces, real moving-camera recordings, temporal ghosting, hardware synchronization, power/thermal behavior and onboard latency remain unrun. Processing latency is desktop image-to-record timing, never recorded-camera acquisition age.

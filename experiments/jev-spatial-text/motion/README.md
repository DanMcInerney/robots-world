# S07 synthetic stereo motion diagnostic

This separate experiment estimates camera pose from actual rendered grayscale stereo images. It uses the unchanged stereo experiment's SGBM and validity rules, image-derived feature tracks, forward/backward optical flow checks, and PnP RANSAC with measured stereo depth. Accepted camera transforms compose into an arbitrary local map frame. Sparse landmarks retain their sensor-measured positions and current reobservations. Renderer poses, depth and dynamic labels enter grading only.

The renderer's world uses ENU metres. The estimator's map origin/orientation are defined by its first optical camera in each epoch; it receives no global pose. A reset clears map ownership and rejects cross-epoch joins. Unknown estimates contain `pose: null`. The last usable reference image remains available for subsequent recovery, with its original frame ID. Retained landmark positions describe earlier measured patches, not a current occupied map or clear volume.

Run from the repository root using the existing optional OpenCV environment:

```powershell
& .runtime/vision-env/Scripts/python.exe -B -u experiments/jev-spatial-text/motion/run.py --output .runtime/experiments/jev-spatial-text-v1/motion-new
& .runtime/vision-env/Scripts/python.exe -B experiments/jev-spatial-text/motion/test_motion.py
& .runtime/vision-env/Scripts/python.exe -B -u experiments/jev-spatial-text/motion/audit.py --input .runtime/experiments/jev-spatial-text-v1/motion-new
```

Existing freezes cannot be overwritten. Settings and source hashes are frozen before development and evaluation; no tuning occurs between them. Exact images, acquisition IDs, source hashes, disparity/depth masks, estimated poses, landmark observations and independent grades are retained under ignored runtime storage. Audit replays every image through the sensor-only estimator and compares poses, landmark coordinates, masks and failures.

The first execution contains 137 stereo pairs: one 11-frame development sequence and six 21-frame evaluation sequences. Static translation, pure yaw, return and announced reset have full estimate coverage. Dynamic foreground fails with erroneous accepted poses and missing estimates; blackout frames produce explicit unknowns. See the runtime report for exact denominators and error values. These are short sequences of ideal pinhole images sharing one scene layout with fresh texture seeds and motion patterns. They are not independent real environments, physical camera recordings, IMU/VIO, relocalization, production SLAM or hardware evidence.

Sparse landmark geometry is less accurate than camera pose. The implementation has no dynamic segmentation, loop closure, surface fusion, current occupancy/clearance, or robust long-term identity. Per-landmark creation timestamps are not separately exported; records retain current acquisition and reference-frame provenance. A future persistent geometry adapter must add explicit lifetime/age semantics before treating stored points as usable current evidence. Full moving-drone spatial memory remains unqualified, especially after the dynamic-outlier failure.

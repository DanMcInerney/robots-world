# Persistent image tracking

Optional experiment package; the world core and controller ports remain unchanged. Read the [predeclared plan](../../docs/jev-tracking-tests.md) and [failure log](../../docs/design-failures.md).

`profile.ts` acquires and records RGB independently of inference. `worker.ts` runs one bounded, optional OpenCV process: one in-flight frame plus one replaceable pending frame. `perception.py` sees pixels, calibration, measured camera orientation and pixel-derived colour regions, never goals or simulator object identities. Predictions remain separate from current detections. The delivered observation retains the original acquisition time; stale processed observations cannot authorize commands.

`design.ts` lets Jev bind a region, then answer the full physical controls and choose follow/search/reselect/hold. The direct and declared-servo arms have identical questions. The servo changes only camera setpoints, only on Jev follow of an observed selected region. It does not choose translation, targets, paths or recovery. `trial.ts` advances real-time physics during inference; `report.ts` reconstructs all recorded pixel processing, requests, mappings and applications before accepting a run. `analyze.mjs` and `report.html` are posthoc evidence tools, never controller inputs.

The optional Python environment is local `.runtime/vision-env`; this run uses OpenCV 5.0.0 and NumPy 2.5.3. NanoTrack's two official ONNX weights are used only in offline comparison, with hashes recorded in qualification results. They are not mandatory world dependencies. No edge-device or real-camera performance is claimed.

Paid inference is explicit, using a local ignored environment file. Use a new evidence directory for a new cohort; existing runs are never overwritten or retried automatically:

```powershell
node experiments/jev-tracking/offline.ts <new-root>/offline
.runtime/vision-env/Scripts/python.exe experiments/jev-tracking/qualify.py <new-root>/offline
node experiments/jev-tracking/run.ts freeze <new-root>
node --env-file=.env.jev.local experiments/jev-tracking/run.ts static <new-root>
node --env-file=.env.jev.local experiments/jev-tracking/run.ts development <new-root>
# Review development mechanics before the held-out cohorts; freeze any changes separately.
node --env-file=.env.jev.local experiments/jev-tracking/run.ts constant <new-root>
node --env-file=.env.jev.local experiments/jev-tracking/run.ts recovery <new-root>
node --env-file=.env.jev.local experiments/jev-tracking/run.ts goal-change <new-root>
node --env-file=.env.jev.local experiments/jev-tracking/run.ts rate20 <new-root>
node experiments/jev-tracking/analyze.mjs <new-root>
```

The root-wide input-token ceiling includes conservative reservations for cancelled calls whose billing is unknown. The initial 50M estimate was administratively amended to 75M for the first cohort, preserving the original freeze and recording the reason in `budget-amendment.json`; prompts, seeds and sample counts were unchanged. The runner uses the ceiling in that cohort's `freeze.json`. At most three worlds run at once; pacing lag above one second or an API/audit error stops further dispatch. Run stages sequentially so the shared budget ledger has one owner. A completed run is not necessarily a successful task.

After the first cohort's high-rate pacing failures, new freezes default to one concurrent world. Set `--concurrency=2` or `--concurrency=3` on the **freeze** command only to qualify a different execution load. This is an experiment-runner setting; it adds no world-core scheduler. A new source freeze is required, and the earlier failed runs retain their original three-world setting. At higher camera rates, a fixed three-frame history also spans less time, so the rate treatment changes temporal coverage as well as freshness.

The 3 s `smoke.ts` uses synthetic responses strictly for mechanical verification; its files and metrics are excluded from real-Jev results. The normal test suite never makes paid calls. Worker processing timings exclude the upstream colour detector and simulated rendering; they are not total perception latency or edge-board performance.

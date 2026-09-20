# Camera-only Jev control pilot

This implements the first stage of the [optics research](jev-optics-audit.md): compact observations from actual camera pixels, without a rangefinder or a learned depth model. It is a controlled colour-object task, not general vehicle recognition. No scripted mission controller competes.

See the [recorded results and diagnosis](jev-pixels-results.md) for the completed comparison and its audit amendments.

## Predeclared comparison

All arms receive the same 320×180 camera, broad HSV region detector, tentative image tracker, local flight plant, lossy MAVLink link and full controls. The detector has no goal, world handle, object labels, physical object size, range or depth. It ignores dim/low-saturation pixels and components smaller than 12 pixels; those are explicit blind spots. More than 24 regions produces a declared capacity failure instead of a goal-aware shortlist. All raw images are retained.

| Arm | Change from its comparison |
| --- | --- |
| Numeric | Six independent control Choices; numeric image bearings and apparent width. |
| Words | Same current measurements expressed with left/right/above/below words. Compare with Numeric. |
| History | Words plus up to three prior pixel-derived measurements and their ages. Compare with Words. |
| Joint XY | Same History input; all 49 forward/right velocity pairs in one Choice. Compare with History. |
| Conditional | Same History input; context Choice plus six control questions for search and each current region. Execute only Jev's selected context. Compare with History. |

Every movement branch permits 7×7×7×9×7×2 = 43,218 tuples. The 255 limit applies per Choice. Body forward/right velocities convert to ENU using only the delivered onboard heading estimate. Camera deltas apply once to the delivered angles. Commands last one second; the link streams only unexpired commands. No confidence gate changes Jev's choice. Invalid responses fail explicitly, without model retries.

Velocity uses the existing binary MAVLink setpoint path. Camera settings travel as dated local JSON attached to that setpoint, not a qualified MAVLink gimbal interface. A real autopilot and camera need their corresponding adapters.

The model is pinned to `jev-1.13.0`. Sensor acquisition is 5 Hz, with 100 ms delivery latency, 2% dropout, pixel noise and changing brightness. Requests start no faster than every 250 ms. Physics advances at 50 Hz throughout inference. The sensor's processing times are measured on this desktop; there is no claim of measured onboard power or performance.

Heading and camera pitch accompany the image as simulated onboard attitude/gimbal estimates, with ±0.5° and ±0.25° noise respectively. They are not inferred from RGB alone. A hardware adapter would need corresponding calibrated flight-controller/IMU and camera-mount readings. There is no global position measurement or metric depth in the controller input.

The operator asks Jev to follow the blue object, keep its centre within the central 30% of the image horizontally/vertically, use wide FOV, and maintain apparent width of 8–14%. Halfway through, the requested width becomes 14–22%. The blue target moves and changes course; cyan/orange/magenta objects are distractors. Some are obstacles and one obstacle moves. The initial heading offset is a fixed 45° relative to scenario rotation, shared across arms, not a target-dependent controller. This pilot is not a random-heading search qualification.

## Score and audit

Each phase needs at least 50% framed time after a five-second warmup, plus one uninterrupted second framed. A flight also needs no collision, boundary violation or controller failure. The evaluator uses target centre-ray visibility and its projected box width; partial silhouette visibility is approximated. These privileged measurements never enter the controller. Both phase-level and aggregate results remain visible; there is no claim that the old rover-relative test's score is comparable.

The inherited arena bounds are ±18 m horizontally and 0.7–6 m altitude. Those absolute coordinates are not observable through this sensor configuration. Boundary counts therefore diagnose the test environment, not the controller's ability to honor a supplied position constraint. Inspect framing and collisions separately from the composite pass flag; a later boundary-navigation task needs observable boundary cues or a declared position sensor.

The report includes displacement/path length, fraction of model decisions choosing translation, blue-region detection availability, framing, collisions, API latency, age of the image at command application, measured perception runtime and input tokens. Hold-heavy failures remain in the results. Saved PNGs are independently replayed through the tracker, and exact requests, model choices, mapped values and submitted commands are reconstructed and checked before publishing each run report.

The flight controller still supplies idealized stabilization and hold; real velocity estimation, wind, motor dynamics, textures, rolling shutter and motion blur are not implemented. There is no learned semantic detector or depth model in this round. This qualifies a compact perception/control arrangement before adding those costs.

## Run and inspect

Native inference is explicit and uses the ignored credential file. These commands create new evidence directories and do not overwrite a prior run:

```powershell
node --env-file=.env.jev.local experiments/jev-pixels/run.ts --phase development --seeds 81 --seconds 20 --output .runtime/experiments/jev-pixels-development-v1
node --env-file=.env.jev.local experiments/jev-pixels/run.ts --phase held-out --seeds 1201,1202,1203 --seconds 40 --freeze .runtime/experiments/jev-pixels-development-v1/freeze.json --output .runtime/experiments/jev-pixels-held-out-v1
```

The source/config freeze must match. Every arm is retained, rotating its order by seed. Stop the batch on infrastructure/model errors or the declared token budget; keep incomplete attempts. Three held-out seeds provide exploratory evidence, not a strong generalization estimate.

Open `/pixels.html?report=/.runtime/experiments/jev-pixels-held-out-v1/report.json` in the running Robots World host. The report aligns the 3D replay with actual sensor-image overlays and the exact model/command records. The 3D rendered camera preview is an inspector view; the PNG is the actual perception input.

### Recorded audit amendment

The first held-out batch stopped after its first completed flight because strict equality distinguished JavaScript `-0` from the `0` stored in JSON. Only `experiments/jev-pixels/report.ts` changed: reconstructed commands now pass through their JSON wire representation before comparison. A source-snapshot comparison verified that the controller, perception, scenario, physics and scoring were byte-for-byte unchanged. The regression fixture exercises movement and zero-valued holds at the affected heading.

The original attempt remains in `jev-pixels-held-out-v1`, including its stopped report and trace. `recovered-report.json` re-audits that trace and reconstructs its controller statistics; it is separate from the matched comparison. The restarted matrix uses `freeze-audit-v2.json` beside the development freeze and writes `jev-pixels-held-out-v2`. Use that report for the full comparison:

```powershell
node --env-file=.env.jev.local experiments/jev-pixels/run.ts --phase held-out --seeds 1201,1202,1203 --seconds 40 --freeze .runtime/experiments/jev-pixels-development-v1/freeze-audit-v2.json --output .runtime/experiments/jev-pixels-held-out-v2
```

These freezes and traces are local ignored evidence, not bundled source fixtures. The CLI requires a new output directory for a repeat. This audit amendment was not a prompt or behavior revision based on held-out performance.

A second signed-zero mismatch in a rounded camera pitch required the same JSON normalization for reconstructed requests and replayed pixel measurements. The main matrix retained its completed flights, recovered flight 12 from the raw trace, and continued only the three missing flights. The final audit-only freeze is `freeze-audit-v3.json`; use it with a new output directory for future repeats. Details and retained artifacts are listed in the results document.

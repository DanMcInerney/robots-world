# Scouting a moving target through obstacles

**Designed, not yet a real-Jev result.** The prior `klt-servo-1804` was useful camera tracking in an open arena. It did not qualify scouting, routing or recovery. [Failures F20–F24](design-failures.md) motivate this separate experiment; old results stay frozen.

## Task and scenes

Give the exact English goal in [scenario.ts](../experiments/jev-scout/scenario.ts): find the moving blue object in unfamiliar space, follow, recover when lost, keep its visible centre in the central 30% and visible width at 8–14%, wide FOV, avoid contact. It does not reveal where to search, the route, seed or cover timing.

| Case | Starts | Required challenge | Fixed-observer check |
| --- | --- | --- | --- |
| Turn to find | Target outside camera view | Choose camera direction to discover it | Target never appears while waiting |
| Behind wall | Target behind an opaque seven-metre wall | Change viewpoint around an edge | Neither waiting nor turning at spawn can see it |
| Occlusion course | Target behind the wall | Follow around structures and recover repeated losses | Some natural reappearances are expected and recorded |

120 s each; target speed 0.30–0.45 m/s with seeded pauses at turns. Static walls and crates cause actual rendered occlusion and physical drone contacts. Target paths use clear corridors; the target never teleports or reacts to the drone. Mirrored/rotated layouts and wall widths vary by seed. No cover is inserted around a target and no reset rescues a lost track. The target is a uniquely blue box proxy, not qualified semantic vehicle recognition. The renderer is a synthetic box renderer, not photorealistic optics; dynamics remain simplified.

## Exactly what the controller gets

- Recorded 320×180 RGB at requested 5 Hz, 100 ms delivery delay, 2% dropout, measured camera heading/pitch with noise. OpenCV KLT and neutral-edge components process only actual images and calibration. This still assumes onboard attitude estimation and a stabilized flight controller, not a bare camera-only aircraft.
- Current visible pixel regions: appearance, image bearing, visible width, clipping and fallible occlusion flags. IDs can change. No complete object size, range, pose, map, hidden ID, future path or free-space certification.
- Last two command receipts. Those describe requested/accepted controls, not achieved navigation or collision-free paths. Existing feedback waits use own actuator telemetry; acquisition continues during inference.
- **Current-image arm:** no retained view/region history in Jev input. **Memory arm:** at most 12 delivered camera views sampled at least 1 s apart and 24 last-seen regions, at most 30 s old. Actual acquisition time and historical camera orientation are preserved. Missing regions' current locations remain unknown. KLT itself is the same stateful perception in both arms.

No rangefinder in either arm. Neutral components are fallible visual surface evidence, not semantic obstacles or metric clearance. Big blank surfaces may not generate a component; qualify that limitation before judging navigation failures. Memory records only images actually delivered to the decision loop, never unseen background samples or a truth-derived occupancy map.

## Search without the binding deadlock

Every Jev call has one mode question: search, hold, or any of the current observed regions. Search always has six full conditional controls: forward/right/up velocity, yaw/pitch increment, FOV. They preserve **7 × 7 × 7 × 9 × 7 × 2 = 43,218** combinations, with at most nine options per physical question.

Every observed region gets three conditional translation questions, each embedding that region's measured record. There is no model-independent shortlist. With N regions the request has **7 + 3N questions**, up to 79 for the existing 24-region sensor bound. Selecting a region explicitly authorizes the same declared bearing-based camera servo in both arms; Jev chooses translation. The servo never searches, routes or identifies a target. Search maps exactly the six selected values. Zero retains accepted camera angles. Responses cannot depend on sibling answers: every conditional question states its assumption.

This tests practical scouting with the previously useful camera assistance. It does not claim Jev computes every camera correction. A direct-camera comparison is a later separate ablation, not silently substituted here.

## Gates, comparison and stopping

1. Offline mechanics: first **delivered valid** image has no blue target; all target motion respects its speed limit and swept clearance; hold counterfactuals cannot solve the first two scenes; offline alternative viewpoints and padded routes are clear. The privileged geometric witness demonstrates feasibility only, not a sensor-only controller's ability to navigate it.
2. Interface/unit checks: search actuates with zero regions, unused branch answers do not affect the command, servo requires a Jev-selected current region, memory expires/caps/resets, partial visibility uses actual visible width, losses and collisions cannot earn mission passes.
3. Short synthetic spin runs exercise real camera/KLT/transport/audit, explicitly labelled no inference and not competing policies. Review the joined candidate before a real run. Inspect neutral-obstacle coverage in actual requests and pacing, not just rendered pictures.
4. Real API stage is explicit `--real`, one world at a time. Two development seeds 2101–2102 × three cases × two arms. If questions need revision, record a new source/plan freeze; do not tune held-out seeds. Held-out seeds 2201–2204 are then four matched pairs per case, all outcomes retained. Alternating arm order is not currently implemented: current-image runs before memory within each seed, a service-order limitation to report.

The complete planned matrix is 36 flights of 120 s, but stages run one case at a time; none has been launched in this design round. A conservative 25M input-token ceiling bounds the frozen campaign, with canceled calls reserved. A service/schema/pacing/trace failure stops the stage and remains invalid rather than becoming a policy failure. No retries/replacement seeds. A budget stop leaves the matrix incomplete. Fresh runs cannot overwrite evidence. Native agent/Claude/Codex and hardware comparisons are outside this round.

## Scores and evidence

Use the uniquely blue **visible pixel patch**, not hidden complete size or a centre ray, for detection and image-framing scores. Missing/ambiguous detections earn no visibility credit. Report acquisition latency, longest framing dwell, post-acquisition visibility/centring/framing fractions, every ≥1 s loss and recovery delay, and unresolved losses. Inter-sample credit is capped at 250 ms so drops do not earn imaginary dwell. Longer internal gaps and an unrecorded tail explicitly count as unknown camera coverage and toward the loss duration; they are not labelled physical occlusion.

Mission PASS requires detection by 45 s, ≥30 s remaining, ≥40% post-acquisition visible-patch framing, ≥2 s continuous framing, no loss longer than 20 s, and zero contact/bounds/controller-error ticks. A run without acquisition fails. Bounds remain the inherited physical diagnostic (|x|,|y|≤18 m, 0.7≤z≤6 m); enclosing walls lie within that envelope. Framing includes correct centre, width, unclipped patch and wide FOV. “Tracking passed” is no longer substituted for the mission.

Keep the fixed-observer counterfactual with each scene. Report selected search versus **actually applied** search, camera changes and translation; these counts do not prove that a particular recovery was caused by searching. In the occlusion course the target can reappear without action. A causal policy claim would require an additional matched intervention.

Save PNGs, raw and processed observations, exact requests/full options/probabilities, mapped branch, declared assistance, MAVLink bytes, admission/application timestamps, feedback waits, collisions, own trajectory, evaluator-only target route, source freeze and costs. Reconstruct every PNG, Python output, request and mapped action. Invalid attempts and interruptions stay visible. The existing replay displays physical camera previews separately from the actual PNGs; spectator state never enters requests.

## Commands

```powershell
node experiments/jev-scout/qualify.ts .runtime/experiments/jev-scout-qualification-v3
node experiments/jev-scout/run.ts smoke .runtime/experiments/jev-scout-smoke-v1 --case=behind-wall
node experiments/jev-scout/run.ts freeze .runtime/experiments/jev-scout-v1
# Only when intentionally starting real paid inference:
node --env-file=.env.jev.local experiments/jev-scout/run.ts development .runtime/experiments/jev-scout-v1 --case=behind-wall --real
```

Qualification creates a local `index.html` with moving-world preview, actual fixed-observer camera frames, counterfactual statistics and offline witness images. Paid runs use `/pixels.html?report=/.runtime/experiments/jev-scout-v1/development-behind-wall/report.json`. No new world-core or Nervelet behavior is required: scenario, stimulus, perception, policy and scoring stay in experiment modules.

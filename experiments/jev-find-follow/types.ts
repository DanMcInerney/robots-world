/** Shared types for the find-follow closed-loop episode engine.
 *
 * See the coordinator report (returned by this assignment) for the architecture summary. In
 * short: a scenario-pluggable engine that closes the loop on the 3D car with the real
 * perception stack, in latency-faithful SIMULATED time (not wall-clock) — see scheduler.ts.
 *
 * Request/response types are re-exported from jev-strategies/strategies.ts (not redefined) so the
 * real Jev controller (implemented, not run this stage) can use the exact same shared transport
 * meter/ledger as experiments/jev-scout-encodings/run.ts, with no structural drift.
 */
import type { StereoObject, StereoObjectsFrameRecord } from '../../integrations/stereo-objects.ts';

export type { StereoObject, StereoObjectsFrameRecord };

/** Structurally compatible with jev-strategies/strategies.ts's `Request`/`Response` (model:
 * string, state: unknown, questions: Record<string, {type,instructions,criteria}>), so the same
 * object can be handed to experiments/jev-spatial-text/transport.ts's `createMeter().judge()` and
 * experiments/jev-pixels/controller.ts's `callJev` (the real Jev controller's exact transport,
 * implemented in controllers/jev.ts but not run this stage). Declared narrower here (criteria are
 * always plain-string option descriptions, per the winning encodings in scout.ts/range.ts) because
 * this engine only ever asks Choice questions with string criteria. */
export interface ChoiceQuestion { type: 'choice'; instructions: string; criteria: Record<string, string> }
export interface DecisionRequest { model: 'jev-1.13.0'; state: Record<string, unknown>; questions: Record<string, ChoiceQuestion> }
export interface ChoiceAnswer { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
export interface DecisionResponse { model: string; answers: Record<string, ChoiceAnswer>; usage?: { input_tokens?: number }; synthetic?: boolean }

/** A goal description. Code-owned binding (see target-binder.ts) maps this onto sensor objects;
 * it is never simulator/target-identity truth. */
export interface Goal {
  /** Detector class names that count as a match, e.g. ['car']. Vehicle-like by convention; the
   * engine does not restrict this beyond what the detector actually reports. */
  classes: string[];
  /** Optional dominant-colour match (see the sensor's generic `dominantColor` field). */
  colour?: string;
  /** Human-readable phrase used verbatim in encoder text, e.g. "the blue car". */
  description: string;
  /** Requested follow distance in metres (track encoder's range question). */
  requestedRangeM: number;
}

/** Operating-envelope bounds, stated numerically in every goal sentence (increment B1 / the
 * ladder's "harmful events" section: "every goal sentence states the operating envelope
 * numerically") and checked per-acquisition by scoring.ts's own `envelopeViolations` counter.
 * Structurally identical to scoring.ts's own `EnvelopeBounds` (kept as a separate declaration, not
 * imported, since scoring.ts is declared never-imported-by-encoders/controllers — see scoring.ts's
 * own module docstring and checks.ts's structural scan). */
export interface EnvelopeBounds { minAltitudeM: number; maxAltitudeM: number; maxRadiusFromOriginM: number }

export type Vec3 = { x: number; y: number; z: number };
export type XYZ = [number, number, number];
export interface RenderPose { position: XYZ; yaw_rad: number; pitch_rad: number; roll_rad: number }

/** Own-state as delivered to the controller: noisy, declared, never simulator-exact. */
export interface OwnState {
  headingDeg: number;
  altitudeM: number;
  /** Cumulative displacement since episode start, own frame, metres — used to age/invalidate
   * sector memory as the platform moves (F75's sector-memory-not-reprojected caveat, addressed). */
  odometryDisplacementM: { x: number; y: number };
  acquiredSimMs: number;
}

export type ClearanceStatus =
  | { status: 'open'; toM: number; ageMs: number }
  | { status: 'blocked'; atM: number; ageMs: number }
  | { status: 'unknown' };

export interface SectorCandidate {
  description: string;
  bearingDeg: number;
  rangeM: number | null;
  lastSeenAgeMs: number;
}

export interface SectorFact {
  index: number;
  centerHeadingDeg: number;
  inspectedAgeMs: number | 'never';
  clearance: ClearanceStatus;
  candidate: SectorCandidate | null;
}

/** Target binder output. `ambiguous` names every matching candidate; the binder never guesses. */
export interface BindResult {
  status: 'bound' | 'ambiguous' | 'none';
  candidates: { objectIndex: number; class: string; colour: string | null; score: number; bearingRightRad: number; bearingUpRad: number; rangeM: number | null }[];
  boundIndex: number | null;
}

export interface LastSeenRecord {
  /** WORLD-frame bearing (ENU degrees, [0,360)) of the sighting — `wrap(ownHeading -
   * bearingRight)` at the acquisition instant, NOT the raw camera-relative bearing (an independent
   * design review's finding 4: the producer previously stored the camera-relative value and
   * consumers read it as a world heading, which is why turn-to-find never reacquired). See
   * camera-geometry.ts's `worldBearingDeg`. */
  bearingDeg: number;
  rangeM: number | null;
  ownHeadingDegAtSighting: number;
  acquiredSimMs: number;
  ageMs: number;
  /** Own WORLD position (declared, own-state-derived — droneInitialPosition + odometryDisplacementM
   * at the sighting's altitude, never simulator-exact) at the moment of this sighting. Lets a later
   * decision reproject this sighting's bearing/range onto a PREDICTED future own-pose (own
   * translation since the sighting included), the same machinery a fresh bind uses — see
   * camera-geometry.ts's `worldPositionFromBearing`/`bearingAndRangeFromWorldPosition` and
   * episode.ts. */
  ownPositionAtSightingM: Vec3;
}

export type Mode = 'track' | 'search';

export interface ManeuverDef {
  kind: 'yaw' | 'hold' | 'translate' | 'altitude' | 'speed_hold';
  yawDeg?: number;
  /** Direction offset in degrees relative to current heading, for 'translate'. */
  directionOffsetDeg?: number;
  distanceM?: number;
  /** Absolute closing speed (m/s) along the current bearing to the target, for 'speed_hold' —
   * the ladder's follow-action model: a forward-speed setpoint held by the flight-controller loop
   * under lease until superseded, replacing the fixed-distance range menu on any moving-target
   * rung (the fixed-distance menu is retained only for a stationary-target sub-rung). */
  speedMps?: number;
  label: string;
}
export type ManeuverMenu = Record<string, ManeuverDef>;

export type ControllerId = 'passive' | 'synthetic' | 'reference' | 'jev';

/** One controller call in a decision cycle, with every clock the ladder spec requires logged
 * separately. `wallMs` fields are real measured wall time, recorded but never fed back into the
 * simulated-time bookkeeping (determinism given seed + controller responses). */
export interface DecisionRecord {
  index: number;
  mode: Mode;
  /** Why determineMode (encoders/mode.ts) chose this mode — code-derived, recorded so the
   * report/viewer can show the mode-switch reasoning per decision (an independent design review's
   * point: "mode-switch thresholds ... recorded per decision"). */
  modeReason: string;
  acquiredSimMs: number;
  observationAvailableSimMs: number;
  dispatchedSimMs: number;
  returnedSimMs: number;
  appliedSimMs: number;
  acquireWallMs: number;
  perceptionWallMs: number;
  controllerWallMs: number;
  cycleWallMs: number;
  /** Camera-grid boundaries latest-wins-skipped during THIS decision cycle only — a per-decision
   * count, NOT a running episode total: episode.ts resets its counter after every decision, so the
   * episode total is the SUM across decisions (scoring.ts's `score.skippedAcquisitions`), never the
   * last decision's own value. */
  skippedAcquisitions: number;
  /** How many camera acquisitions were folded into this decision cycle (>=1) — decoupled
   * acquisition/decision cadence (engine-review-e1 finding 3): every one of them updated derived
   * state (binder/last-seen/sector-memory/rate-estimate/appearance events), but only the freshest
   * fed this decision's request. */
  acquisitionsThisCycle: number;
  request: DecisionRequest;
  response: DecisionResponse;
  chosenManeuver: string;
  /** Structured chosen-option ids for track mode (null in search mode) — used by scoring.ts's
   * consequence-fidelity check without re-parsing `chosenManeuver`. */
  chosenYawId: string | null;
  chosenRangeId: string | null;
  /** The RobotPort receipt's own status at admission time (src/contracts.ts's `Receipt`) — never
   * a speculative guess about eventual completion, which is not knowable synchronously. */
  maneuverOutcome: 'accepted' | 'completed' | 'rejected' | 'duplicate';
  maneuverVeto: string | null;
  /** engine-review-e1 finding 1: true when the world rejected this decision's command for a reason
   * OTHER than a declared executor veto (`maneuverVeto`) — e.g. the pre-repair 128-event backlog
   * fault. Any true value here invalidates the episode's validity (scoring.ts/WORKLOG.md). */
  unexpectedRejection: boolean;
  /** `RobotPort.observe()`'s own `fault` string at the time this cycle acknowledged events, or
   * null. Recorded even though `acknowledge()` clears it, so the report shows a fault ever having
   * occurred (finding 1). */
  observedFault: string | null;
  /** engine-review-e1 finding 3: true when this decision's controller call exceeded the
   * controller's own declared `realLatencyClampMs` maximum — a logged timeout, not a throw; the
   * declared safe behaviour is to clamp the SIMULATED controllerLatencyMs to that maximum. */
  controllerLatencyTimedOut: boolean;
  ownState: OwnState;
  /** Own pose (world position + heading) at the FRESHEST acquisition this decision consumed. */
  acquisitionPose: { position: Vec3; headingDeg: number };
  /** Own pose (world position + heading) PREDICTED for this decision's own command-application
   * instant, computed by advancing the real world under the previous command BEFORE this decision's
   * request was built (engine-review-e1 finding 2) — the baseline every per-option consequence in
   * the request was actually computed from, not the acquisition-time pose. */
  predictedApplicationPose: { position: Vec3; headingDeg: number };
  bind: BindResult;
  /** Convenience copies of `bind.candidates[bind.boundIndex]`'s bearing/range when bound, null
   * otherwise — scoring.ts reads these directly rather than re-deriving the index lookup. */
  boundBearingRightRad: number | null;
  boundRangeM: number | null;
  /** Where the request's track/search baseline came from (mirrors encoders/track.ts's
   * `evidenceSource`; search mode records 'bound' when currently visible, else 'none'). */
  evidenceSource: 'bound' | 'last-seen' | 'none';
  frameRef: { left: string; right: string; seq: number } | null;
}

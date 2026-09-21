/** Action layer: bounded maneuvers executed by a declared flight-controller loop. Jev (or the
 * plugged-in controller) chooses among a small menu; this module ONLY translates the chosen
 * maneuver id into RobotPort commands to completion or lease expiry — it never picks the
 * maneuver. This is declared assistance at the flight-controller level (PRINCIPLES.md #4).
 *
 * Reuses src/models/mobile.ts's existing `drone` model commands directly (an independent review
 * of the existing designs found this is "sufficient for flight-controller-level execution of a
 * bounded maneuver" and recommended reusing it rather than writing a new plant):
 *  - yaw maneuvers -> one `velocity` command with a computed yawRate, `validForMs` set to EXACTLY
 *    the time needed to complete the turn (not the full decision lease): at that command's own
 *    expiry, src/world.ts's World applies its already-tested declared safe behaviour
 *    (`robot.plant.stop()`, which holds position/heading) automatically — so no separate
 *    "turn, then hold" choreography is needed; the maneuver's own bounded lease IS the completion
 *    mechanism, matching item 5's "to completion or lease expiry" literally.
 *  - translate maneuvers (approach/retreat/strafe) -> one `goto` command to a computed ENU target
 *    (current position + distance along the requested direction, altitude held fixed); `goto`'s
 *    own `completed()` check (src/models/mobile.ts) already reports arrival, and its proportional
 *    servo naturally settles and holds at the target without needing the lease to expire.
 *  - hold -> the `hold` action.
 * A veto (e.g. refusing to translate into measured-blocked clearance) is a LOGGED guard that
 * counts against the controller's choice, never a silent substitution of a different maneuver.
 */
import type { Command, Json } from '../../src/contracts.ts';
import type { ManeuverDef, ManeuverMenu } from './types.ts';

// FAILURES.md #4 / engine-review-e1 finding 2: at 60deg/s (and then 120deg/s), a menu option's
// NOMINAL duration (angle/rate) was not itself a multiple of the 20ms physics tick, so its ACTUAL
// executed duration was always rounded UP to the next tick boundary — a 10deg turn at 120deg/s
// (nominal 83.33ms) actually ran for 100ms (5 ticks), executing 12deg, not 10.
//
// engine-review-e2 finding 8: the E2 fix (250deg/s) made every menu magnitude land on an exact
// tick boundary, but a rate that instantly snaps to 250deg/s (10deg in 40ms) with no motion blur
// is not physically motivated, is not in the ladder's parameter table, and — worse — was fast
// enough that every yaw finished within one decision period, which structurally HID the
// supersession/execution-fidelity bug finding 2 (E3) found (a yaw sharing a lease with a range/
// speed axis cuts the other axis off at the yaw's own completion). `DEFAULT_YAW_RATE_DEG_S` is now
// a declared, OVERRIDABLE scenario parameter (see episode.ts/scenarios.ts): 100 deg/s, chosen as a
// middle ground between a slow "cinematic" gimbal/body yaw (~30-60 deg/s on typical consumer
// camera drones) and a fast "sport" yaw (200-400+ deg/s) — fast enough to reorient toward a lost
// target within a search episode's time budget, slow enough that yaw options above ~30deg
// routinely exceed one decision period (60deg -> 600ms, turn_180 -> 1800ms), so the loop's
// completion-gating (episode.ts's `pendingBoundedUntilSimMs`) and the axis-decoupling fix below are
// actually exercised by the two required smoke scenarios, not hidden by an unrealistically fast
// default. Declared limitation: yaw ACCELERATION is still unbounded (instant rate change) — real
// yaw acceleration limiting was assessed as not cheap to add correctly (it would require a
// trapezoidal velocity profile inside `src/models/mobile.ts`, outside this module's owned plant
// reuse), so it is not implemented; this is an unmodelled realism gap, stated rather than silently
// assumed away. 100 keeps exact tick alignment: 100deg/s * 20ms/tick = 2deg/tick, so every current
// menu magnitude {10,30,60,90,180} (all multiples of 10, hence of 2) lands on an exact tick
// boundary with zero quantisation error, exactly as 250 did.
export const DEFAULT_YAW_RATE_DEG_S = 100;

export const DEFAULT_MENU: ManeuverMenu = Object.freeze({
  yaw_left_10: { kind: 'yaw', yawDeg: 10, label: 'Yaw 10 degrees left' },
  yaw_left_30: { kind: 'yaw', yawDeg: 30, label: 'Yaw 30 degrees left' },
  yaw_left_60: { kind: 'yaw', yawDeg: 60, label: 'Yaw 60 degrees left' },
  yaw_left_90: { kind: 'yaw', yawDeg: 90, label: 'Yaw 90 degrees left' },
  yaw_right_10: { kind: 'yaw', yawDeg: -10, label: 'Yaw 10 degrees right' },
  yaw_right_30: { kind: 'yaw', yawDeg: -30, label: 'Yaw 30 degrees right' },
  yaw_right_60: { kind: 'yaw', yawDeg: -60, label: 'Yaw 60 degrees right' },
  yaw_right_90: { kind: 'yaw', yawDeg: -90, label: 'Yaw 90 degrees right' },
  turn_180: { kind: 'yaw', yawDeg: 180, label: 'Yaw 180 degrees' },
  hold: { kind: 'hold', label: 'Hold position and heading' },
  approach_1m: { kind: 'translate', directionOffsetDeg: 0, distanceM: 1, label: 'Move 1 m toward the camera-heading direction' },
  approach_2m: { kind: 'translate', directionOffsetDeg: 0, distanceM: 2, label: 'Move 2 m toward the camera-heading direction' },
  retreat_1m: { kind: 'translate', directionOffsetDeg: 180, distanceM: 1, label: 'Move 1 m opposite the camera-heading direction' },
  retreat_2m: { kind: 'translate', directionOffsetDeg: 180, distanceM: 2, label: 'Move 2 m opposite the camera-heading direction' },
  strafe_left: { kind: 'translate', directionOffsetDeg: 90, distanceM: 2, label: 'Move 2 m sideways left (heading + 90 degrees)' },
  strafe_right: { kind: 'translate', directionOffsetDeg: -90, distanceM: 2, label: 'Move 2 m sideways right (heading - 90 degrees)' },
});

/** track mode's two small menus (F61/F75's winning, small, decision-relevant menus, not the
 * abandoned 43,218-tuple velocity menu): one 7-option yaw axis, one 5-option range axis. Asked as
 * two independent Choice questions in one request (encoders/track.ts) and composed below into a
 * PRIMARY command plus an optional FOLLOW-UP (see `planTrackManeuver`) — a real drone can yaw and
 * translate at once; this is not two sequential maneuvers, but the two axes are no longer forced
 * to share one duration (engine-review-e2 finding 2). */
export const TRACK_YAW_MENU: ManeuverMenu = Object.freeze({
  yaw_left_60: DEFAULT_MENU.yaw_left_60!, yaw_left_30: DEFAULT_MENU.yaw_left_30!, yaw_left_10: DEFAULT_MENU.yaw_left_10!,
  hold: DEFAULT_MENU.hold!,
  yaw_right_10: DEFAULT_MENU.yaw_right_10!, yaw_right_30: DEFAULT_MENU.yaw_right_30!, yaw_right_60: DEFAULT_MENU.yaw_right_60!,
});
/** Fixed-distance range menu. Ladder rule (`docs/jev-find-follow-ladder.md` § "Follow action
 * model"): kept ONLY for a stationary-target sub-rung; NOT reused for any scenario with a moving
 * target. Both of this engine's two smoke scenarios have a moving car, so they use
 * `SPEED_HOLD_MENU` (below) instead; this menu remains available/tested for a future stationary
 * scenario. engine-review-e2 finding 2: a fixed-distance choice's own `validForMs` is no longer
 * capped by a concurrent yaw's shorter duration (see `planTrackManeuver`'s follow-up mechanism), so
 * at a decision cadence slower than the option's own completion time (distanceM/speed) it now
 * realises its full printed distance if not superseded first — declared honestly: nothing prevents
 * the NEXT decision from superseding it earlier, in which case less than the printed distance is
 * realised (the same is true of a real flight controller re-planning early); this module does not
 * (and structurally cannot, from inside one command) guarantee completion against supersession —
 * episode.ts's decision-dispatch gating is what gives a bounded (non-speed-hold) maneuver the
 * chance to actually finish. */
export const TRACK_RANGE_MENU: ManeuverMenu = Object.freeze({
  retreat_2m: DEFAULT_MENU.retreat_2m!, retreat_1m: DEFAULT_MENU.retreat_1m!, hold: DEFAULT_MENU.hold!,
  approach_1m: DEFAULT_MENU.approach_1m!, approach_2m: DEFAULT_MENU.approach_2m!,
});
/** engine-review-e3 finding "no-retreat ratchet": the speed-hold menu previously had NO negative
 * (retreat/opening) option — against a STATIONARY target, a measured-rate reference reading pure
 * sensor noise as a small closing rate would creep inward with no way to back off (measured: mean
 * time-in-band 0.705, min 0.05 across 8 seeds), and "moves, then stops" (L4's own fixture) could
 * never be corrected for once the reference had over-closed. Two small retreat options
 * (-0.5, -1.0 m/s) fix this. Speed-hold's own formula (`resultingRange`, encoders/track.ts) already
 * handles a negative `speedMps` correctly (subtracting a negative closing speed widens the
 * predicted range, i.e. retreating) with no formula change needed. */
function speedHoldLabel(speedMps: number): string {
  if (speedMps === 0) return 'Hold: 0.0 m/s closing speed';
  if (speedMps > 0) return `Close at ${speedMps.toFixed(1)} m/s along the current bearing to the target`;
  return `Move away from the target (opening range) at ${Math.abs(speedMps).toFixed(1)} m/s along the current bearing`;
}
const idFor = (speedMps: number) => speedMps === 0 ? 'hold' : `speed_${speedMps < 0 ? 'neg_' : ''}${Math.abs(speedMps).toFixed(1).replace('.', '_')}`;

/** engine-review-e3 finding A2 ("menu declared per scenario"): builds a speed-hold menu with
 * negative retreat authority (declared floor `-retreatCapMps`, default -1.0 m/s, in 0.5 m/s steps)
 * and a top option that clears `declaredMaxTargetSpeedMps` by at least `catchUpMarginMps` (default
 * 1.0 m/s, the ladder's own stated requirement) — so a rung whose target moves faster than the old
 * fixed 2.5 m/s ceiling still gets genuine catch-up authority, and a rung with a slower target does
 * not carry a needlessly large/irrelevant top-end. */
export function buildSpeedHoldMenu(declaredMaxTargetSpeedMps: number, options: { stepMps?: number; retreatCapMps?: number; catchUpMarginMps?: number } = {}): ManeuverMenu {
  const stepMps = options.stepMps ?? 0.5;
  const retreatCapMps = options.retreatCapMps ?? 1.0;
  const catchUpMarginMps = options.catchUpMarginMps ?? 1.0;
  const topMps = Math.ceil((declaredMaxTargetSpeedMps + catchUpMarginMps) / stepMps) * stepMps;
  const speeds: number[] = [];
  for (let s = -retreatCapMps; s <= topMps + 1e-9; s += stepMps) speeds.push(Math.round(s * 100) / 100);
  const menu: ManeuverMenu = {};
  for (const speedMps of speeds) menu[idFor(speedMps)] = { kind: 'speed_hold', speedMps, label: speedHoldLabel(speedMps) };
  return Object.freeze(menu);
}

/** Speed-hold range menu (the ladder's follow-action model for any moving-target rung): an
 * absolute closing OR opening speed along the current bearing to the target, held under lease until
 * superseded. This is the DEFAULT/backward-compatible instance (`buildSpeedHoldMenu(3.0)` — a 4.0
 * m/s top option, >=1 m/s over the reference-ceiling sweep's own tested 0-3 m/s envelope), used by
 * every caller that has not yet been updated to declare its own rung-specific max target speed;
 * `buildSpeedHoldMenu` itself is what "menu declared per scenario" (engine-review-e3) actually
 * calls for. */
export const SPEED_HOLD_MENU: ManeuverMenu = buildSpeedHoldMenu(3.0);
export const SPEED_HOLD_HORIZON_S = 1.0;
export const SEARCH_MENU: ManeuverMenu = DEFAULT_MENU;

/** S1 assignment item 2: search-mode menu for the coverage-memory experiment, adding two larger
 * bounded translate options (`advance_8m`/`advance_15m`) so a translate option can plausibly cross
 * an open field far enough to bring genuinely new ground into detector range in one bounded move —
 * `approach_1m`/`approach_2m` (kept, unchanged, in `DEFAULT_MENU`) are too short to matter at the
 * ~18m coverage effective-range scale. Additive only (spreads `DEFAULT_MENU` first): every existing
 * id/definition is byte-for-byte unchanged, so `SEARCH_MENU` (unchanged) and any caller keyed by the
 * original menu's ids stay valid. Used only by the l5/l8 search-encoding scenarios below, on ALL
 * THREE search-variant arms compared there (sector-consequences included) — S1's explicit "same
 * menus... across arms" requirement, so the comparison isolates the ENCODING, not the action
 * repertoire. Execution needs no engine change: `executeManeuver`'s translate branch below reads
 * `distanceM` generically (already true for every existing translate id).
 */
export const SEARCH_MENU_WIDE: ManeuverMenu = Object.freeze({
  ...DEFAULT_MENU,
  advance_8m: { kind: 'translate', directionOffsetDeg: 0, distanceM: 8, label: 'Move 8 m toward the camera-heading direction' },
  advance_15m: { kind: 'translate', directionOffsetDeg: 0, distanceM: 15, label: 'Move 15 m toward the camera-heading direction' },
});
export const TRANSLATE_SPEED_MPS = 1.0;

/** engine-review-e3 finding 3 (printed != realised, at DEFAULT config): a fixed-distance translate
 * commanded as `validForMs = distanceM / TRANSLATE_SPEED_MPS * 1000` under-realises its own printed
 * distance by a near-CONSTANT ~0.239m regardless of the commanded distance (measured directly
 * against real physics: 500/1000/1500/1800/2000/2500ms commands realised 0.291/0.765/1.261/1.561/
 * 1.761/2.261m respectively — a shortfall converging to ~0.239m once the command is long enough to
 * clear the plant's own force/acceleration ramp-up to cruise speed, `src/models/mobile.ts`'s
 * `tick()`: `desiredAcceleration = cap(scale(sub(desired,velocity),4), maxAcceleration=6)`, an
 * acceleration-capped SERVO, not an instant velocity — YAW is unaffected since it is applied as a
 * direct angular velocity with no equivalent ramp, matching the review's own "yaw realises
 * correctly" finding). Fixed here by ADDING this fixed compensation to the commanded duration
 * (re-measured after the fix: errors of 0.001-0.012m across 500-2000ms commands, well inside any
 * of this ladder's own tolerances) rather than attempting a closed-loop `goto`-based redesign —
 * `goto` cannot run simultaneously with an independent yaw rate in this engine's plant model
 * (`src/models/mobile.ts`'s `apply('goto', ...)` unconditionally zeroes `yawRate`), which track
 * mode's combined yaw+range command needs. */
export const RANGE_RAMP_COMPENSATION_MS = 240;

export interface PlannedCommand { action: Command['action']; args: Record<string, Json>; validForMs: number; vetoed?: string }

/** engine-review-e2 finding 2: yaw and range/speed no longer share one command duration. `primary`
 * is issued immediately; `followUp` (when present) must be issued by the caller `afterMs`
 * milliseconds of SIMULATED time later (episode.ts's acquisition loop does this, checking against
 * the world's own advancing clock, not a wall-clock timer) so the range/speed axis continues
 * running for its own declared duration after the (shorter) yaw finishes, instead of being cut off
 * by `plant.stop()` at the yaw's own expiry. `followUp` is null when both axes finish together (no
 * gap to fill) — e.g. a 'hold' yaw (whose own "duration" is defined as matching the range axis) or
 * a range/speed choice no longer than the yaw. */
export interface PlannedTrackCommand {
  primary: PlannedCommand;
  followUp: { afterMs: number; command: PlannedCommand } | null;
  /** The yaw axis's own bounded completion time in ms (0 for 'hold') — episode.ts uses this (and
   * the range axis's own bounded completion time, when it is not speed-hold) to gate the NEXT
   * decision's dispatch until any bounded maneuver has had the chance to actually finish,
   * addressing `turn_180`-class findings generally (not just search's `turn_180`; see
   * `boundedCompletionMs` below for the combined figure). */
  yawOwnDurationMs: number;
  /** The range axis's own FULL declared duration in ms (0 when inert) — used to size the
   * FOLLOW-UP, not for gating (speed-hold's own duration is the full lease, "held until
   * superseded"; see `rangeBoundedDurationMs` for the gating-appropriate figure). */
  rangeOwnDurationMs: number;
  /** The range axis's own BOUNDED completion time in ms for gating the next decision's dispatch —
   * 0 for 'hold' AND for speed-hold (never waited for: speed-hold is deliberately reconsidered
   * every decision, per the ladder), the real distance/speed duration for fixed-distance translate
   * only. Pass `boundedCompletionMs(yawOwnDurationMs, rangeBoundedDurationMs)` to episode.ts's
   * gating, never `rangeOwnDurationMs` (see the regression noted at this function's return). */
  rangeBoundedDurationMs: number;
}

/** Composes one chosen yaw option and one chosen range option into a PRIMARY simultaneous
 * `velocity` command (yawRate plus forward/backward translation along the CURRENT heading —
 * matching the encoders' own "current heading, stationary/full-execution" consequence hypothesis,
 * not the post-yaw heading) plus an optional FOLLOW-UP that continues the longer axis once the
 * shorter one completes. Real drone: yaw and translate concurrently; this is still not two
 * sequential maneuvers from the controller's point of view — it chose both axes in one decision.
 *
 * FAILURES.md #4 / engine-review-e1 finding 2: validForMs was originally `leaseMs` unconditionally,
 * so a chosen yaw kept applying its yawRate for the WHOLE lease instead of stopping once its own
 * declared degrees were reached. Fixed by capping a non-hold yaw to its own completion time.
 *
 * engine-review-e2 finding 2 (this repair): that fix then capped the COMBINED command's validForMs
 * to `min(yaw, range)`, so a LONGER range/speed choice was cut off at the SHORTER yaw's completion
 * — measured: `yaw_left_10 + speed_1_0` moved at 0.00 m/s (odometry noise floor only), and
 * `approach_1m`/`approach_2m` both realised ~0.6 m regardless of their printed distance. The two
 * axes are now genuinely independent: the primary command covers `min(yawOwnDurationMs,
 * rangeOwnDurationMs)`; whichever axis is longer gets a follow-up covering the remainder, with the
 * OTHER axis zeroed (its own work is already done). Speed-hold's own "duration" is defined as the
 * full lease (held until superseded, the ladder's own wording), so it always dominates and gets a
 * follow-up once any real yaw finishes — this is the exact fix for the `yaw_left_10 + speed_1_0`
 * finding. A 'hold' range choice has no independent life of its own (nothing to persist after the
 * yaw completes) and is defined to match the yaw's own duration, so it never produces a follow-up. */
export function planTrackManeuver(
  yawId: string, rangeId: string, ownState: { headingDeg: number }, options: { leaseMs: number },
  rangeMenu: ManeuverMenu = TRACK_RANGE_MENU, yawRateDegS: number = DEFAULT_YAW_RATE_DEG_S,
): PlannedTrackCommand {
  const yawDef = TRACK_YAW_MENU[yawId]; if (!yawDef) throw new Error(`Unknown yaw maneuver "${yawId}"`);
  const rangeDef = rangeMenu[rangeId]; if (!rangeDef) throw new Error(`Unknown range maneuver "${rangeId}"`);
  const yawRateRadS = yawDef.kind === 'yaw' ? (yawDef.yawDeg! >= 0 ? 1 : -1) * yawRateDegS * Math.PI / 180 : 0;
  // Fixed-distance translate: signed by approach(-)/retreat direction. Speed-hold: always a
  // positive CLOSING speed along the current bearing (never signed/retreat — the ladder's menu has
  // no retreat option; see SPEED_HOLD_MENU's docstring).
  const forwardMps = rangeDef.kind === 'translate' ? (rangeDef.directionOffsetDeg === 0 ? 1 : -1) * TRANSLATE_SPEED_MPS
    : rangeDef.kind === 'speed_hold' ? rangeDef.speedMps!
    : 0;
  const headingRad = ownState.headingDeg * Math.PI / 180;
  const yawOwnDurationMs = yawDef.kind === 'yaw' ? Math.max(1, Math.round(Math.abs(yawDef.yawDeg!) / yawRateDegS * 1000)) : 0;
  // A 'hold' range choice, or an explicit 0 m/s speed-hold, has no independent life of its own —
  // defined to match the yaw's own duration (or the full lease if the yaw is also 'hold'), so it
  // never triggers a follow-up.
  const rangeIsInert = rangeDef.kind === 'hold' || (rangeDef.kind === 'speed_hold' && rangeDef.speedMps === 0);
  const rangeOwnDurationMs = rangeIsInert ? 0
    : rangeDef.kind === 'speed_hold' ? options.leaseMs // held under lease until superseded
    // fixed-distance: its own printed magnitude PLUS the measured ramp-up compensation (finding 3)
    // — sized to its OWN true duration, never capped at options.leaseMs (a fixed-distance command
    // is already self-bounded; the lease is not the right ceiling for it — see finding 3's own
    // "size bounded commands to their own duration" instruction).
    : Math.max(1, Math.round(rangeDef.distanceM! / TRANSLATE_SPEED_MPS * 1000) + RANGE_RAMP_COMPENSATION_MS);

  const yawEffectiveMs = yawDef.kind === 'yaw' ? yawOwnDurationMs : (rangeIsInert ? options.leaseMs : rangeOwnDurationMs);
  const rangeEffectiveMs = rangeIsInert ? yawEffectiveMs : rangeOwnDurationMs;
  // engine-review-e3 finding 3: NO `options.leaseMs` cap here — both `yawEffectiveMs` and
  // `rangeEffectiveMs` are already each individually bounded appropriately (a genuine fixed-
  // duration action sized to its own true completion time above; speed-hold/hold already defined
  // as exactly `options.leaseMs`). Capping the MIN of the two at the lease again was the actual
  // bug: it silently truncated any bounded command whose own duration exceeded the lease (e.g.
  // `approach_2m`'s 2000ms nominal against the default 1500ms lease), and the follow-up "remainder"
  // computed below inherited the SAME redundant cap, so remainingMs was always 0 and no follow-up
  // was ever issued to carry it.
  const primaryDurationMs = Math.min(yawEffectiveMs, rangeEffectiveMs);

  const primary: PlannedCommand = {
    action: 'velocity',
    args: {
      x: Math.round(Math.cos(headingRad) * forwardMps * 1e6) / 1e6,
      y: Math.round(Math.sin(headingRad) * forwardMps * 1e6) / 1e6,
      z: 0, yawRate: Math.round(yawRateRadS * 1e6) / 1e6,
    },
    validForMs: primaryDurationMs,
  };

  let followUp: PlannedTrackCommand['followUp'] = null;
  if (rangeEffectiveMs > primaryDurationMs) {
    // The range/speed axis outlives the yaw: continue translating alone for the remainder.
    const remainingMs = rangeEffectiveMs - primaryDurationMs;
    if (remainingMs > 0) {
      followUp = {
        afterMs: primaryDurationMs,
        command: { action: 'velocity', args: { x: primary.args.x, y: primary.args.y, z: 0, yawRate: 0 }, validForMs: remainingMs },
      };
    }
  } else if (yawEffectiveMs > primaryDurationMs && yawDef.kind === 'yaw') {
    // The yaw outlives the range axis (rare: a very long yaw with a short fixed-distance range
    // choice): continue yawing alone for the remainder.
    const remainingMs = yawEffectiveMs - primaryDurationMs;
    if (remainingMs > 0) {
      followUp = {
        afterMs: primaryDurationMs,
        command: { action: 'velocity', args: { x: 0, y: 0, z: 0, yawRate: primary.args.yawRate }, validForMs: remainingMs },
      };
    }
  }

  // engine-review-e2 finding 2 follow-up bug (found while measuring the E3 acceptance runs): this
  // function's own `rangeOwnDurationMs` was ALSO being used by episode.ts to gate the next
  // decision's dispatch (via `boundedCompletionMs`) — but for speed-hold, `rangeOwnDurationMs` is
  // defined as the FULL LEASE (correct for sizing the follow-up: "hold under lease until
  // superseded"), so gating on it made EVERY nonzero speed-hold choice wait out the whole ~1500ms
  // lease before the next decision, defeating "speed-hold is reconsidered every decision" (the
  // ladder's own wording) — measured: decision gaps of ~1800ms instead of the ~505ms pacing floor.
  // `rangeBoundedDurationMs` is the value gating should actually use: 0 for speed-hold (never
  // waited for) and hold, the real distance/speed duration for fixed-distance translate only.
  const rangeBoundedDurationMs = rangeDef.kind === 'translate' ? rangeOwnDurationMs : 0;
  return { primary, followUp, yawOwnDurationMs, rangeOwnDurationMs: rangeIsInert ? 0 : rangeOwnDurationMs, rangeBoundedDurationMs };
}

/** Pure: turns a chosen maneuver id + own state into exactly one RobotPort command. `blockedWithinM`
 * lets the caller pass a measured obstacle clearance so a translate into a too-close direction is
 * vetoed (logged, counts against the choice) rather than silently executed or silently swapped.
 * Unit E4b / A7 (engine-review-e3's "clearance veto also on unknown"): `blockedWithinM` also
 * accepts the literal string `'unknown'` — a direction whose clearance has never been measured (or
 * has gone stale) is NOT treated as safe-by-default; it vetoes any translate into it exactly like a
 * measured-too-close reading does, just with an honestly different reason string (never claims a
 * distance that was never actually measured). */
export function planManeuver(
  menu: ManeuverMenu, maneuverId: string, ownState: { headingDeg: number; position: { x: number; y: number; z: number } },
  options: { leaseMs: number; blockedWithinM?: number | 'unknown' }, yawRateDegS: number = DEFAULT_YAW_RATE_DEG_S,
): PlannedCommand {
  const def: ManeuverDef | undefined = menu[maneuverId];
  if (!def) throw new Error(`Unknown maneuver "${maneuverId}"`);
  if (def.kind === 'hold') return { action: 'hold', args: {}, validForMs: options.leaseMs };
  if (def.kind === 'yaw') {
    const yawDeg = def.yawDeg!;
    const turnDurationMs = Math.max(1, Math.round(Math.abs(yawDeg) / yawRateDegS * 1000));
    const yawRateRadS = (yawDeg >= 0 ? 1 : -1) * yawRateDegS * Math.PI / 180;
    // engine-review-e3 finding 3: NO `options.leaseMs` cap — a yaw is already a self-bounded action
    // (it stops on its own once its own declared degrees complete); capping it at the DEFAULT
    // 1500ms lease was the exact cause of `turn_180` (1800ms nominal at the default 100deg/s)
    // realising only 150deg instead of 180deg. Search mode has no follow-up mechanism (unlike
    // track's `planTrackManeuver`), so this action's own `validForMs` must be its full true
    // duration outright, well inside the system's hard [1,60000]ms limit (src/world.ts) for every
    // currently offered menu magnitude.
    return { action: 'velocity', args: { x: 0, y: 0, z: 0, yawRate: Math.round(yawRateRadS * 1e6) / 1e6 }, validForMs: turnDurationMs };
  }
  if (def.kind === 'translate') {
    const directionDeg = ownState.headingDeg + (def.directionOffsetDeg ?? 0);
    const rad = directionDeg * Math.PI / 180, distanceM = def.distanceM!;
    if (options.blockedWithinM === 'unknown') {
      return { action: 'hold', args: {}, validForMs: options.leaseMs, vetoed: `Translate ${maneuverId} vetoed: clearance in that direction is unknown (never measured, or stale) — never assumed open` };
    }
    if (options.blockedWithinM !== undefined && options.blockedWithinM < distanceM) {
      return { action: 'hold', args: {}, validForMs: options.leaseMs, vetoed: `Translate ${maneuverId} vetoed: measured clearance ${options.blockedWithinM}m < requested ${distanceM}m` };
    }
    const target = {
      x: Math.round((ownState.position.x + Math.cos(rad) * distanceM) * 1000) / 1000,
      y: Math.round((ownState.position.y + Math.sin(rad) * distanceM) * 1000) / 1000,
      z: ownState.position.z,
    };
    return { action: 'goto', args: target, validForMs: options.leaseMs };
  }
  if (def.kind === 'speed_hold') {
    const headingRad = ownState.headingDeg * Math.PI / 180, speedMps = def.speedMps!;
    return { action: 'velocity', args: { x: Math.round(Math.cos(headingRad) * speedMps * 1e6) / 1e6, y: Math.round(Math.sin(headingRad) * speedMps * 1e6) / 1e6, z: 0, yawRate: 0 }, validForMs: options.leaseMs };
  }
  throw new Error(`Unsupported maneuver kind for ${maneuverId}`);
}

/** Pure: the simulated time (ms, relative to a maneuver's own application instant) episode.ts
 * should wait before dispatching the NEXT decision, so a BOUNDED maneuver (a real yaw, or a
 * fixed-distance translate) gets the chance to actually finish rather than being superseded
 * mid-turn/mid-step every decision (engine-review-e2 finding 2's `turn_180` sub-finding: realised
 * turns of 104.6 deg / ~150 deg against a printed 180 deg). Speed-hold and 'goto'-based search
 * translations are NOT bounded this way — they are deliberately reconsidered at the normal cadence
 * (the ladder's own "speed-hold ... reconsidered every decision" wording; a `goto`'s proportional
 * servo has no fixed completion time to wait for in the first place). */
export function boundedCompletionMs(yawOwnDurationMs: number, rangeOwnDurationMs: number): number {
  return Math.max(yawOwnDurationMs, rangeOwnDurationMs);
}

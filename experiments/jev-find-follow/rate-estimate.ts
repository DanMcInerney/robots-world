/** Range-rate and bearing-rate estimation, per the ladder's "Follow action model" § "Rate estimate,
 * defined precisely".
 *
 * engine-review-e2 finding 3 ("the ladder's '1.0 s window' combined with 'exclude samples older
 * than 400 ms' is effectively a 3-sample fit — the ladder needs to decide which it means"):
 * resolved here by implementing EXACTLY "least-squares over samples no older than the window W
 * under one bound identity, >=3 samples, else unknown" — ONE window cut, no separate staleness
 * sub-horizon. `W` is a scenario parameter (default 1.0 s; see episode.ts/scenarios.ts's
 * `rateWindowMs`) — WORKLOG.md records this resolution for the ladder owner to confirm/adopt.
 *
 * - **Window:** the last `windowMs` (default 1.0 s) of valid samples under ONE bound target
 *   identity (no identity change inside the window — this module does not itself decide identity;
 *   the caller resets the buffer whenever binding is genuinely ambiguous, see episode.ts).
 * - **Minimum samples:** >=3 valid samples in that window, else `unknown`.
 * - **Own-heading correction:** samples are stored as WORLD-frame bearing degrees (already
 *   independent of the platform's own YAW — camera-geometry.ts's `worldBearingDeg`), so a linear
 *   fit over world-frame samples does not read the platform's own rotation as target motion.
 * - **Own-TRANSLATION (ego-motion) compensation for range-rate (finding 3):** the raw slope of
 *   measured slant range over time includes BOTH the target's own radial motion AND the drone's own
 *   closing/opening motion (e.g. from its own previously-chosen speed-hold option) — using it
 *   directly as "the target's speed" double-counts ego-motion (measured: a stationary target with
 *   the drone closing at 1 m/s predicted 7.6 m instead of the true 8.6 m). Compensated here by also
 *   fitting the drone's own radial displacement (from odometry) along the sighting's own bearing
 *   direction over the same window, and adding that own-closing-speed back: `dR/dt = target's own
 *   radial speed (positive=receding) - own closing speed (positive=closing)`, so
 *   `targetRadialSpeedMps = measuredRawRangeRateMps + ownClosingSpeedMps`. `unknown` when odometry
 *   is unavailable for a sample (declared: this engine's own-state always carries odometry, so this
 *   clause is for a hypothetical caller without it, not exercised here).
 *
 * engine-review-e3 finding 1 ("rate reset on a single miss, no last-known fallback"): a single
 * missed acquisition must NOT wipe the window (episode.ts now only resets `rateHistory` on a
 * genuinely `ambiguous` bind — a real identity-continuity break — never on a plain miss; the
 * window-based filtering below already drops samples older than `windowMs` on its own, so a miss
 * simply thins the window rather than requiring a reset). Additionally: when the CURRENT W-window
 * estimate is `unknown` for an axis, but a valid W-window estimate existed for that SAME axis at
 * some earlier instant no more than `staleFallbackMs` (default 2.0 s) in the past, THAT estimate is
 * reused (verbatim — not recomputed over a widened window) rather than jumping straight to the
 * stationary fallback, and reported as `'last-known'` with its own age so a consumer can label it
 * honestly. Each axis (range, bearing) is resolved independently, since one axis can have >=3
 * recent samples while the other does not (e.g. a valid stereo range but the bearing points are
 * currently degenerate, or vice versa).
 */
import type { Vec3World } from './camera-geometry.ts';

export interface RateSample {
  acquiredSimMs: number;
  rangeM: number | null;
  worldBearingDeg: number;
  /** Own WORLD position (declared, own-state-derived — never simulator-exact) at this sample's
   * acquisition instant, used ONLY to compensate range-rate for the platform's own translation
   * (ego-motion) — never rendered to a controller directly. `null` when odometry is unavailable for
   * this sample (range-rate then reports `unknown` rather than an uncompensated, misattributed
   * figure). */
  ownPositionM: Vec3World | null;
}

export type RateSource = 'current' | 'last-known' | 'none';

export interface RateEstimate {
  rangeRateMps: number | 'unknown';
  bearingRateDegS: number | 'unknown';
  sampleCount: number;
  windowMs: number;
  /** engine-review-e3 finding 1: 'current' when this axis's rate was computed fresh from the
   * standard W-window rule (ending at `nowSimMs`); 'last-known' when the CURRENT window is
   * `unknown` for this axis but a valid W-window estimate existed at an earlier instant within
   * `staleFallbackMs` (see `rangeRateAgeMs`/`bearingRateAgeMs`) and is reused; 'none' when neither
   * applies (the stationary fallback applies — encoders/track.ts). */
  rangeRateSource: RateSource;
  bearingRateSource: RateSource;
  /** Age (ms) of a `'last-known'` estimate: `nowSimMs` minus the instant it was last validly
   * computed. `null` for `'current'` (age is 0, not worth stating) and for `'none'`. */
  rangeRateAgeMs: number | null;
  bearingRateAgeMs: number | null;
}

export const DEFAULT_RATE_WINDOW_MS = 1000;
/** engine-review-e3 finding 1: the ladder's own declared "last estimate <=2s old" fallback
 * threshold. */
export const DEFAULT_STALE_FALLBACK_MS = 2000;
const MIN_SAMPLES = 3;

function linearFit(points: { t: number; y: number }[]): number {
  // Ordinary least squares slope (rate), points already de-meaned in time for numerical stability.
  const n = points.length;
  const meanT = points.reduce((s, p) => s + p.t, 0) / n;
  const meanY = points.reduce((s, p) => s + p.y, 0) / n;
  let num = 0, den = 0;
  for (const p of points) { const dt = p.t - meanT; num += dt * (p.y - meanY); den += dt * dt; }
  return den === 0 ? 0 : num / den; // per-ms slope
}

/** Unwraps a sequence of world-bearing degrees (each in [0,360)) so a fit across the 0/360
 * boundary does not see a spurious ~360 deg jump. */
function unwrapDeg(values: number[]): number[] {
  const out = [values[0]!];
  for (let i = 1; i < values.length; i++) {
    let v = values[i]!;
    while (v - out[i - 1]! > 180) v -= 360;
    while (v - out[i - 1]! < -180) v += 360;
    out.push(v);
  }
  return out;
}

/** Pure core: the ladder's exact W-window rule, ending at `atSimMs` (not necessarily "now" — the
 * last-known fallback below calls this at PAST instants too). Extracted so both the primary
 * estimate and the backward last-known search share exactly one implementation. */
function computeWindow(history: readonly RateSample[], atSimMs: number, windowMs: number): { rangeRateMps: number | 'unknown'; bearingRateDegS: number | 'unknown'; sampleCount: number } {
  const fresh = history.filter(s => atSimMs - s.acquiredSimMs <= windowMs && s.acquiredSimMs <= atSimMs);
  if (fresh.length < MIN_SAMPLES) return { rangeRateMps: 'unknown', bearingRateDegS: 'unknown', sampleCount: fresh.length };

  const bearings = unwrapDeg(fresh.map(s => s.worldBearingDeg));
  const bearingPoints = fresh.map((s, i) => ({ t: s.acquiredSimMs, y: bearings[i]! }));
  const bearingRateDegS = linearFit(bearingPoints) * 1000; // per-ms -> per-s

  const rangeSamples = fresh.filter(s => s.rangeM !== null && s.ownPositionM !== null) as { acquiredSimMs: number; rangeM: number; worldBearingDeg: number; ownPositionM: Vec3World }[];
  let rangeRateMps: number | 'unknown' = 'unknown';
  if (rangeSamples.length >= MIN_SAMPLES) {
    const rawSlopeMps = linearFit(rangeSamples.map(s => ({ t: s.acquiredSimMs, y: s.rangeM }))) * 1000;
    // Ego-motion compensation: project own position onto the sighting's own (latest-sample) bearing
    // direction and fit ITS slope too — the drone's own radial closing speed along that direction.
    const refBearingRad = rangeSamples.at(-1)!.worldBearingDeg * Math.PI / 180;
    const bearingUnit = { x: Math.cos(refBearingRad), y: Math.sin(refBearingRad) };
    const ownRadialPoints = rangeSamples.map(s => ({ t: s.acquiredSimMs, y: s.ownPositionM.x * bearingUnit.x + s.ownPositionM.y * bearingUnit.y }));
    const ownClosingSpeedMps = linearFit(ownRadialPoints) * 1000; // own position moving toward the bearing direction = closing
    rangeRateMps = rawSlopeMps + ownClosingSpeedMps;
  }

  return { rangeRateMps, bearingRateDegS, sampleCount: fresh.length };
}

/** Pure: given a bounded history of samples (caller owns the reset-on-ambiguous-identity policy —
 * see episode.ts) and the current simulated time, computes the range-rate/bearing-rate estimate
 * per the ladder's rule (single window `windowMs`, >=3 samples else unknown), falling back per-axis
 * to the last time a valid estimate existed within `staleFallbackMs`, per engine-review-e3 finding
 * 1's own wording, before the caller (encoders/track.ts) falls further back to a stationary
 * assumption. */
export function estimateRate(
  history: readonly RateSample[], nowSimMs: number, windowMs: number = DEFAULT_RATE_WINDOW_MS, staleFallbackMs: number = DEFAULT_STALE_FALLBACK_MS,
): RateEstimate {
  const current = computeWindow(history, nowSimMs, windowMs);
  let rangeRateMps = current.rangeRateMps, bearingRateDegS = current.bearingRateDegS;
  let rangeRateSource: RateSource = rangeRateMps !== 'unknown' ? 'current' : 'none';
  let bearingRateSource: RateSource = bearingRateDegS !== 'unknown' ? 'current' : 'none';
  let rangeRateAgeMs: number | null = null, bearingRateAgeMs: number | null = null;

  if (rangeRateSource === 'none' || bearingRateSource === 'none') {
    // Walk backward through distinct past acquisition instants (most recent first) looking for the
    // last moment a valid W-window estimate existed for whichever axis/axes are still missing.
    const candidateTimes = [...new Set(history.map(s => s.acquiredSimMs))].filter(t => t < nowSimMs).sort((a, b) => b - a);
    for (const t of candidateTimes) {
      if (nowSimMs - t > staleFallbackMs) break; // sorted descending: once too old, every earlier one is too
      if (rangeRateSource === 'none' || bearingRateSource === 'none') {
        const past = computeWindow(history, t, windowMs);
        if (rangeRateSource === 'none' && past.rangeRateMps !== 'unknown') {
          rangeRateMps = past.rangeRateMps; rangeRateSource = 'last-known'; rangeRateAgeMs = nowSimMs - t;
        }
        if (bearingRateSource === 'none' && past.bearingRateDegS !== 'unknown') {
          bearingRateDegS = past.bearingRateDegS; bearingRateSource = 'last-known'; bearingRateAgeMs = nowSimMs - t;
        }
      }
      if (rangeRateSource !== 'none' && bearingRateSource !== 'none') break;
    }
  }

  return { rangeRateMps, bearingRateDegS, sampleCount: current.sampleCount, windowMs, rangeRateSource, bearingRateSource, rangeRateAgeMs, bearingRateAgeMs };
}

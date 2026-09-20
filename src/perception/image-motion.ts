import type { Region } from './color-tracks.ts';

type Measurement = { acquiredMs: number; headingDeg: number; pitchDeg: number; hfovDeg: number; objects: Region[] };
type Seen = { at: number; region: Region; hfov: number };
const round = (n: number) => Math.round(n * 100) / 100;
const delta = (a: number, b: number) => ((a - b + 540) % 360) - 180;

/** Bounded summaries of delivered measurements. No goal, commands, geometry or prediction. */
export function imageMotion() {
  let previous: Measurement | undefined;
  let rates: Record<string, unknown> = {}, cameraMotion: unknown = null, overflow = 0;
  const seen = new Map<string, Seen>();
  return (frame: Measurement, deliveredMs: number) => {
    if (!Number.isFinite(frame.acquiredMs) || !Number.isFinite(deliveredMs) || deliveredMs < frame.acquiredMs || (previous && frame.acquiredMs < previous.acquiredMs)) throw new Error('Invalid image motion time');
    if (!previous || frame.acquiredMs > previous.acquiredMs) {
      rates = {}; overflow = 0;
      const dt = previous ? (frame.acquiredMs - previous.acquiredMs) / 1000 : 0;
      cameraMotion = previous && dt > 0 && dt <= .6 ? { intervalMs: round(dt * 1000), headingLeftDegPerS: round(delta(frame.headingDeg, previous.headingDeg) / dt), pitchUpDegPerS: round((frame.pitchDeg - previous.pitchDeg) / dt), zoomChanged: frame.hfovDeg !== previous.hfovDeg } : null;
      for (const [id, value] of seen) if (frame.acquiredMs - value.at > 2000) seen.delete(id);
      for (const region of frame.objects) {
        const prior = seen.get(region.id), seconds = prior ? (frame.acquiredMs - prior.at) / 1000 : 0;
        const reason = !prior || seconds > .6 ? 'new_or_stale_track' : prior.hfov !== frame.hfovDeg ? 'zoom_changed' : prior.region.clipped || region.clipped ? 'clipped_extent' : null;
        rates[region.id] = reason ? { unknown: reason } : { intervalMs: round(seconds * 1000), rightDegPerS: round((region.rightDeg - prior!.region.rightDeg) / seconds), upDegPerS: round((region.upDeg - prior!.region.upDeg) / seconds), widthPercentagePointsPerS: round((region.widthPercent - prior!.region.widthPercent) / seconds) };
        seen.set(region.id, { at: frame.acquiredMs, region, hfov: frame.hfovDeg });
      }
      // Explicit capacity failure, never a goal-based shortlist of remembered objects.
      if (seen.size > 24) { overflow = seen.size; seen.clear(); }
      previous = structuredClone(frame);
    }
    const visible = new Set(frame.objects.map(r => r.id));
    return { imageRates: rates, cameraAngleRates: cameraMotion, lastSeen: [...seen.values()].filter(s => !visible.has(s.region.id) && deliveredMs - s.at <= 2000).map(s => ({ id: s.region.id, appearance: `${s.region.color} region`, ageMs: round(deliveredMs - s.at), rightDeg: s.region.rightDeg, upDeg: s.region.upDeg, widthPercent: s.region.widthPercent, hfovDeg: s.hfov, status: 'historical; current location unknown' })), memoryOverflow: overflow,
      provenance: 'Differences of delivered image measurements, not optical flow or world velocity. Tentative track IDs may switch. Rates include camera motion; camera-angle rates are reported separately, not compensated. Missing tracks are last observed values, never predictions.' };
  };
}

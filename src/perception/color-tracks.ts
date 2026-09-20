import type { Calibration, PixelFrame } from './fiducial.ts';

export type Region = {
  id: string; color: string; box: [number, number, number, number]; pixels: number;
  rightDeg: number; upDeg: number; widthPercent: number; clipped: boolean;
  history: { ageMs: number; rightDeg: number; upDeg: number; widthPercent: number }[];
};
const COLORS = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'magenta'];
const rounded = (n: number) => Math.round(n * 100) / 100;
/** Broad HSV categories, not a simulator palette or semantic object recognizer. */
function color(r: number, g: number, b: number) {
  const hi = Math.max(r, g, b), lo = Math.min(r, g, b), d = hi - lo;
  if (hi < 65 || d / hi < .35) return -1;
  let h = 60 * (hi === r ? ((g - b) / d) % 6 : hi === g ? (b - r) / d + 2 : (r - g) / d + 4);
  if (h < 0) h += 360;
  return h < 15 || h >= 345 ? 0 : h < 45 ? 1 : h < 75 ? 2 : h < 165 ? 3 : h < 195 ? 4 : h < 255 ? 5 : h < 285 ? 6 : 7;
}
/** ONLY pixels and calibration. No goal, target labels, physical sizes, world or commands. */
export function colorRegions(image: PixelFrame, k: Calibration): Omit<Region, 'id' | 'history'>[] {
  const { width: w, height: h, data } = image;
  if (w < 1 || h < 1 || w * h > 1920 * 1080 || data.length !== w * h * 4 || ![k.fx, k.fy, k.cx, k.cy].every(Number.isFinite) || k.fx <= 0 || k.fy <= 0) throw new Error('Invalid calibrated image');
  const labels = new Int8Array(w * h), queue = new Int32Array(w * h), regions: Omit<Region, 'id' | 'history'>[] = [];
  for (let i = 0; i < labels.length; i++) labels[i] = color(data[i * 4]!, data[i * 4 + 1]!, data[i * 4 + 2]!);
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i]!; if (label < 0) continue;
    let head = 0, tail = 1, xmin = w, xmax = 0, ymin = h, ymax = 0;
    queue[0] = i; labels[i] = -1;
    while (head < tail) {
      const index = queue[head++]!, x = index % w, y = Math.floor(index / w);
      xmin = Math.min(xmin, x); xmax = Math.max(xmax, x); ymin = Math.min(ymin, y); ymax = Math.max(ymax, y);
      for (const next of [x > 0 ? index - 1 : -1, x < w - 1 ? index + 1 : -1, y > 0 ? index - w : -1, y < h - 1 ? index + w : -1]) {
        if (next >= 0 && labels[next] === label) { labels[next] = -1; queue[tail++] = next; }
      }
    }
    if (tail < 12 || xmax - xmin < 2 || ymax - ymin < 2) continue;
    regions.push({ color: COLORS[label]!, box: [xmin, ymin, xmax + 1, ymax + 1], pixels: tail,
      rightDeg: rounded(Math.atan(((xmin + xmax + 1) / 2 - k.cx) / k.fx) * 180 / Math.PI),
      upDeg: rounded(Math.atan((k.cy - (ymin + ymax + 1) / 2) / k.fy) * 180 / Math.PI),
      widthPercent: rounded((xmax - xmin + 1) / w * 100), clipped: xmin === 0 || ymin === 0 || xmax === w - 1 || ymax === h - 1 });
  }
  return regions;
}
export function colorTracker() {
  let nextId = 0, previousTime = -Infinity;
  let tracks: { region: Region; at: number; samples: { at: number; rightDeg: number; upDeg: number; widthPercent: number }[] }[] = [];
  return (image: PixelFrame, calibration: Calibration, acquiredMs: number) => {
    if (!Number.isFinite(acquiredMs) || acquiredMs <= previousTime) throw new Error('Frames must advance acquisition time');
    previousTime = acquiredMs;
    const regions = colorRegions(image, calibration);
    if (regions.length > 24) { tracks = []; return { objects: [] as Region[], overflow: regions.length, reason: 'Region capacity exceeded; no goal-based shortlist' }; }
    const available = tracks.filter(t => acquiredMs - t.at <= 600), current: typeof tracks = [];
    for (const region of regions) {
      const candidates = available.filter(t => t.region.color === region.color && Math.abs(t.region.widthPercent - region.widthPercent) < Math.max(8, region.widthPercent)).map(t => ({ t, distance: Math.hypot(t.region.rightDeg - region.rightDeg, t.region.upDeg - region.upDeg) })).filter(t => t.distance < 18).sort((a, b) => a.distance - b.distance);
      const prior = candidates[0]?.t;
      if (prior) available.splice(available.indexOf(prior), 1);
      const history = (prior?.samples ?? []).slice(-3).map(s => ({ ageMs: acquiredMs - s.at, rightDeg: s.rightDeg, upDeg: s.upDeg, widthPercent: s.widthPercent }));
      const tracked = { ...region, id: prior?.region.id ?? `o${++nextId}`, history };
      current.push({ region: tracked, at: acquiredMs, samples: [...(prior?.samples ?? []).slice(-2), { at: acquiredMs, rightDeg: region.rightDeg, upDeg: region.upDeg, widthPercent: region.widthPercent }] });
    }
    tracks = current;
    return { objects: current.map(t => t.region), overflow: 0, reason: null };
  };
}

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { AR } = require('js-aruco2');
const { POS } = require('js-aruco2/src/posit1.js');
export type PixelFrame = { width: number; height: number; data: Uint8Array | Uint8ClampedArray };
export type Calibration = { fx: number; fy: number; cx: number; cy: number };
export const MARKER = { dictionary: 'ARUCO_MIP_36h12', id: 0, sizeM: .4, mounting: 'roof; marker top points toward rover front' };

/** Portable perception: ONLY rectified pixels, calibrated intrinsics and measured marker dimensions.
 * No world, goal, command menu, target trajectory, simulator pose or depth-buffer access.
 */
export function markerDetector(marker = MARKER) {
  const detector = new AR.Detector({ dictionaryName: marker.dictionary, maxHammingDistance: 0 });
  // Library defaults suppress nearby nested borders at small image sizes and warp a 7-cell grid.
  // Fixed detector settings for this 8-cell dictionary, applied to hardware and rendered pixels alike.
  const separate = detector.notTooNear.bind(detector), decode = detector.findMarkers.bind(detector);
  detector.notTooNear = (candidates: unknown[]) => separate(candidates, 3);
  detector.findMarkers = (image: unknown, candidates: unknown[]) => decode(image, candidates, 64);
  return (image: PixelFrame, k: Calibration) => {
    if (![image.width, image.height].every(n => Number.isInteger(n) && n > 0 && n <= 1920) || image.data.length !== image.width * image.height * 4) throw new Error('Invalid RGBA frame');
    if (![k.fx, k.fy, k.cx, k.cy, marker.sizeM].every(Number.isFinite) || k.fx <= 0 || k.fy <= 0 || marker.sizeM <= 0) throw new Error('Invalid camera/marker calibration');
    return detector.detect(image).filter((d: any) => d.id === marker.id).slice(0, 8).map((d: any) => {
      const corners = d.corners.map((p: any) => ({ x: p.x - k.cx, y: (k.cy - p.y) * k.fx / k.fy }));
      const fit = new POS.Posit(marker.sizeM, k.fx).pose(corners);
      const t = fit.bestTranslation as number[], r = fit.bestRotation as number[][];
      if (![...t, ...r.flat(), fit.bestError, fit.alternativeError].every(Number.isFinite) || t[2] <= 0 || fit.bestError > 3) return null;
      return { markerId: d.id, cornersPx: d.corners, cameraFrame: 'right, up, forward', translationM: t, rotation: r,
        rangeM: Math.hypot(...t), bearingRightDeg: Math.atan2(t[0], t[2]) * 180 / Math.PI, bearingUpDeg: Math.atan2(t[1], Math.hypot(t[0], t[2])) * 180 / Math.PI,
        reprojectionErrorPx: fit.bestError, ambiguous: Math.abs(fit.alternativeError - fit.bestError) < .5,
        alternative: { translationM: fit.alternativeTranslation, rotation: fit.alternativeRotation, errorPx: fit.alternativeError } };
    }).filter(Boolean);
  };
}
/** Physical print pattern, not a detection shortcut. Includes one-cell white quiet border. */
export function markerPattern(id = MARKER.id): number[][] {
  const dictionary = new AR.Dictionary(MARKER.dictionary), bits = dictionary.codeList[id];
  if (!bits) throw new Error('Unknown marker ID');
  const inside = Math.sqrt(bits.length), size = inside + 4;
  return Array.from({ length: size }, (_, y) => Array.from({ length: size }, (_, x) =>
    x === 0 || y === 0 || x === size - 1 || y === size - 1 ? 255 : x === 1 || y === 1 || x === size - 2 || y === size - 2 ? 0 : bits[(y - 2) * inside + x - 2] === '1' ? 255 : 0));
}
export function markerSvg(id = MARKER.id) { return new AR.Dictionary(MARKER.dictionary).generateSVG(id) as string; }

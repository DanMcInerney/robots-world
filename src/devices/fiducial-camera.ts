import { createHash } from 'node:crypto';
import type { BodySpec, SensorContext, SensorPlugin } from '../contracts.ts';
import { markerDetector, MARKER } from '../perception/fiducial.ts';
import { framePng, renderCamera, type CameraPose, type MarkerSurface } from './pixel-camera.ts';

/** Optional device adapter. Only rendering reads the scene; reusable perception receives pixels. */
export function fiducialCamera(options: {
  scene(context: SensorContext): { bodies: BodySpec[]; markers: MarkerSurface[] };
  orientation(context: SensorContext): Omit<CameraPose, 'position'>;
  record?: (frame: { acquiredMs: number; robotId: string; png: Buffer; sha256: string; calibration: unknown; processingMs: number }) => string;
}): SensorPlugin {
  const detect = markerDetector();
  return { id: 'fiducial-camera', requires: ['bodies'], sample(context, spec) {
    if (spec.hz > 10) throw new Error('Software pixel camera supports at most 10 Hz');
    const started = performance.now(), scene = options.scene(context), orientation = options.orientation(context);
    const { image, calibration } = renderCamera(scene.bodies, scene.markers, { position: context.mount.position, ...orientation });
    // Noise is applied to pixels BEFORE detection, not to ground-truth distances or corners.
    for (let i = 0; i < image.data.length; i += 4) { const n = Math.round((context.random() * 2 - 1) * 2); for (let c = 0; c < 3; c++) image.data[i + c] = Math.max(0, Math.min(255, image.data[i + c]! + n)); }
    const detections = detect(image, calibration), png = framePng(image), sha256 = createHash('sha256').update(png).digest('hex');
    const processingMs = performance.now() - started;
    const frame = options.record?.({ acquiredMs: context.simMs, robotId: context.robotId, png, sha256, calibration, processingMs }) ?? null;
    return { kind: 'pixel-fiducial-detections', headingDeg: orientation.headingDeg + (context.random() * 2 - 1) * .5,
      pitchDeg: orientation.pitchDeg + (context.random() * 2 - 1) * .25, hfovDeg: orientation.hfovDeg, aspect: 16 / 9,
      attitudeSource: 'simulated onboard heading estimate and gimbal encoder; no position', calibration, marker: MARKER,
      detections, frame, sha256, processingMs, image: { width: image.width, height: image.height, format: 'rectified RGBA8' } };
  } };
}

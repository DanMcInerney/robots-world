import { createHash } from 'node:crypto';
import type { BodySpec, SensorContext, SensorPlugin } from '../contracts.ts';
import { colorTracker } from '../perception/color-tracks.ts';
import { framePng, renderCamera, type CameraPose } from './pixel-camera.ts';

/** Optional simulation device. The tracker is separately reusable against real rectified RGBA. */
export function colorCamera(options: {
  scene(context: SensorContext): BodySpec[];
  orientation(context: SensorContext): Omit<CameraPose, 'position'>;
  record?: (frame: { acquiredMs: number; png: Buffer; sha256: string; calibration: { fx: number; fy: number; cx: number; cy: number } }) => string;
}): SensorPlugin {
  const trackers = new Map<string, ReturnType<typeof colorTracker>>();
  return { id: 'color-camera', requires: ['bodies'], sample(context, spec) {
    if (spec.hz > 10) throw new Error('Software camera supports at most 10 Hz');
    const started = performance.now(), orientation = options.orientation(context);
    const { image, calibration } = renderCamera(options.scene(context), [], { position: context.mount.position, ...orientation }, 320, 180);
    const illumination = .85 + .15 * Math.sin(context.simMs / 3700);
    for (let i = 0; i < image.data.length; i += 4) for (let c = 0; c < 3; c++) image.data[i + c] = Math.max(0, Math.min(255, Math.round(image.data[i + c]! * illumination + (context.random() * 2 - 1) * 2)));
    const renderMs = performance.now() - started, processing = performance.now(), trackerKey = `${context.robotId}/${spec.id}`;
    let track = trackers.get(trackerKey); if (!track) { track = colorTracker(); trackers.set(trackerKey, track); }
    const measurements = track(image, calibration, context.simMs), perceptionMs = performance.now() - processing;
    const png = framePng(image), sha256 = createHash('sha256').update(png).digest('hex');
    const frame = options.record?.({ acquiredMs: context.simMs, png, sha256, calibration }) ?? null;
    return { kind: 'color-regions-v1', ...measurements, headingDeg: orientation.headingDeg + (context.random() * 2 - 1) * .5,
      pitchDeg: orientation.pitchDeg + (context.random() * 2 - 1) * .25, hfovDeg: orientation.hfovDeg,
      frame, sha256, calibration, image: { width: image.width, height: image.height }, renderMs, perceptionMs,
      totalProcessingMs: performance.now() - started, range: null,
      limitations: 'Bright chromatic regions only; no semantic object labels, range, depth or free-space sensing. Track IDs are uncertain image associations. History is image motion without ego-motion compensation.' };
  } };
}

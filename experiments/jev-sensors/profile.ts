import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { BodySpec } from '../../src/contracts.ts';
import { tfLuna } from '../../src/devices/tf-luna.ts';
import { fiducialCamera } from '../../src/devices/fiducial-camera.ts';
import { yawDegrees } from '../../src/devices/aim-camera.ts';
import { compose, pose, vec } from '../../src/math.ts';
import { MARKER } from '../../src/perception/fiducial.ts';
import type { SensorExperiment } from '../reactive/world.ts';

import { SENSOR_ARMS, type SensorArm } from './contract.ts';
export { SENSOR_ARMS, type SensorArm } from './contract.ts';
export function sensorProfile(arm: SensorArm, frameDirectory?: string): SensorExperiment {
  if (!Object.hasOwn(SENSOR_ARMS, arm)) throw new Error('Unknown sensor arm');
  if (frameDirectory) mkdirSync(frameDirectory, { recursive: true });
  return { id: arm, sourceSensor: 'camera', configure(scenario, registry, kit) {
    const drone = scenario.robots.find(r => r.id === 'drone')!;
    drone.sensors = [{ id: 'camera', type: 'fiducial-camera', hz: 5, latencyMs: 100, dropout: .02, maxAgeMs: 500 }];
    // Fixed body mount: beam pitches 30 degrees downward, independently of camera tilt.
    if (arm === 'sensor-tfluna') drone.sensors.push({ id: 'rangefinder', type: 'tf-luna', hz: 50, latencyMs: 20, dropout: .02, maxAgeMs: 150,
      mount: { position: vec(.29, 0, 0), rotation: { x: 0, y: Math.sin(Math.PI / 12), z: 0, w: Math.cos(Math.PI / 12) } } });
    registry.sensors.set('tf-luna', tfLuna(body => body === 'ground' ? .25 : body === 'target/base' ? .1 : .3));
    const camera = fiducialCamera({
      orientation: context => ({ headingDeg: yawDegrees(context.physics.body(context.link).pose.rotation), ...kit.inspectCamera(context.robotId) }),
      scene: context => {
        // Shape definitions used solely to synthesize optical images. Perception receives no scene handles.
        const bodies: BodySpec[] = scenario.obstacles.map(body => ({ ...body, pose: context.physics.body(body.id).pose }));
        for (const robot of scenario.robots) if (robot.id !== context.robotId) {
          if (robot.model !== 'kinematic') throw new Error('This experiment renderer requires the declared box rover');
          bodies.push({ id: `${robot.id}/base`, mode: 'kinematic', pose: context.physics.body(`${robot.id}/base`).pose, shape: { kind: 'box', size: vec(.55, .55, .18), color: '#478bff' } });
        }
        const mount = { ...pose(0, 0, .092), rotation: { x: 0, y: 0, z: -Math.SQRT1_2, w: Math.SQRT1_2 } };
        return { bodies, markers: [{ bodyId: 'target/base', pose: compose(context.physics.body('target/base').pose, mount), sizeM: MARKER.sizeM, markerId: MARKER.id }] };
      },
      record: frameDirectory ? frame => {
        const file = `camera-${Math.round(frame.acquiredMs)}.png`;
        writeFileSync(resolve(frameDirectory, file), frame.png, { flag: 'wx' });
        return `frames/${basename(frameDirectory)}/${file}`;
      } : undefined,
    });
    registry.sensors.set(camera.id, camera);
  } };
}

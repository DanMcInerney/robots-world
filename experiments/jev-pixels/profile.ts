import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { BodySpec } from '../../src/contracts.ts';
import { colorCamera } from '../../src/devices/color-camera.ts';
import { yawDegrees } from '../../src/devices/aim-camera.ts';
import { vec } from '../../src/math.ts';
import type { ReactiveTask, SensorExperiment } from '../reactive/world.ts';

export const PIXEL_TASK: ReactiveTask = {
  id: 'blue-object-image-size-v1',
  goal: version => `Find the blue object and follow it as it moves. Keep its centre in the central 30 percent of the image horizontally and vertically, and its visible width between ${version === 1 ? '8 and 14' : '14 and 22'} percent of image width. Use the wide 70-degree camera view. Keep adapting throughout the task. You may move the drone and adjust camera heading and pitch. Avoid touching visible surfaces; unknown regions are not certified clear.`,
  framed: v => v.visible && Math.abs(v.u) <= .3 && Math.abs(v.v) <= .3 && v.hfov === 70 && v.widthFraction >= (v.goalVersion === 1 ? .08 : .14) && v.widthFraction <= (v.goalVersion === 1 ? .14 : .22),
};
export function pixelProfile(directory?: string): SensorExperiment {
  if (directory) mkdirSync(directory, { recursive: true });
  return { id: 'rgb-color-tracks-v1', sourceSensor: 'camera', configure(scenario, registry, kit) {
    const drone = scenario.robots.find(r => r.id === 'drone')!, theta = scenario.seed % 4 * Math.PI / 2;
    // Predeclared initial view for all arms, never a target-dependent camera correction.
    const heading = theta + Math.PI / 4;
    drone.pose.rotation = { x: 0, y: 0, z: Math.sin(heading / 2), w: Math.cos(heading / 2) };
    drone.sensors = [{ id: 'camera', type: 'color-camera', hz: 5, latencyMs: 100, dropout: .02, maxAgeMs: 500 }];
    scenario.obstacles.push({ id: 'cyan-distractor', mode: 'fixed', pose: { position: vec(-2 * Math.cos(theta) - 3 * Math.sin(theta), -2 * Math.sin(theta) + 3 * Math.cos(theta), .6), rotation: { x: 0, y: 0, z: 0, w: 1 } }, shape: { kind: 'box', size: vec(.5, .5, 1.2), color: '#40d6c8' } });
    const camera = colorCamera({
      orientation: c => ({ headingDeg: yawDegrees(c.physics.body(c.link).pose.rotation), ...kit.inspectCamera(c.robotId) }),
      scene: c => {
        const bodies: BodySpec[] = scenario.obstacles.map(b => ({ ...b, pose: c.physics.body(b.id).pose }));
        for (const robot of scenario.robots) if (robot.id !== c.robotId) {
          if (robot.model !== 'kinematic') throw new Error('This experiment renderer requires declared box robots');
          bodies.push({ id: `${robot.id}/base`, mode: 'kinematic', pose: c.physics.body(`${robot.id}/base`).pose, shape: { kind: 'box', size: vec(.55, .55, .18), color: String(robot.config?.color ?? '#478bff') } });
        }
        return bodies;
      },
      record: directory ? f => { const name = `camera-${Math.round(f.acquiredMs)}.png`; writeFileSync(resolve(directory, name), f.png, { flag: 'wx' }); writeFileSync(resolve(directory, name.replace('.png', '.json')), JSON.stringify({ acquiredMs: f.acquiredMs, calibration: f.calibration, sha256: f.sha256 }), { flag: 'wx' }); return `frames/${basename(directory)}/${name}`; } : undefined,
    });
    registry.sensors.set(camera.id, camera);
  } };
}

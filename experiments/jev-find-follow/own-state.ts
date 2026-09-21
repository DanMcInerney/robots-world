/** Own-state derived from the drone's RobotPort, with configurable noise — declared, never
 * simulator-exact (PRINCIPLES.md #10: "state every physical assumption"). Heading/altitude noise
 * defaults follow experiments/jev-spatial/profile.ts's own declared figures (heading +-0.5 deg
 * uniform, position +-0.08 m), reused here as the default noise envelope for this engine's own
 * odometry, not copied code.
 */
import type { BodyState } from '../../src/contracts.ts';
import { randomStream } from '../../src/math.ts';
import type { OwnState } from './types.ts';

export interface OwnStateNoiseConfig {
  headingNoiseDegUniform: number;
  altitudeNoiseMUniform: number;
  odometryNoiseMUniform: number;
}
export const DEFAULT_OWN_STATE_NOISE: OwnStateNoiseConfig = Object.freeze({
  headingNoiseDegUniform: 0.5,
  altitudeNoiseMUniform: 0.08,
  odometryNoiseMUniform: 0.08,
});

function quatToYawDeg(q: BodyState['pose']['rotation']): number {
  return Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z)) * 180 / Math.PI;
}

/** Stateful own-state tracker: seeded per-episode noise (repeatable given seed) and cumulative
 * odometry displacement from the episode's initial position, both declared and bounded. */
export function createOwnStateTracker(seed: number, initialPosition: { x: number; y: number; z: number }, noise: OwnStateNoiseConfig = DEFAULT_OWN_STATE_NOISE) {
  const headingRandom = randomStream(seed, 'find-follow-own-state-heading');
  const altitudeRandom = randomStream(seed, 'find-follow-own-state-altitude');
  const odometryRandomX = randomStream(seed, 'find-follow-own-state-odom-x');
  const odometryRandomY = randomStream(seed, 'find-follow-own-state-odom-y');
  const uniform = (rand: () => number, halfSpread: number) => (rand() * 2 - 1) * halfSpread;
  return {
    sample(body: BodyState, acquiredSimMs: number): OwnState {
      const trueHeadingDeg = quatToYawDeg(body.pose.rotation);
      const trueAltitudeM = body.pose.position.z;
      const displacementX = body.pose.position.x - initialPosition.x + uniform(odometryRandomX, noise.odometryNoiseMUniform);
      const displacementY = body.pose.position.y - initialPosition.y + uniform(odometryRandomY, noise.odometryNoiseMUniform);
      return {
        headingDeg: Math.round((trueHeadingDeg + uniform(headingRandom, noise.headingNoiseDegUniform)) * 10) / 10,
        altitudeM: Math.round((trueAltitudeM + uniform(altitudeRandom, noise.altitudeNoiseMUniform)) * 1000) / 1000,
        odometryDisplacementM: { x: Math.round(displacementX * 1000) / 1000, y: Math.round(displacementY * 1000) / 1000 },
        acquiredSimMs,
      };
    },
  };
}

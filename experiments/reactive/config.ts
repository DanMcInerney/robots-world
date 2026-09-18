/** Experiment settings, not a second simulator configuration system. Freeze with the source. */
export const DEFAULT_CONFIG = {
  version: 'reactive-v3',
  commandSeconds: 3,
  sourceAgeLimitMs: 5000,
  minimumRefreshMs: 750,
  link: { latencyMs: 60, jitterMs: 40, loss: .02 },
  representation: { speeds: [.4, 1.2] },
  sensors: { cooperativeBeacon: true, odometryNoiseM: .01, cameraNoiseUv: .01, cameraRangeNoiseM: .03, detectionDropout: .02, rangeRegistrationNoiseM: .03 },
  scoring: { id: 'sustained-framing-v1', warmupMs: 5000, minimumFramingFraction: .5, minimumDwellMs: 1000 },
};
export type ExperimentConfig = typeof DEFAULT_CONFIG;
export function experimentConfig(input: ExperimentConfig = DEFAULT_CONFIG): ExperimentConfig {
  const c = structuredClone(input);
  const finite = (n: number, lo: number, hi: number) => Number.isFinite(n) && n >= lo && n <= hi;
  if (c.version !== 'reactive-v3' || c.scoring.id !== 'sustained-framing-v1' ||
    !finite(c.commandSeconds, .5, 8) || !finite(c.sourceAgeLimitMs, 20, 5000) || !finite(c.minimumRefreshMs, 20, 10000) ||
    !finite(c.link.latencyMs, 0, 500) || !finite(c.link.jitterMs, 0, 500) || !finite(c.link.loss, 0, 1) ||
    !c.representation.speeds.length || c.representation.speeds.length > 2 || new Set(c.representation.speeds).size !== c.representation.speeds.length || c.representation.speeds.some(n => !finite(n, .05, 2)) ||
    typeof c.sensors.cooperativeBeacon !== 'boolean' || !finite(c.sensors.odometryNoiseM, 0, .2) || !finite(c.sensors.cameraNoiseUv, 0, .5) || !finite(c.sensors.cameraRangeNoiseM, 0, 2) || !finite(c.sensors.detectionDropout, 0, 1) || !finite(c.sensors.rangeRegistrationNoiseM, 0, .5) ||
    !finite(c.scoring.warmupMs, 0, 10000) || !finite(c.scoring.minimumFramingFraction, .01, 1) || !finite(c.scoring.minimumDwellMs, 20, 5000)) throw new Error('Invalid reactive experiment configuration');
  // Plain JSON all the way down; a controller cannot mutate settings during a run.
  const freeze = (value: any): any => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
  return freeze(c);
}
export const CAPABILITIES = {
  movement: 'Continuous ENU position or velocity setpoints; no direct motor, pitch or roll control',
  maxSpeedMps: 2, maxAccelerationMps2: 4, velocityGain: 4, positionGain: 1.8,
  headingDeg: [-180, 180], cameraPitchDeg: [-85, 45], cameraHfovDeg: [35, 70],
  envelope: { xyM: 18, minZM: .7, maxZM: 6 },
  fallback: 'Local hold: simplified plant brakes immediately and holds position. No mission action or obstacle avoidance.',
};

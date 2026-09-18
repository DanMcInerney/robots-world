import type { Observation, Vec3 } from '../src/contracts.ts';
import { wrapDegrees } from '../src/devices/aim-camera.ts';

export type FlightAction = { mode: 'position' | 'velocity' | 'hold' | 'continue'; x: number; y: number; z: number; heading: number; pitch: number; hfov: number; duration: number };
export type FlightEncoding = 'axes' | 'vectors';
export type FlightArm = 'jev' | 'claude' | 'codex' | 'hybrid';
export interface FlightState { goal: string; simMs: number; observation: Observation; position: Vec3; camera: { headingDeg: number; pitchDeg: number; hfovDeg: number }; beacon: unknown; measuredGeometry?: unknown; active: { action: FlightAction; expiresSimMs: number } | null }
export const FLIGHT_CONTRACT = `Control an ENU drone: x east, y north, z up, metres and seconds. Heading is degrees: 0 east, +90 north, +/-180 west, -90 south. Pitch is camera pitch, negative down, independent of body attitude. All controls are absolute except velocity. Choose mode position (fly to arbitrary xyz), velocity (ENU m/s), hold (brake at current position), or continue (preserve current movement and its expiry). Every mode sets absolute heading, camera pitch and hfov. Movement and camera run concurrently. Commands last duration seconds from admission, then brake; continue does not extend movement lifetime. Position/velocity setpoints use a local acceleration servo, max speed 2 m/s and acceleration 4 m/s². Heading slews at up to 120 deg/s; camera pitch at 90 deg/s. No automatic target tracking, route choice, aiming or obstacle avoidance. World/sensors keep running while you think. Use dated beacon messages, odometry, camera detections and range sensors; absent camera detections mean not currently visible. No future target route or hidden world map is available. Camera detections are ideal point detections; u,v are normalized image coordinates, +/-1 image edges. Lidar rays are in the body frame, horizontal only. The target's cooperative radio beacon includes measured pose, heading and velocity; predict cautiously because it can turn. Choose xyz and camera angles yourself. No inspect/follow macro exists. Avoid collisions and stay at altitude 0.7..6 m inside x,y +/-18 m. Do not treat prior commands as fresh observations.`;
const numeric = (minimum: number, maximum: number) => ({ type: 'number', minimum, maximum });
export const actionSchema = { type: 'object', additionalProperties: false, required: ['mode', 'x', 'y', 'z', 'heading', 'pitch', 'hfov', 'duration'], properties: {
  mode: { enum: ['position', 'velocity', 'hold', 'continue'] }, x: numeric(-18, 18), y: numeric(-18, 18), z: numeric(-6, 6), heading: numeric(-180, 180), pitch: numeric(-85, 45), hfov: { enum: [35, 70] }, duration: numeric(.5, 8),
} };
export function validateAction(value: unknown): FlightAction {
  const a = value as FlightAction;
  if (!a || Object.keys(a).length !== 8 || !['position', 'velocity', 'hold', 'continue'].includes(a.mode)) throw new Error('Invalid flight action');
  for (const [k, lo, hi] of [['x', -18, 18], ['y', -18, 18], ['z', -6, 6], ['heading', -180, 180], ['pitch', -85, 45], ['duration', .5, 8]] as const) if (typeof a[k] !== 'number' || !Number.isFinite(a[k]) || a[k] < lo || a[k] > hi) throw new Error(`Invalid ${k}`);
  if (![35, 70].includes(a.hfov) || a.mode === 'velocity' && [a.x, a.y, a.z].some(v => Math.abs(v) > 2) || a.mode === 'position' && a.z < .7) throw new Error('Action outside vehicle limits');
  return structuredClone(a);
}
export interface FlightMenu { request: { model: string; state: unknown; questions: Record<string, { type: 'choice'; instructions: string; criteria: Record<string, unknown> }> }; values: Record<string, Record<string, unknown>> }
/** Generic Cartesian grids. Does not read goal, beacon, camera detections, obstacles or evaluator. */
export function flightMenu(state: FlightState, encoding: FlightEncoding, proposals: FlightAction[] = []): FlightMenu {
  const questions: FlightMenu['request']['questions'] = {}, values: FlightMenu['values'] = {};
  const q = (id: string, instruction: string, options: unknown[]) => {
    values[id] = Object.fromEntries(options.map((v, i) => [`v${i}`, v]));
    questions[id] = { type: 'choice', instructions: `${FLIGHT_CONTRACT} ${instruction} Follow the exact goal in state.`, criteria: Object.fromEntries(Object.entries(values[id]!).map(([k, v]) => [k, typeof v === 'number' ? String(v) : v])) };
  };
  q('mode', 'Choose the movement mode. Other questions speculatively choose parameters; only the selected mode parameters are applied.', ['position', 'velocity', 'hold', 'continue']);
  const velocities = [-1.2, -.4, 0, .4, 1.2];
  const offsets = [-4, -2, 0, 2, 4];
  const axes = (mode: 'position' | 'velocity') => ['x', 'y', 'z'].map(axis => mode === 'velocity' ? velocities : [...new Set(offsets.map(v => Number(Math.max(axis === 'z' ? .7 : -18, Math.min(axis === 'z' ? 6 : 18, state.position[axis as keyof Vec3] + v * (axis === 'z' ? .4 : 1))).toFixed(2))))]);
  for (const mode of ['position', 'velocity'] as const) {
    const [xs, ys, zs] = axes(mode);
    if (encoding === 'axes') for (const [i, axis] of ['x', 'y', 'z'].entries()) q(`${mode}_${axis}`, `If choosing ${mode}, choose its ${axis} coordinate ${mode === 'velocity' ? 'in m/s' : 'in metres absolute ENU'}.`, axes(mode)[i]!);
    else q(mode, `If choosing ${mode}, choose its complete coordinated XYZ vector ${mode === 'velocity' ? 'in m/s' : 'in metres absolute ENU'}.`, xs!.flatMap(x => ys!.flatMap(y => zs!.map(z => ({ x, y, z })))));
  }
  q('heading', 'Choose absolute body/camera heading in degrees.', [-180, -90, -45, -20, -7, 0, 7, 20, 45, 90].map(d => Number(wrapDegrees(state.camera.headingDeg + d).toFixed(2))));
  q('pitch', 'Choose absolute camera pitch in degrees.', [-75, -60, -45, -30, -20, -10, 0, 15]);
  q('hfov', 'Choose camera horizontal field of view in degrees: 35 zoomed or 70 wide.', [35, 70]);
  q('duration', 'Choose movement lifetime in seconds. A later command can replace it sooner.', [1, 3, 8]);
  if (proposals.length) q('proposal', 'Choose one complete Codex-proposed maneuver if it fits CURRENT observations, or use independently selected controls. Proposals may be stale or wrong. The original goal and latest sensor evidence always govern.', ['use_independent_controls', ...proposals]);
  return { request: { model: 'jev-1.13.0', state, questions }, values };
}
export function decodeFlight(body: unknown, menu: FlightMenu, encoding: FlightEncoding) {
  const response = body as { model?: string; answers?: Record<string, { type?: string; choice?: string; probabilities?: Record<string, number>; confidence?: number }> };
  if (response.model !== 'jev-1.13.0') throw new Error('Unexpected Jev model');
  const rounding: { question: string; sum: number }[] = [];
  function select(id: string): any {
    const options = menu.values[id]!;
    const answer = response.answers?.[id], probabilities = answer?.probabilities;
    if (answer?.type !== 'choice' || !answer.choice || !(answer.choice in options) || !probabilities || Object.keys(probabilities).length !== Object.keys(options).length || Object.keys(options).some(k => !(k in probabilities))) throw new Error(`Invalid choice ${id}`);
    const ps = Object.values(probabilities), sum = ps.reduce((a, b) => a + b, 0);
    if (ps.some(p => !Number.isFinite(p) || p < 0 || p > 1) || probabilities[answer.choice]! < Math.max(...ps) - 1e-8) throw new Error(`Invalid probabilities ${id}`);
    // Hundredth-rounded distributions can deviate by up to 0.005 per nonzero bin.
    // This is validation of raw transport rounding, not renormalization or evidence of calibration.
    if (Math.abs(sum - 1) > 1e-6) {
      const tolerance = ps.filter(p => p > 0).length * .005 + 1e-6;
      if (!ps.every(p => Math.abs(p * 100 - Math.round(p * 100)) < 1e-6) || Math.abs(sum - 1) > Math.min(.06, tolerance)) throw new Error(`Invalid probability sum ${id}:${sum}`);
      rounding.push({ question: id, sum });
    }
    return options[answer.choice];
  }
  // Speculative answers for an unselected branch never actuate. Their complete raw responses
  // remain logged, but a malformed unused velocity answer cannot invalidate a position command.
  const proposal = menu.values.proposal ? select('proposal') : undefined;
  if (proposal && proposal !== 'use_independent_controls') return { action: validateAction(proposal), rounding, usedProposal: true };
  const mode = select('mode') as FlightAction['mode'];
  const xyz = mode === 'hold' || mode === 'continue' ? { x: 0, y: 0, z: 0 } : encoding === 'vectors' ? select(mode) : { x: select(`${mode}_x`), y: select(`${mode}_y`), z: select(`${mode}_z`) };
  return { action: validateAction({ mode, ...xyz, heading: select('heading'), pitch: select('pitch'), hfov: select('hfov'), duration: select('duration') }), rounding, usedProposal: false };
}

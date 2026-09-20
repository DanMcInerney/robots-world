import { imageMotion } from '../../src/perception/image-motion.ts';
import { MODEL, choice, type Request, type Response } from '../jev-strategies/strategies.ts';
import { SPEEDS, YAW, PITCH, pixelRequest, mapPixelAnswer, pixelAction, type PixelControlDesign } from '../jev-pixels/controller.ts';

export const LOOP_ARMS = {
  'loop-baseline': { label: 'A · Original words', description: 'Original six numeric-key menus and current image measurements. Matched baseline.' },
  'loop-semantic': { label: 'B · Physical control names', description: 'Same measurements and all controls; physical option names and narrower effect-based questions.' },
  'loop-temporal': { label: 'C · Names + motion history', description: 'B plus image-plane rates, measured camera-angle rates and bounded last-seen regions. No range or predicted positions.' },
  'loop-paired': { label: 'D · History + paired controls', description: 'Same state as C; 49 XY choices and 63 heading/pitch choices replace four independent questions. Every command remains available.' },
} as const;
export type LoopArm = keyof typeof LOOP_ARMS;

const magnitude = (n: number) => String(Math.abs(n)).replace('.', 'p');
export const names = {
  forward: (n: number) => n === 0 ? 'hold_forward_axis' : `${n > 0 ? 'forward' : 'backward'}_${magnitude(n)}_mps`,
  right: (n: number) => n === 0 ? 'hold_lateral_axis' : `${n > 0 ? 'right' : 'left'}_${magnitude(n)}_mps`,
  up: (n: number) => n === 0 ? 'hold_vertical_axis' : `${n > 0 ? 'climb' : 'descend'}_${magnitude(n)}_mps`,
  yaw: (n: number) => n === 0 ? 'keep_heading' : `turn_${n > 0 ? 'left' : 'right'}_${magnitude(n)}_deg`,
  pitch: (n: number) => n === 0 ? 'keep_pitch' : `tilt_${n > 0 ? 'up' : 'down'}_${magnitude(n)}_deg`,
};
const dictionaries = Object.fromEntries(Object.entries(names).map(([axis, name]) => [axis, Object.fromEntries((axis === 'yaw' ? YAW : axis === 'pitch' ? PITCH : SPEEDS).map(n => [name(n), n]))])) as Record<keyof typeof names, Record<string, number>>;
const xy = Object.fromEntries(SPEEDS.flatMap(f => SPEEDS.map(r => [`${names.forward(f)}__${names.right(r)}`, [f, r]])));
const angles = Object.fromEntries(YAW.flatMap(y => PITCH.map(p => [`${names.yaw(y)}__${names.pitch(p)}`, [y, p]])));

export function loopDesign(arm: LoopArm): PixelControlDesign {
  if (!Object.hasOwn(LOOP_ARMS, arm)) throw new Error('Unknown loop arm');
  const temporal = imageMotion();
  return {
    request(observation, _arm, feedback) {
      const request = pixelRequest(observation, 'pixels-words', feedback);
      const state = request.state as Record<string, unknown>;
      if (arm === 'loop-baseline') return request;
      if (arm === 'loop-temporal' || arm === 'loop-paired') {
        const camera = observation.sensors.camera!, value = camera.value as any;
        state.temporal = temporal({ objects: value.objects, headingDeg: value.headingDeg, pitchDeg: value.pitchDeg, hfovDeg: value.hfovDeg, acquiredMs: camera.acquiredSimMs }, observation.simMs);
        state.feedbackLimits = 'Recent receipts confirm admission only. Achieved velocity, actual application time, position and range remain unknown. Changes in measured camera angles and image tracks are the available outcome evidence.';
      }
      const effect: Record<keyof typeof names, string> = {
        forward: 'Choose forward/backward velocity to manage apparent size and follow the intended region. Forward translation toward a stationary object tends to enlarge it; backward tends to shrink it. Object motion, turning and zoom can also change size. No metre range is known.',
        right: 'Choose lateral velocity for the visual goal. Moving right tends to shift a stationary forward object left in the image; moving left tends to shift it right. Camera turning can also centre an object.',
        up: 'Choose vertical velocity for the visual goal. Climbing tends to shift a stationary object down in the image; descending shifts it up. Camera tilt can also centre an object.',
        yaw: 'Choose one body/camera heading adjustment using the intended region horizontal image position. A LEFT turn shifts a stationary scene RIGHT; a RIGHT turn shifts it LEFT. Keep heading means zero increment. Consider measured error, observation age and the goal.',
        pitch: 'Choose one camera tilt adjustment using the intended region vertical image position. Tilting UP shifts a stationary scene DOWN; tilting DOWN shifts it UP. Keep pitch means zero increment. Consider measured error, observation age and the goal.',
      };
      for (const axis of Object.keys(names) as (keyof typeof names)[]) {
        const old = request.questions[axis]!;
        if (old.type !== 'choice') throw new Error('Expected a Choice menu');
        request.questions[axis] = { ...old, instructions: `Use state.contract and the exact state.goal. ${effect[axis]} Choose only this axis immediate setpoint; other answers are unavailable. Do not narrate a plan.`, criteria: Object.fromEntries(Object.entries(old.criteria).map(([key, description]) => [names[axis]((axis === 'yaw' ? YAW : axis === 'pitch' ? PITCH : SPEEDS)[Number(key.slice(1))]!), description])) };
      }
      if (arm === 'loop-paired') {
        const pair = (first: 'forward' | 'yaw', second: 'right' | 'pitch', entries: Record<string, number[]>) => {
          const q1 = request.questions[first]!, q2 = request.questions[second]!;
          if (q1.type !== 'choice' || q2.type !== 'choice') throw new Error('Expected Choice menus');
          return { type: 'choice' as const, instructions: `Use state.contract and the exact state.goal. ${effect[first]} ${effect[second]} For this paired question select BOTH ${first} and ${second} values together from the full list; coordinate their immediate effect. Answers to the other questions are unavailable.`, criteria: Object.fromEntries(Object.entries(entries).map(([key, [a, b]]) => [key, `${q1.criteria[names[first](a!)]}; ${q2.criteria[names[second](b!)]}`])) };
        };
        request.questions.xy = pair('forward', 'right', xy); request.questions.angles = pair('yaw', 'pitch', angles);
        for (const key of ['forward', 'right', 'yaw', 'pitch']) delete request.questions[key];
      }
      return request;
    },
    map: arm === 'loop-baseline' ? mapPixelAnswer : mapLoopAnswer,
  };
}
export function mapLoopAnswer(request: Request, response: Response) {
  if (response.model !== MODEL || Object.keys(response.answers).sort().join() !== Object.keys(request.questions).sort().join()) throw new Error('Unexpected Jev response schema/model');
  const selections = Object.fromEntries(Object.entries(request.questions).map(([id, q]) => [id, choice(response, id, Object.keys(q.criteria))]));
  const [forward, right] = selections.xy ? xy[selections.xy]! : [dictionaries.forward[selections.forward!]!, dictionaries.right[selections.right!]!];
  const [yaw, pitch] = selections.angles ? angles[selections.angles]! : [dictionaries.yaw[selections.yaw!]!, dictionaries.pitch[selections.pitch!]!];
  const bodyVelocity = [forward!, right!, dictionaries.up[selections.up!]!];
  return { selections, bodyVelocity, action: pixelAction((request.state as any).camera, bodyVelocity, yaw!, pitch!, selections.zoom === 'wide' ? 70 : 35) };
}

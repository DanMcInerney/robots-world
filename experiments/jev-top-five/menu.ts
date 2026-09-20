import assert from 'node:assert/strict';
import type { BodySpec } from '../../src/contracts.ts';
import { renderCamera, framePng } from '../../src/devices/pixel-camera.ts';
import { colorRegions } from '../../src/perception/color-tracks.ts';
import { MODEL, type Request } from '../jev-strategies/strategies.ts';
import type { Probe, Answers, Score, Split } from './types.ts';

const radians = Math.PI / 180;
const moves = [-30, -10, -3, 3, 10, 30];
const round = (v: number) => Math.round(v * 1e6) / 1e6;
export const MENU_ANGLES = {
  development: [-1.5, 1.5, -4, 4, -13, 13, -28, 28],
  confirmation: [-2.5, 2.5, -3.5, 3.5, -12, 12, -27, 27],
} satisfies Record<Split, number[]>;
const goal = 'Keep the single measured blue region entirely in view with its center between -5 and +5 degrees inclusive. If it is already in that band, hold the current heading. Otherwise choose the smallest absolute turn that places its center in the band while keeping the rectangle in view. No translation. Choose from the supplied physical actions; duplicate IDs are equivalent executions, not additional evidence.';

/** Scene coordinates end at the renderer boundary. The request builder uses pixels/calibration only. */
export function menuFrame(split: Split, index: number) {
  const angle = MENU_ANGLES[split][index]; assert(angle !== undefined);
  const body: BodySpec = { id: 'render-only-blue-box', mode: 'fixed',
    pose: { position: { x: 12, y: -12 * Math.tan(angle * radians), z: 1.4 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
    shape: { kind: 'box', size: { x: 0.8, y: 0.7, z: 0.6 }, color: '#2048dd' } };
  const rendered = renderCamera([body], [], { position: { x: 0, y: 0, z: 1.4 }, headingDeg: 0, pitchDeg: 0, hfovDeg: 70 }, 320, 180);
  const regions = colorRegions(rendered.image, rendered.calibration).filter(r => r.color === 'blue');
  assert.equal(regions.length, 1); assert.equal(regions[0]!.clipped, false);
  return { ...rendered, region: regions[0]!, png: framePng(rendered.image) };
}

function consequences(split: Split, index: number) {
  const { region, calibration: k } = menuFrame(split, index);
  const [x0, y0, x1, y1] = region.box;
  const center = Math.atan(((x0 + x1) / 2 - k.cx) / k.fx) / radians;
  return { region, k, center, effects: [0, ...moves].map(turn => {
    const c = Math.cos(turn * radians), s = Math.sin(turn * radians);
    const corners = [[x0, y0], [x0, y1], [x1, y0], [x1, y1]].map(([x, y]) => {
      const right = (x! - k.cx) / k.fx, up = (k.cy - y!) / k.fy, forward = c - right * s;
      return forward <= 0 ? null : [k.cx + k.fx * (right * c + s) / forward, k.cy - k.fy * up / forward];
    });
    const visible = corners.every(p => p && p[0]! >= 0 && p[0]! <= 320 && p[1]! >= 0 && p[1]! <= 180);
    // Rotate the measured center ray. No hidden range, scene identity or future motion is used.
    return { turnLeftDeg: turn, afterRightDeg: round(center + turn), entireRectangleVisible: visible };
  }) };
}

export function generateMenuCases(): Probe[] {
  const probes: Probe[] = [];
  for (const split of ['development', 'confirmation'] as const) for (let index = 0; index < 8; index++) {
    const measured = consequences(split, index);
    const framed = measured.effects.filter(e => e.entireRectangleVisible && Math.abs(e.afterRightDeg) <= 5);
    assert(framed.length > 0);
    const minTurn = Math.min(...framed.map(e => Math.abs(e.turnLeftDeg)));
    const expectedTurns = framed.filter(e => Math.abs(e.turnLeftDeg) === minTurn).map(e => e.turnLeftDeg);
    for (const copies of [1, 8]) {
      const physicalById: Record<string, number> = { hold: 0 };
      let moving = moves.flatMap((turn, m) => Array.from({ length: copies }, (_, copy) => ({ id: `v${m}_${copy}`, turn })));
      if (index % 2) moving.reverse();
      for (const item of moving) physicalById[item.id] = item.turn;
      const entries = Object.entries(physicalById);
      if (index % 3 === 1) entries.reverse();
      const criteria = Object.fromEntries(entries.map(([id, turn]) => [id, turn === 0 ? 'Hold the current heading without turning.' : `Rotate ${Math.abs(turn)} degrees ${turn > 0 ? 'left' : 'right'} from the acquired heading; complete the same bounded rotation as any ID with this angle.`]));
      const state = { goal, scope: 'Fresh rendered-RGB-derived stationary yaw component. This is not semantic vehicle identity, metric depth, a moving-world rollout or flight qualification.',
        measurement: { acquiredMs: 0, decisionAtMs: 0, ageMs: 0, camera: { width: 320, height: 180, calibration: measured.k }, region: measured.region, rightBearingDeg: round(measured.center) },
        assumptions: 'The acquired pixel rectangle is a stationary set of rays; each proposed rotation completes exactly before the next observation. No target motion, future occlusion, inference delay or interruption is predicted.',
        commands: Object.fromEntries(entries.map(([id, turn]) => [id, measured.effects.find(e => e.turnLeftDeg === turn)!])),
        computation: 'Pinhole arithmetic supplies consequences for every offered action symmetrically. No action is ranked or recommended. Positive yaw turns left; positive image bearing is right.' };
      for (const replicate of [0, 1]) for (const arm of ['flat', 'conditional']) {
        const request: Request = { model: MODEL, state, questions: arm === 'flat'
          ? { action: { type: 'choice' as const, instructions: 'Use state.goal and the observed facts to choose one physical action. Equivalent IDs have identical consequences.', criteria } }
          : { mode: { type: 'choice' as const, instructions: 'Use state.goal and ALL action consequences to choose whether to hold heading or rotate. Your sibling maneuver answer is unavailable; decide from the same state independently.', criteria: { hold: 'Hold current heading.', move: 'Perform one of the offered nonzero rotations.' } },
            maneuver: { type: 'choice' as const, instructions: 'Assume a nonzero rotation will be performed. Independently choose the offered nonzero rotation that best satisfies state.goal. You cannot see the sibling mode answer. This answer is consumed only if mode selects move.', criteria: Object.fromEntries(Object.entries(criteria).filter(([id]) => id !== 'hold')) } } };
        const expectedIds = entries.filter(([, turn]) => expectedTurns.includes(turn)).map(([id]) => id);
        probes.push({ id: `T4-${split}-u${index}-c${copies}-${arm}-r${replicate}`, technique: 'T4', split, unit: `u${index}`, arm, replicate, request,
          expected: arm === 'flat' ? { action: expectedIds } : { mode: [expectedTurns.includes(0) ? 'hold' : 'move'], maneuver: expectedTurns.includes(0) ? moving.map(x => x.id) : expectedIds },
          meta: { copies, physicalById, expectedTurns, frame: `frames/${split}-u${index}.png`, measuredRightDeg: round(measured.center), currentFramed: Math.abs(measured.center) <= 5,
            source: 'renderCamera -> RGBA -> colorRegions -> calibrated ray projection', imageDerived: true } });
      }
    }
  }
  assert.equal(probes.length, 128);
  return probes;
}

export function scoreMenu(probe: Probe, answers: Answers): Score {
  const id = probe.arm === 'flat' ? answers.action : answers.mode === 'hold' ? 'hold' : answers.maneuver;
  const turn = probe.meta.physicalById[id!]; assert(Number.isFinite(turn), 'Selected physical command must be offered');
  const correct = probe.meta.expectedTurns.includes(turn);
  const inappropriateMotion = probe.meta.currentFramed && turn !== 0;
  const wrongDirection = turn !== 0 && Math.sign(turn) === Math.sign(probe.meta.measuredRightDeg);
  return { correct, unsafe: inappropriateMotion || wrongDirection, decision: String(turn),
    details: { selectedId: id, physicalTurnLeftDeg: turn, mode: turn === 0 ? 'hold' : 'move', currentFramed: probe.meta.currentFramed, inappropriateMotion, wrongDirection, copies: probe.meta.copies } };
}

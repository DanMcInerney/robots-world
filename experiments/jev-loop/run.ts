import { runPixelBatch } from '../jev-pixels/run.ts';
import { LOOP_ARMS, loopDesign, type LoopArm } from './controller.ts';

await runPixelBatch({ id: 'jev-loop', definitions: LOOP_ARMS,
  questionDesign: 'All arms retain 43,218 tuples. A/B/C: six questions, 39 options total. D: XY 49, heading/pitch 63, vertical 7, FOV 2; four questions, 121 options total. Full static menus; no recommendation field or pruning.',
  design: 'Four successive ablations: A original words; B semantic names plus physical-effect question wording; C adds bounded measurement differences and historical missing regions; D pairs XY and camera axes with identical C state. Same camera, actuator mapping, goals and seeded trajectories. 2 s / 24-region memory cap; rates unknown across clipped images, zoom changes or track gaps >600 ms. Receipts remain admission-only. No neural perception, true motion, range, extrapolation or hidden controller. Development seed 82; fresh held-out seeds 1301,1302,1303; rotated arm order. Framing is reported separately from inherited global-boundary composite score.',
  makeDesign: arm => loopDesign(arm as LoopArm),
});

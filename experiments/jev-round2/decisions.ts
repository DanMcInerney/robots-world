import { createHash } from 'node:crypto';
import { MODEL, type Arm, type Probe, type SensorRecord } from './protocol.ts';

export const GOALS_M = [8, 12] as const;
export const ARMS: Arm[] = ['measured', 'consequences'];
export const TIE_EPSILON_M = 1e-9;
type Option = { action: string; deltaM: number | null };
const ACTIONS: Option[] = [
  { action: 'advance2m', deltaM: 2 }, { action: 'advance1m', deltaM: 1 },
  { action: 'hold', deltaM: 0 }, { action: 'retreat1m', deltaM: -1 },
  { action: 'retreat2m', deltaM: -2 }, { action: 'observe', deltaM: null },
];
const INSTRUCTIONS = [
  'Choose one offered action for the exact goal in state.goal. This is an offline one-step diagnostic; no flight is executed.',
  'The target surface is static. Every displacement is stipulated to complete ideally in a clear corridor, with fixed camera orientation. Z is axial depth to the visible front surface, not Euclidean range or target-centre distance. Final Z equals current Z minus the signed forward displacement.',
  'If the target is single and its axial-depth interval is usable, choose among the five displacement actions, including hold. Minimize the worst-case absolute difference between final Z and the requested goal depth over the entire measured interval. The worst case is the larger endpoint error; tied minimum actions are equally acceptable. Observation-only is not an acceptable substitute when depth is usable, even if the measurement may be inaccurate.',
  'If the target is missing or ambiguous, or its depth interval is absent or unusable, choose observe only. A usable interval has two finite, positive endpoints in increasing or equal order. Do not infer depth from image size, bearing, confidence, or a hidden reference.',
];

function usable(observation: SensorRecord['observation']): boolean {
  const interval = observation.axialDepthIntervalM;
  return observation.targetStatus === 'single' && Array.isArray(interval) && interval.length === 2
    && interval.every(v => Number.isFinite(v) && v > 0) && interval[0] <= interval[1];
}

function optionsFor(record: SensorRecord): Record<string, Option> {
  // Hold labels/order fixed across goals, methods and arms for the same scene.
  const seed = record.sceneId;
  const shuffled = ACTIONS.map(option => ({ option,
    key: createHash('sha256').update(seed + ':' + option.action).digest('hex') }))
    .sort((a, b) => a.key.localeCompare(b.key));
  return Object.fromEntries(shuffled.map(({ option }, index) => [`q${index + 1}`, { ...option }]));
}

function optimalIds(options: Record<string, Option>, interval: [number, number], goalM: number): string[] {
  const errors = Object.entries(options).filter(([, option]) => option.deltaM !== null).map(([id, option]) => ({ id,
    error: Math.max(...interval.map(z => Math.abs(z - option.deltaM! - goalM))) }));
  const best = Math.min(...errors.map(item => item.error));
  return errors.filter(item => item.error <= best + TIE_EPSILON_M).map(item => item.id);
}

/** The request and interpretation key depend only on sensor evidence and the stipulated goal/actions. */
export function generateCases(records: SensorRecord[]): Probe[] {
  if (new Set(records.map(record => record.id)).size !== records.length) throw new Error('Duplicate sensor record ID');
  return records.flatMap(record => GOALS_M.flatMap(goalM => {
    const options = optionsFor(record), supported = usable(record.observation);
    const expected = supported ? optimalIds(options, record.observation.axialDepthIntervalM!, goalM)
      : Object.keys(options).filter(id => options[id].action === 'observe');
    // Explicitly copy the sensor schema: evaluation fields and arbitrary injected fields cannot enter a request.
    const observation = record.observation;
    const sensorObservation = {
      source: observation.source, targetStatus: observation.targetStatus,
      axialDepthIntervalM: observation.axialDepthIntervalM === null ? null : [...observation.axialDepthIntervalM],
      axialDepthM: observation.axialDepthM, validFraction: observation.validFraction,
      bearingDeg: observation.bearingDeg, intervalMeaning: observation.intervalMeaning,
    };
    const commonState = {
      goal: `Reach an axial depth Z of exactly ${goalM} m from the visible front surface in this one ideal completed step.`,
      goalAxialDepthM: goalM,
      sensorObservation,
      geometry: {
        depthDefinition: 'Camera-forward axial Z to the visible front surface, in metres; not radial range or object-centre distance.',
        stipulatedScene: 'Static target surface and a clear corridor for every offered displacement; fixed camera orientation.',
        stipulatedExecution: 'The selected displacement completes exactly. Positive displacement advances; negative displacement retreats; zero holds. No flight is executed.',
        transformation: 'final Z = observed Z - signed forward displacement in metres',
      },
      actions: structuredClone(options),
    };
    const criteria = Object.fromEntries(Object.entries(options).map(([id, option]) => [id,
      option.deltaM === null ? 'Observe again without executing a displacement.'
        : option.deltaM === 0 ? 'Hold: complete zero displacement.'
          : `${option.deltaM > 0 ? 'Advance' : 'Retreat'} ${Math.abs(option.deltaM)} m: complete signed forward displacement ${option.deltaM} m.`]));
    return ARMS.map(arm => {
      const state: any = structuredClone(commonState);
      if (arm === 'consequences') state.predictedAfterAxialDepthIntervalM = Object.fromEntries(
        Object.entries(options).filter(([, option]) => option.deltaM !== null).map(([id, option]) => [id,
          supported ? observation.axialDepthIntervalM!.map(z => z - option.deltaM!) : null]));
      return {
        id: `${record.id}-goal${goalM}-${arm}`, split: record.split, sceneId: record.sceneId,
        recordId: record.id, method: record.method, arm, goalM,
        request: { model: MODEL, state, questions: { action: {
          type: 'choice' as const, instructions: [...INSTRUCTIONS], criteria: { ...criteria },
        } } },
        expected: [...expected],
        meta: { options: structuredClone(options), usableDepth: supported,
          expectedActions: expected.map(id => options[id].action),
          referenceAxialDepthM: record.evaluation.referenceAxialDepthM },
      };
    });
  }));
}

export function scoreCase(probe: Probe, answer: string | undefined) {
  const options = probe.meta.options as Record<string, Option>;
  const selected = typeof answer === 'string' && Object.hasOwn(options, answer) ? options[answer] : undefined;
  const completed = selected !== undefined;
  const interpretationCorrect = completed && probe.expected.includes(answer!);
  const unknown = !probe.meta.usableDepth;
  const reference = probe.meta.referenceAxialDepthM;
  const physicalExpected = typeof reference === 'number' && Number.isFinite(reference) && reference > 0
    ? optimalIds(options, [reference, reference], probe.goalM) : null;
  const nonzero = selected?.deltaM != null && selected.deltaM !== 0;
  const expectedActions = probe.expected.map(id => options[id].action);
  const usefulEligible = !unknown && !expectedActions.some(action => action === 'hold' || action === 'observe');
  const physicalCorrect = physicalExpected === null ? null : completed && physicalExpected.includes(answer!);
  return {
    id: probe.id, split: probe.split, sceneId: probe.sceneId, recordId: probe.recordId,
    method: probe.method, arm: probe.arm, goalM: probe.goalM,
    answer: answer ?? null, action: selected?.action ?? null, deltaM: selected?.deltaM ?? null,
    completed, interpretationCorrect, physicalCorrect, unknown,
    unsupportedMotion: unknown && nonzero,
    unsupportedCommitment: unknown && completed && selected.action !== 'observe',
    usefulCorrect: interpretationCorrect && nonzero, usefulEligible,
    usefulEligibleCorrect: usefulEligible && interpretationCorrect && nonzero,
    usefulPhysicalCorrect: physicalCorrect === null ? null : physicalCorrect && nonzero,
    finalReferenceDepthM: physicalExpected !== null && selected?.deltaM != null ? reference - selected.deltaM : null,
    expectedActions, physicalExpectedActions: physicalExpected?.map(id => options[id].action) ?? null,
  };
}

type Score = ReturnType<typeof scoreCase>;
const rate = (numerator: number, denominator: number) => denominator === 0 ? null : numerator / denominator;
function counts(rows: Score[]) {
  const n = rows.length;
  const count = (predicate: (row: Score) => boolean) => rows.filter(predicate).length;
  const interpretationCorrect = count(row => row.interpretationCorrect);
  const physicalDenominator = count(row => row.physicalCorrect !== null);
  const physicalCorrect = count(row => row.physicalCorrect === true);
  const usefulEligible = count(row => row.usefulEligible);
  const usefulEligibleCorrect = count(row => row.usefulEligibleCorrect);
  return {
    n, completed: count(row => row.completed), interpretationCorrect,
    interpretationRate: rate(interpretationCorrect, n), physicalCorrect, physicalDenominator,
    physicalRate: rate(physicalCorrect, physicalDenominator),
    supportDenom: count(row => !row.unknown), unknown: count(row => row.unknown),
    unknownCorrect: count(row => row.unknown && row.interpretationCorrect),
    unsupported: count(row => row.unsupportedMotion), unsupportedCommitments: count(row => row.unsupportedCommitment),
    useful: count(row => row.usefulCorrect), usefulEligible, usefulEligibleCorrect,
    usefulRate: rate(usefulEligibleCorrect, usefulEligible),
    usefulPhysicalCorrect: count(row => row.usefulPhysicalCorrect === true),
  };
}

function responsiveness(rows: Score[]) {
  const records = new Map<string, Score[]>();
  for (const row of rows) records.set(row.recordId, [...(records.get(row.recordId) ?? []), row]);
  let pairs = 0, completedPairs = 0, changeRequiredPairs = 0, changedActionPairs = 0, correctlyResponsivePairs = 0;
  for (const pair of records.values()) {
    const first = pair.find(row => row.goalM === GOALS_M[0]), second = pair.find(row => row.goalM === GOALS_M[1]);
    if (!first || !second) continue;
    pairs++;
    if (first.completed && second.completed) completedPairs++;
    if (first.unknown || second.unknown || first.expectedActions.some(action => second.expectedActions.includes(action))) continue;
    changeRequiredPairs++;
    if (first.completed && second.completed && first.action !== second.action) {
      changedActionPairs++;
      if (first.interpretationCorrect && second.interpretationCorrect) correctlyResponsivePairs++;
    }
  }
  return { pairs, completedPairs, changeRequiredPairs, changedActionPairs, correctlyResponsivePairs,
    correctlyResponsiveRate: rate(correctlyResponsivePairs, changeRequiredPairs) };
}

/** Accept score rows, or runner envelopes containing {probe, score} / {probe, answer}. */
export function summarize(rows: any[]) {
  const scores: Score[] = rows.map(row => row.score ?? (row.probe ? scoreCase(row.probe, row.answer) : row));
  const keys = [...new Set(scores.map(row => JSON.stringify([row.split, row.method, row.arm])))].sort();
  const groups = keys.map(key => {
    const [split, method, arm] = JSON.parse(key);
    const matching = scores.filter(row => row.split === split && row.method === method && row.arm === arm);
    return { split, method, arm, ...counts(matching), goalResponsiveness: responsiveness(matching) };
  });
  const gate = (method?: SensorRecord['method']) => {
    const confirmation = scores.filter(row => row.split === 'confirmation' && (method === undefined || row.method === method));
    const primary = counts(confirmation.filter(row => row.arm === 'consequences'));
    const measured = counts(confirmation.filter(row => row.arm === 'measured'));
    const gain = primary.interpretationRate === null || measured.interpretationRate === null
      ? null : primary.interpretationRate - measured.interpretationRate;
    const eligible = primary.n > 0 && measured.n > 0 && primary.unknown > 0 && primary.usefulEligible > 0;
    const interpretationPass = primary.interpretationRate !== null && primary.interpretationRate + 1e-12 >= .9;
    const unsupportedPass = primary.unknown > 0 && primary.unsupportedCommitments === 0;
    const usefulPass = primary.usefulRate !== null && primary.usefulRate + 1e-12 >= .8;
    const gainPass = gain !== null && gain + 1e-12 >= .1;
    return { method: method ?? 'pooled', eligible, primary, measured, interpretationGain: gain,
      interpretationPass, unsupportedPass, usefulPass, gainPass,
      pass: eligible && interpretationPass && unsupportedPass && usefulPass && gainPass };
  };
  return {
    totals: counts(scores), groups,
    gates: { split: 'confirmation', primaryArm: 'consequences',
      thresholds: { interpretationRate: .9, unsupportedCommitments: 0, usefulRate: .8, interpretationGain: .1 },
      pooled: gate(), byMethod: (['stereo', 'monocular'] as const).map(method => gate(method)),
      scope: 'Decision-component gates only. Independent perception qualification is required; no executed-flight claim.',
    },
  };
}

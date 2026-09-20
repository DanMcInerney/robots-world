import { MODEL } from '../jev-strategies/strategies.ts';
import type { Question } from '../jev-strategies/strategies.ts';
import type { Answers, Probe, Score, Split } from './types.ts';

export const IDENTITY_FIELDS = ['bodyStyle', 'paint', 'roofAttachment', 'rearWindowMark'] as const;
export type IdentityAttributes = Record<(typeof IDENTITY_FIELDS)[number], string | null>;
export type IdentityState = {
  scope: string;
  goal: string;
  decisionAtMs: number;
  targetReference: {
    referenceId: string; source: string; observationId: string;
    acquiredAtMs: number; deliveredAtMs: number; attributes: IdentityAttributes;
  };
  observation: {
    source: string; observationId: string; acquiredAtMs: number; deliveredAtMs: number;
    extraction: { detectedProposalCount: number; processedProposalCount: number; acquisitionSucceeded: boolean };
    candidates: { id: string; attributes: IdentityAttributes }[];
  };
  evidenceContract: { identityFields: readonly string[]; unknownValue: null; rule: string };
};

const ARMS = ['single_choice', 'independent_adequacy'] as const;
const SUPPORTED = 'supported_unique_match';
const UNSUPPORTED = 'no_supported_unique_match';
const ABSTENTIONS = ['none', 'ambiguous', 'incomplete'] as const;
const FAMILIES = [
  'unique_body_contrast', 'unique_paint_contrast', 'unique_roof_contrast', 'unique_mark_contrast',
  'all_lookalikes_contradict', 'missing_discriminating_attribute', 'ambiguous_twins', 'incomplete_candidate_coverage',
] as const;

// This is an explicit finite reference-compatibility rule, not a vehicle Re-ID algorithm.
const RULE = 'Compare every listed candidate with the requested reference on all identityFields. '
  + 'A null attribute is unmeasured, not a match or a contradiction. Any measured unequal field rules that candidate out. '
  + 'A candidate is fully supported only when every identity field is measured and equals the reference. '
  + 'Choose a candidate only if extraction processed every detected proposal, that candidate is fully supported, '
  + 'and every other candidate is ruled out by a measured contradiction. '
  + 'If extraction is incomplete or acquisition failed, choose incomplete; supplied detections do not establish world coverage. '
  + 'Otherwise, if every candidate has a measured contradiction choose none; '
  + 'if evidence leaves an unresolved candidate or multiple compatible candidates choose ambiguous. '
  + 'The dated reference describes the requested appearance signature; its age does not by itself invalidate matching that signature. '
  + 'A unique signature match in this fixture is not proof of a physical car identity or its present position.';

function question(instructions: string, criteria: Record<string, unknown>): Question {
  return { type: 'choice', instructions, criteria };
}

function targetQuestion(state: IdentityState): Question {
  const candidates = Object.fromEntries(state.observation.candidates.map(candidate => [candidate.id, {
    decision: 'accept_candidate', candidateId: candidate.id, targetReferenceId: state.targetReference.referenceId,
    meaning: 'Select this candidate only when the evidence supports it as the unique reference match.',
  }]));
  return question('Select the supported unique match to the reference named in state.goal, or the appropriate abstention. '
    + 'Use all of state.evidenceContract, the original acquisition provenance, and every offered candidate. '
    + 'All options are complete. Do not infer facts from opaque IDs or candidate order.', {
    ...candidates,
    none: { decision: 'abstain', reason: 'Every evaluated candidate contradicts the reference and extraction is complete; this does not prove world absence.' },
    ambiguous: { decision: 'abstain', reason: 'Extraction is complete but missing attributes or compatible alternatives prevent a uniquely supported match.' },
    incomplete: { decision: 'abstain', reason: 'Acquisition or candidate extraction is incomplete; remaining proposals have not been evaluated.' },
  });
}

function adequacyQuestion(): Question {
  return question('Independently assess absolute evidence adequacy: does this supplied observation support one unique '
    + 'candidate match to the exact reference requested in state.goal under state.evidenceContract? '
    + 'Inspect the same full evidence directly. Do not assume a candidate is valid because it is relatively best, '
    + 'and do not consume or predict the answer to any other question.', {
    [SUPPORTED]: 'Exactly one candidate satisfies the full stated reference-matching rule, including extraction completeness and exclusion of alternatives.',
    [UNSUPPORTED]: 'No uniquely supported match: measured contradictions, unresolved attributes, compatible twins, or incomplete extraction prevent acceptance.',
  });
}

function fixture(split: Split, index: number): { state: IdentityState; expectedTarget: string; reason: string | null } {
  const confirmation = split === 'confirmation';
  const ids = confirmation ? ['d29', 'd83'] : ['d14', 'd62'];
  const attributes: IdentityAttributes = {
    bodyStyle: confirmation ? (index % 2 ? 'hatchback' : 'sedan') : (index % 2 ? 'van' : 'estate'),
    paint: confirmation ? (index % 2 ? 'bronze' : 'white') : (index % 2 ? 'blue' : 'green'),
    roofAttachment: confirmation ? 'two transverse rails' : 'short closed roof box',
    rearWindowMark: confirmation ? 'yellow crescent at lower right' : 'white triangle at upper left',
  };
  const alternatives: IdentityAttributes = {
    bodyStyle: confirmation ? 'pickup' : 'coupe', paint: confirmation ? 'purple' : 'red',
    roofAttachment: 'bare roof', rearWindowMark: 'no mark on the visible rear window',
  };
  const candidates = ids.map(id => ({ id, attributes: { ...attributes } }));
  let expectedTarget: string;
  let reason: string | null = null;
  if (index < 4) {
    const matching = index % 2;
    const field = IDENTITY_FIELDS[index]!;
    candidates[1 - matching]!.attributes[field] = alternatives[field];
    expectedTarget = ids[matching]!;
  } else if (index === 4) {
    candidates[0]!.attributes.roofAttachment = alternatives.roofAttachment;
    candidates[1]!.attributes.rearWindowMark = alternatives.rearWindowMark;
    expectedTarget = 'none'; reason = 'measured_contradictions';
  } else if (index === 5) {
    candidates[0]!.attributes.rearWindowMark = null;
    candidates[1]!.attributes.paint = alternatives.paint;
    expectedTarget = 'ambiguous'; reason = 'missing_discriminating_attribute';
  } else if (index === 6) {
    expectedTarget = 'ambiguous'; reason = 'multiple_compatible_candidates';
  } else {
    candidates[0]!.attributes.roofAttachment = alternatives.roofAttachment;
    candidates[1]!.attributes.rearWindowMark = alternatives.rearWindowMark;
    expectedTarget = 'incomplete'; reason = 'unprocessed_detection_proposal';
  }
  // Cross accepted ID and position: each ID and each position occurs twice among the four positives.
  if (Math.floor(index / 2) % 2 === 1) candidates.reverse();
  const decisionAtMs = (confirmation ? 600_000 : 300_000) + index * 3_000;
  const referenceAgeMs = [4_000, 12_000, 60_000, 180_000, 16_000, 30_000, 8_000, 45_000][index]!;
  const acquiredAtMs = decisionAtMs - [100, 150, 200, 250][index % 4]!;
  const referenceId = confirmation ? 'reference-r73' : 'reference-r26';
  return {
    expectedTarget, reason,
    state: {
      scope: 'Analytic fixture of stipulated appearance measurements; no camera pixels, actual car identities, physical motion, or real vehicle Re-ID evidence.',
      goal: `Identify a uniquely supported observed match to the original requested appearance reference ${referenceId}; preserve abstention when the supplied evidence is insufficient.`,
      decisionAtMs,
      targetReference: {
        referenceId, source: 'stipulated retained appearance measurement', observationId: `sample-${confirmation ? 730 : 260}-${index}`,
        acquiredAtMs: decisionAtMs - referenceAgeMs, deliveredAtMs: decisionAtMs - referenceAgeMs + 20, attributes,
      },
      observation: {
        source: 'stipulated acquired appearance records', observationId: `sample-${confirmation ? 910 : 480}-${index}`,
        acquiredAtMs, deliveredAtMs: acquiredAtMs + 40,
        extraction: { detectedProposalCount: index === 7 ? 3 : 2, processedProposalCount: 2, acquisitionSucceeded: true },
        candidates,
      },
      evidenceContract: { identityFields: [...IDENTITY_FIELDS], unknownValue: null, rule: RULE },
    },
  };
}

/** Eight fixed units per split, two exact repetitions and two arms: 64 planned requests. */
export function generateIdentityCases(): Probe[] {
  const probes: Probe[] = [];
  for (const split of ['development', 'confirmation'] as const) {
    for (let index = 0; index < FAMILIES.length; index++) {
      const { state, expectedTarget, reason } = fixture(split, index);
      const unit = `T2-${split}-u${index + 1}`;
      for (let replicate = 0; replicate < 2; replicate++) {
        for (const arm of ARMS) {
          const questions: Record<string, Question> = { target: targetQuestion(state) };
          const expected: Record<string, string[]> = { target: [expectedTarget] };
          const supported = state.observation.candidates.some(candidate => candidate.id === expectedTarget);
          if (arm === 'independent_adequacy') {
            questions.adequacy = adequacyQuestion();
            expected.adequacy = [supported ? SUPPORTED : UNSUPPORTED];
          }
          probes.push({
            id: `${unit}-r${replicate}-${arm}`, technique: 'T2', split, unit, arm, replicate,
            request: { model: MODEL, state: structuredClone(state), questions }, expected,
            meta: {
              family: FAMILIES[index], sameStateGroup: unit, scope: 'stipulated_appearance_reference_compatibility',
              oracle: { supported, expectedTarget, noMatchReason: reason },
              referenceAgeMs: state.decisionAtMs - state.targetReference.acquiredAtMs,
              observationAgeMs: state.decisionAtMs - state.observation.acquiredAtMs,
            },
          });
        }
      }
    }
  }
  return probes;
}

/** Resolve only categorical answers. The additional question can veto, never retarget. */
export function scoreIdentity(probe: Probe, answers: Answers): Score {
  if (probe.technique !== 'T2' || !ARMS.includes(probe.arm as typeof ARMS[number])) throw new Error('Not an identity probe');
  const state = probe.request.state as IdentityState;
  const target = answers.target;
  const candidateIds = state.observation.candidates.map(candidate => candidate.id);
  const targetValid = [...candidateIds, ...ABSTENTIONS].includes(target);
  const hasGate = probe.arm === 'independent_adequacy';
  const gate = hasGate ? answers.adequacy : null;
  const gateValid = !hasGate || gate === SUPPORTED || gate === UNSUPPORTED;
  const selectedCandidate = candidateIds.includes(target);
  const gatePassed = !hasGate || gate === SUPPORTED;
  const vetoed = targetValid && selectedCandidate && hasGate && gateValid && !gatePassed;
  const decision = !targetValid || !gateValid ? 'invalid_response' : vetoed ? 'adequacy_declined' : target;
  const committed = candidateIds.includes(decision);
  const expectedTarget = probe.expected.target![0]!;
  const expectedSupported = candidateIds.includes(expectedTarget);
  const valid = targetValid && gateValid;
  const correct = valid && (expectedSupported ? decision === expectedTarget : !committed);
  const targetChoiceCorrect = target === expectedTarget;
  return {
    correct, unsafe: committed && decision !== expectedTarget, decision,
    details: {
      family: probe.meta.family, expectedTarget, expectedSupported, rawTarget: target ?? null,
      candidateAccepted: committed, usefulAcceptance: committed && decision === expectedTarget,
      justifiedAbstention: valid && !committed && !expectedSupported,
      overAbstention: valid && !committed && expectedSupported,
      targetChoiceCorrect, exactDecisionCorrect: valid && decision === expectedTarget,
      abstentionReasonCorrect: expectedSupported ? null : valid && decision === expectedTarget,
      expectedNoMatchReason: probe.meta.oracle.noMatchReason,
      observedNoMatchReason: committed ? null : decision,
      gate, gatePassed, gateValid, vetoed,
      adequacyCorrect: hasGate ? gate === (expectedSupported ? SUPPORTED : UNSUPPORTED) : null,
      gateDisagreement: hasGate && valid ? selectedCandidate !== (gate === SUPPORTED) : false,
      validResponse: valid, targetReferenceId: state.targetReference.referenceId,
      referenceAcquiredAtMs: state.targetReference.acquiredAtMs,
      observationAcquiredAtMs: state.observation.acquiredAtMs,
      referenceAgeMs: state.decisionAtMs - state.targetReference.acquiredAtMs,
      observationAgeMs: state.decisionAtMs - state.observation.acquiredAtMs,
    },
  };
}

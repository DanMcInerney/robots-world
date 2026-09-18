import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeJev, developmentCases, jevRequest, missionActions, missionDefinition, type MenuFormat } from '../experiments/mission-contract.ts';
import { MissionWorld } from '../experiments/mission-world.ts';

test('mission menus expose capabilities without evaluator labels or goal-based ranking', () => {
  const state = developmentCases()[0]!.state;
  assert.deepEqual(missionActions(state), missionActions({ ...state, goal: 'A completely different mission' }));
  for (const example of developmentCases()) {
    const serialized = JSON.stringify(example.state);
    assert.doesNotMatch(serialized, /"evaluation"|"acceptable"|"urgent":|"sentSimMs"/);
    assert.ok(example.acceptable.every(id => missionActions(example.state).some(c => c.id === id)));
  }
  const firstTargets = new Set([101, 202, 303, 404].map(seed => missionDefinition(seed, 'held-out').evaluation.ordered[0]));
  assert.ok(firstTargets.size > 1, 'counterbalance station identities across seeds');
});

test('all menu formats decode offered complete actions and reject malformed probabilities', () => {
  const state = developmentCases()[0]!.state;
  for (const format of ['plain', 'structured', 'factorized', 'interrupt'] as MenuFormat[]) {
    const request = jevRequest(state, format);
    const answers: Record<string, { type: string; choice?: string; confidence?: number; probabilities?: Record<string, number>; noul?: number }> = Object.fromEntries(Object.entries(request.questions).map(([key, q]) => {
      if (q.type === 'noul') return [key, { type: 'noul', noul: .1 }];
      const ids = Object.keys(q!.criteria), choice = key === 'operation' ? 'inspect' : ids[0]!;
      return [key, { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(ids.map(id => [id, id === choice ? 1 : 0])) }];
    }));
    assert.ok(missionActions(state).some(c => c.id === decodeJev({ answers }, state, format).actionId));
    const first = Object.values(answers)[0]!; first.probabilities![first.choice!] = .99;
    assert.equal(decodeJev({ answers }, state, format).probabilityRounding.length, 1);
    assert.equal(first.probabilities![first.choice!], .99, 'never silently renormalize');
    first.probabilities![first.choice!] = .7;
    assert.throws(() => decodeJev({ answers }, state, format), /probabilities:sum/);
  }
});

test('inspection requires sensor-observed arrival and dwell; MAVLink actuates while inference is absent', async () => {
  const def = missionDefinition(101, 'held-out'), events: string[] = [];
  const mission = await MissionWorld.create(def, kind => events.push(kind));
  try {
    const initial = mission.state();
    assert.equal(mission.apply(`inspect_${def.evaluation.ordered[0]}`, initial).accepted, true);
    assert.equal(mission.state().inspections.length, 0);
    for (let i = 0; i < 275; i++) await mission.tick();
    assert.equal(mission.state().inspections[0]?.station, def.evaluation.ordered[0]);
    assert.ok(events.includes('mission.inspection.completed'));
    assert.ok(events.includes('world.event'));
    assert.equal(mission.evaluate().success, false, 'partial task cannot pass');
  } finally { await mission.close(); }
});

test('radio delivery is independent of inference and invalidates an old observation; stop revokes late replies', async () => {
  const mission = await MissionWorld.create(missionDefinition(202, 'held-out'), () => {});
  const initial = mission.state();
  try {
    for (let i = 0; i < 320; i++) await mission.tick();
    assert.equal(mission.state().reports.length, 1);
    assert.ok(mission.state().reports[0]!.receivedSimMs >= 6100);
    assert.deepEqual(mission.apply('return', initial), { accepted: false, reason: 'new-report-since-observation' });
    const recent = mission.state(); await mission.close();
    assert.deepEqual(mission.apply('return', recent), { accepted: false, reason: 'stopped' });
  } finally { await mission.close(); }
});

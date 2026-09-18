import type { Scenario } from '../src/contracts.ts';
import type { Registry } from '../src/registry.ts';
import type { World } from '../src/world.ts';
import { defaultRegistry } from '../src/defaults.ts';
import { scenarios, scenario } from './index.ts';
import { createTrackingExperiment } from '../experiments/tracking.ts';

/** Host composition only. Dynamics/perception extensions never become controller capabilities. */
export interface ScenarioFixture { scenario: Scenario; registry: Registry; beforeStep?(world: World): void }
export const fixtureDescriptions = {
  ...Object.fromEntries(Object.entries(scenarios).map(([id, {label,description}])=>[id,{label,description}])),
  tracking: {label:'Moving target experiment',description:'Seeded target reversals and temporary visibility loss; ideal processed target sensing.'},
};
export function createFixture(id: string): ScenarioFixture {
  if(id==='tracking') { const fixture=createTrackingExperiment({seed:11}); return {scenario:fixture.scenario,registry:fixture.registry,beforeStep:fixture.update}; }
  return {scenario:scenario(id),registry:defaultRegistry()};
}

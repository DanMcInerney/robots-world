import { registry } from './registry.ts';
import { rapierFactory, kinematicFactory } from './physics/index.ts';
import { builtinModels } from './models/index.ts';
import { builtinSensors } from './sensors/index.ts';
export const defaultRegistry = () => registry({ physics: { rapier: rapierFactory, kinematic: kinematicFactory }, models: builtinModels, sensors: builtinSensors });

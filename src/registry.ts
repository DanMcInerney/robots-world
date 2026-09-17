import type { PhysicsFactory, RobotModel, SensorPlugin } from './contracts.ts';

/** Ordinary maps, not a plugin loader. Registrations happen before creating a world. */
export interface Registry {
  physics: Map<string, PhysicsFactory>;
  models: Map<string, RobotModel>;
  sensors: Map<string, SensorPlugin>;
}
export function registry(parts: { physics: Record<string, PhysicsFactory>; models: RobotModel[]; sensors: SensorPlugin[] }): Registry {
  const unique = <T extends { id: string }>(items: T[]) => {
    const map = new Map(items.map(item => [item.id, item]));
    if (map.size !== items.length) throw new Error('Duplicate plugin ID');
    return map;
  };
  return { physics: new Map(Object.entries(parts.physics)), models: unique(parts.models), sensors: unique(parts.sensors) };
}

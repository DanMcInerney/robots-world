# Extension points

Import the dependency-free contracts from `src/contracts.ts`. Import defaults separately from `src/defaults.ts` so controller and hardware code do not have to load Rapier or Three.js.

## A new sensor

```ts
import type { SensorPlugin } from '../src/contracts.ts';
const height: SensorPlugin = {
  id: 'height', requires: ['bodies'],
  sample(context) { return { metres: context.mount.position.z }; },
};
const plugins = defaultRegistry();
plugins.sensors.set(height.id, height);
```

Add `{id:'altimeter', type:'height', hz:20, latencyMs:30, noise:0.01}` to any robot. `context.mount` is the composed world pose of the chosen link and local mount. Plugins see truth only to synthesize their specific sensor measurement. Their output is the only part delivered to a controller. Units and noise semantics must be documented per sensor. No sensor is mandatory.

## A new robot

Use `createAssetModel` from `src/models/index.ts` for an articulated assembly of primitive links and fixed/revolute joints. Link poses are relative to the robot's initial pose; joint anchors are relative to their respective links. Shapes use full extents (sphere size.x is its diameter). Name links and joints within the robot; the helper namespaces their backend IDs.

For a different actuator, implement `RobotModel.create` and return a `RobotPlant`: body/joint IDs, renderable body descriptions, `apply`, `tick`, `completed` and `stop`. The model owns local closed-loop behavior and declares command JSON schemas. Validate domain constraints before mutation. A physics backend's force applies to the next step only. Do not place waypoint logic in a physics engine wrapper.

## A new control library

Implement `Controller.run(ports, signal)`, or just write ordinary code against `RobotPort`. Call `describe` to discover supported actions and installed sensors. Check individual reading validity and acquisition timestamps. Explicitly acknowledge events and inbox packets. Give commands unique IDs, deadlines and observation provenance. On cancellation, close ports before waiting for inference to finish. Never automatically retry an uncertain mutation with a new ID.

`HttpRobotPort` lets an external process use the same interface. It does not retry network failures. A device adapter can implement the interface over serial, MAVLink, ROS 2 or a manufacturer's SDK. It must implement command admission, watchdog and stop semantics appropriate to that hardware; matching a TypeScript shape alone does not qualify a real robot.

## A new engine or scenario

Register a `PhysicsFactory` under a string ID. Return a whole-world `PhysicsBackend` with its explicit capabilities and opaque string body IDs. Keep engine objects inside the adapter. The included kinematic backend is a small second implementation demonstrating capability rejection and portability; it is not an alternate rigid-body engine.

Scenarios are plain typed data. Compose robot models, per-robot sensors, initial poses, obstacles and radio parameters. Seeded streams are named per sensor and radio link, so adding an unrelated sensor does not alter another sensor's noise. Record version, full configuration and action application ticks as well as the seed. Cloud inference arrival times require captured outputs and scheduling to reproduce a trial.

/** All world coordinates are right-handed ENU, metres, seconds and radians. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Vec3 { x: number; y: number; z: number }
export interface Quat { x: number; y: number; z: number; w: number }
export interface Pose { position: Vec3; rotation: Quat }
export interface Shape { kind: 'box' | 'sphere' | 'capsule'; size: Vec3; color?: string }
export interface BodySpec { id: string; pose: Pose; shape: Shape; mode: 'fixed' | 'dynamic' | 'kinematic'; mass?: number; friction?: number }
export interface BodyState { id: string; pose: Pose; linearVelocity: Vec3; angularVelocity: Vec3 }
export interface JointSpec { id: string; parent: string; child: string; kind: 'fixed' | 'revolute'; anchorParent: Vec3; anchorChild: Vec3; axis: Vec3; limits?: [number, number] }
export interface RayHit { body: string; distance: number; point: Vec3 }
export interface Contact { a: string; b: string }
export interface PhysicsBackend {
  readonly id: string; readonly capabilities: readonly string[]; readonly gravity: Vec3;
  addBody(spec: BodySpec): void; addJoint(spec: JointSpec): void;
  body(id: string): BodyState; bodies(): BodyState[];
  force(id: string, force: Vec3): void;
  velocity(id: string, linear: Vec3, angular?: Vec3): void;
  move(id: string, pose: Pose): void;
  jointTarget(id: string, radians: number): void; jointPosition(id: string): number;
  ray(origin: Vec3, direction: Vec3, maxDistance: number, exclude?: readonly string[]): RayHit | null;
  contacts(): Contact[]; step(dt: number): void | Promise<void>; close(): void;
}
export type PhysicsFactory = (options: { gravity: Vec3 }) => Promise<PhysicsBackend>;
export interface RobotAsset { links: (Omit<BodySpec, 'id'> & { name: string })[]; joints?: (Omit<JointSpec, 'id' | 'parent' | 'child'> & { name: string; parent: string; child: string })[] }
export interface CommandSpec { description: string; schema: Record<string, unknown> }
export interface RobotModel {
  id: string; requires: string[]; commands: Record<string, CommandSpec>;
  create(context: { id: string; pose: Pose; physics: PhysicsBackend; config: Record<string, Json> }): RobotPlant;
}
export interface RobotPlant {
  root: string; bodyIds: string[]; jointIds: string[]; visuals: BodySpec[];
  apply(action: string, args: Record<string, Json>): void;
  tick(dt: number): void; stop(): void;
  completed(action: string, args: Record<string, Json>): boolean;
}
export interface SensorSpec {
  id: string; type: string; link?: string; mount?: Pose; hz: number;
  latencyMs?: number; noise?: number; dropout?: number; maxAgeMs?: number; config?: Record<string, Json>;
}
export interface SensorContext {
  robotId: string; bodyIds: readonly string[]; link: string; mount: Pose;
  physics: PhysicsBackend; simMs: number; random(): number;
}
export interface SensorPlugin { id: string; requires: string[]; sample(context: SensorContext, spec: SensorSpec): Json }
export interface SensorReading { value: Json; sequence: number; acquiredSimMs: number; receivedSimMs: number; valid: boolean; reason?: string }
export interface RadioSpec { channel: string; rangeM: number; bitrateBps: number; latencyMs: number; jitterMs: number; loss: number; maxQueueBytes: number; maxPacketBytes: number }
export interface RobotSpec { id: string; model: string; pose: Pose; config?: Record<string, Json>; sensors: SensorSpec[]; radio?: Partial<RadioSpec>; goal?: string }
export interface Scenario { id: string; seed: number; dt: number; gravity: Vec3; bounds: Vec3; obstacles: BodySpec[]; robots: RobotSpec[]; partitions?: [string, string][] }
export interface Command { id: string; action: string; args: Record<string, Json>; validForMs?: number; basedOn?: { observation: number; maxAgeMs: number } }
export interface Receipt { id: string; status: 'accepted' | 'completed' | 'rejected' | 'duplicate'; reason?: string; jobId?: string; appliedSimMs?: number }
export interface Job { id: string; commandId: string; action: string; args: Record<string, Json>; status: 'running' | 'completed' | 'cancelled' | 'expired'; startedSimMs: number; updatedSimMs: number }
export interface Packet { id: string; from: string; to: string; channel: string; data: string; sentSimMs: number; receivedSimMs: number; expiresSimMs: number }
export interface Observation { epoch: string; robotId: string; sequence: number; simMs: number; wallMs: number; goal: string; sensors: Record<string, SensorReading>; jobs: Job[]; inbox: Packet[]; events: { id: number; kind: string; data: Json }[]; fault?: string }
export interface RobotDescription { id: string; model: string; commands: Record<string, CommandSpec>; sensors: SensorSpec[]; radio: RadioSpec; units: string }
/** The one controller-facing boundary. Hardware implementations can implement this interface. */
export interface RobotPort {
  readonly robotId: string;
  describe(): Promise<RobotDescription>; observe(): Promise<Observation>;
  command(command: Command): Promise<Receipt>;
  acknowledge(throughEvent: number, packetIds?: string[]): Promise<void>;
  send(packet: { id: string; to: string; data: string; ttlMs?: number }): Promise<{ accepted: boolean; reason?: string }>;
  stop(): Promise<void>; close(): Promise<void>;
}
export interface Controller { id: string; run(ports: readonly RobotPort[], signal: AbortSignal): Promise<void> }
export interface Diagnostic { id: number; simMs: number; wallMs: number; robotId?: string; channel: 'control' | 'protocol' | 'sensor' | 'network' | 'world'; kind: string; data: unknown; truncated?: boolean }
export type Recorder = (event: Omit<Diagnostic, 'id' | 'wallMs'>) => void;

import type { Observation } from '../../src/contracts.ts';
import { axesController, axesRequest, type CommandFeedback } from '../jev-axes/controller.ts';
import type { Request, Response } from '../jev-strategies/strategies.ts';
import type { Emit } from '../reactive/world.ts';
import { SENSOR_ARMS, type SensorArm } from './contract.ts';
import { measuredGeometry } from './geometry.ts';

export const SENSOR_CONTRACT = `Control a stabilized camera drone using ONLY the dated onboard measurements. Carry out the exact English goal in state.goal. There is NO target broadcast, GPS/world position, world map, surrounding point cloud, contact oracle or hidden target tracking. A known 0.4 m ARUCO_MIP_36h12 marker ID 0 is printed on the rover roof, its top edge toward rover front. Actual pixel processing estimates marker translation and rotation; it can fail or produce ambiguous pose solutions. Measurements describe the marker centre, 0.092 m above the rover centre. Missing detection means unknown current target pose, NOT that the previous pose is still current. Do not infer empty space from missing measurements. You may infer geometry from valid observations; future rover motion is unknown.
The six questions are independent in one request and cannot see each other's answers. ENU world axes: x east, y north, z up. Select velocity setpoints, not distances or accelerations. All three components combine unchanged. Onboard heading estimate is 0 east, +90 north; camera pitch is negative down. Marker camera coordinates are right/up/forward. Incremental camera commands add once to the delivered camera angles. Commands replace the prior command and expire after 3 seconds. World and acquisition keep moving during inference. The local servo stabilizes setpoints, with max speed 2 m/s and max acceleration 4 m/s^2. It does not follow, aim or avoid obstacles. Camera/body yaw gain is 4, limited to 120 degrees/s; camera pitch slews at 90 degrees/s; zoom changes to a calibrated setting. Immediate braking/hold is an idealized simulator assumption, not flight qualification.
If rangefinder is installed, it is a TF-Luna mounted 0.29m forward of the drone centre, fixed 30 degrees DOWN from the body forward axis; it does NOT follow camera pitch. It measures a narrow 2-degree cone, not all directions, and cannot identify the rover or any hit surface. Camera and lidar samples are asynchronous. Never label a lidar return as target range merely because the target is visible. A weak, saturated, stale or missing return is unknown, not clear space. Mixed surfaces can produce misleading readings even when the signal is valid; they are not reliably detected. The maximum reliable range depends on reflectivity. There is no location-based safety guard; only actuator limits, command expiry, ownership and source-age checks. No code ranks or filters your choices.`;

export function sensorRequest(observation: Observation, arm: SensorArm, feedback: CommandFeedback[] = []): Request {
  if (!Object.hasOwn(SENSOR_ARMS, arm)) throw new Error('Unknown sensor arm');
  const allowed = arm === 'sensor-tfluna' ? ['camera', 'rangefinder'] : ['camera'];
  if (Object.keys(observation.sensors).some(id => !allowed.includes(id)) || !observation.sensors.camera || observation.inbox.length) throw new Error('Undeclared sensor or radio evidence in camera-only controller');
  const request = axesRequest(observation, 'axes-raw', feedback);
  const purposes: Record<string, string> = {
    velocity_x: 'Choose the east/west velocity for the current goal.', velocity_y: 'Choose the north/south velocity for the current goal.', velocity_z: 'Choose the up/down velocity for the current goal.',
    camera_heading: 'Choose a camera heading increment to find or frame the marker.', camera_pitch: 'Choose a camera pitch increment to find or frame the marker.', camera_zoom: 'Choose the calibrated camera field of view.',
  };
  for (const [id, question] of Object.entries(request.questions)) question.instructions = `${SENSOR_CONTRACT}\n${purposes[id]}`;
  request.state = { goal: observation.goal, simMs: observation.simMs, observationSequence: observation.sequence, sensorProfile: arm,
    sensors: structuredClone(observation.sensors), commandFeedback: feedback.slice(-3),
    measuredGeometry: observation.sensors.camera.valid ? measuredGeometry(observation.sensors.camera.value) : [],
    knowledge: 'Known physical marker dimensions/mount and sensor/actuator calibration only. No scenario layout, target schedule or evaluator feedback.' };
  return request;
}
export function sensorController(arm: SensorArm, key: string, emit: Emit, transport?: (request: Request, signal: AbortSignal) => Promise<Response>) {
  return axesController(arm, key, emit, transport, { sourceSensor: 'camera', request: (observation, feedback) => sensorRequest(observation, arm, feedback) });
}

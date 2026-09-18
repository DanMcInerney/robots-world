import { common } from 'node-mavlink';
import type { SensorReading, SensorSpec } from '../contracts.ts';
import { decodeLuna, TF_LUNA } from '../devices/tf-luna.ts';

/** Adapter for a real or simulated decoded UART reading. Does not turn invalid range into free space. */
export function lunaMavlink(reading: SensorReading, spec: SensorSpec, id: number): common.DistanceSensor | null {
  if (!Number.isInteger(id) || id < 0 || id > 255) throw new Error('Invalid MAVLink sensor ID');
  if (!reading.value || typeof reading.value !== 'object' || Array.isArray(reading.value) || reading.value.kind !== 'tf-luna') return null;
  const value = reading.value;
  if (typeof value.uartHex !== 'string' || !/^[0-9a-f]{18}$/.test(value.uartHex)) throw new Error('Invalid TF-Luna UART evidence');
  const decoded = decodeLuna(Buffer.from(value.uartHex, 'hex'));
  const valid = reading.valid && decoded.valid, q = spec.mount?.rotation ?? { x: 0, y: 0, z: 0, w: 1 };
  const message = new common.DistanceSensor();
  Object.assign(message, { timeBootMs: Math.round(reading.acquiredSimMs) >>> 0, minDistance: TF_LUNA.minM * 100, maxDistance: TF_LUNA.maxM * 100,
    currentDistance: valid ? Math.round(decoded.distanceM! * 100) : 0, type: 0, id, orientation: 100,
    quaternion: [q.w, q.x, -q.y, -q.z], horizontalFov: TF_LUNA.fovRad, verticalFov: TF_LUNA.fovRad,
    covariance: 255, signalQuality: valid ? 0 : 1 }); // 0 unknown quality; 1 explicitly invalid, per MAVLink.
  return message;
}

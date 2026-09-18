import type { SensorPlugin, SensorSpec } from '../contracts.ts';
import { rotate, vec } from '../math.ts';

export const TF_LUNA = { minM: .2, maxM: 8, fovRad: Math.PI / 90, defaultHz: 100, baud: 115200 } as const;
export type LunaMeasurement = { distanceM: number | null; strength: number; temperatureC: number; valid: boolean; reason: string | null };

/** Real default TF-Luna UART format: centimetres, little endian, 8-bit additive checksum. */
export function encodeLuna(distanceCm: number, strength: number, temperatureC = 25): Uint8Array {
  if (![distanceCm, strength].every(n => Number.isInteger(n) && n >= 0 && n <= 65535) || !Number.isFinite(temperatureC) || temperatureC < -256 || temperatureC > 7935) throw new Error('Invalid TF-Luna frame fields');
  const b = new Uint8Array(9), view = new DataView(b.buffer);
  b[0] = b[1] = 0x59; view.setUint16(2, distanceCm, true); view.setUint16(4, strength, true); view.setUint16(6, Math.round((temperatureC + 256) * 8), true);
  b[8] = b.slice(0, 8).reduce((s, n) => s + n, 0) & 255;
  return b;
}
export function decodeLuna(b: Uint8Array): LunaMeasurement {
  if (b.length !== 9 || b[0] !== 0x59 || b[1] !== 0x59 || b.slice(0, 8).reduce((s, n) => s + n, 0) % 256 !== b[8]) throw new Error('Invalid TF-Luna frame/checksum');
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength), distance = v.getUint16(2, true) / 100, strength = v.getUint16(4, true);
  const reason = strength < 100 ? 'weak-or-no-return' : strength === 65535 ? 'saturated' : distance < TF_LUNA.minM ? 'too-close' : distance > TF_LUNA.maxM ? 'out-of-range' : null;
  return { distanceM: reason ? null : distance, strength, temperatureC: v.getUint16(6, true) / 8 - 256, valid: reason === null, reason };
}
/** Bounded streaming parser shared with a real serial adapter. Corrupt/partial frames never become measurements. */
export class LunaParser {
  private pending: number[] = [];
  corruptFrames = 0;
  push(chunk: Uint8Array): { bytes: Uint8Array; measurement: LunaMeasurement }[] {
    const result: { bytes: Uint8Array; measurement: LunaMeasurement }[] = [];
    for (const byte of chunk) {
      this.pending.push(byte);
      while (this.pending.length && (this.pending[0] !== 0x59 || this.pending.length > 1 && this.pending[1] !== 0x59)) this.pending.shift();
      if (this.pending.length < 9) continue;
      const bytes = Uint8Array.from(this.pending);
      try { result.push({ bytes, measurement: decodeLuna(bytes) }); this.pending = []; }
      catch { this.corruptFrames++; this.pending.shift(); }
    }
    return result;
  }
}

/** Optional mounted sensor. Materials belong to the simulated device, never the controller observation.
 * Nine-ray cone approximation. Partial and mixed returns can be misleading VALID measurements;
 * there is no privileged mixed-surface detector or nearest-obstacle selection.
 * Strength/reflectance curve is an explicit approximation, not an optical or sunlight qualification.
 */
export function tfLuna(material: (bodyId: string) => number = () => .1): SensorPlugin {
  return { id: 'tf-luna', requires: ['bodies', 'raycast'], sample(context, spec) {
    validateLunaSpec(spec);
    const spread = Math.tan(TF_LUNA.fovRad / 2), hits: { distance: number; body: string }[] = [];
    for (let i = 0; i < 9; i++) {
      const a = (i - 1) * Math.PI / 4, y = i ? spread * Math.cos(a) : 0, z = i ? spread * Math.sin(a) : 0;
      const direction = rotate(vec(1 / Math.hypot(1, y, z), y / Math.hypot(1, y, z), z / Math.hypot(1, y, z)), context.mount.rotation);
      const hit = context.physics.ray(context.mount.position, direction, TF_LUNA.maxM, context.bodyIds);
      if (hit) hits.push(hit);
    }
    let cm = 0, strength = 0, weightedDistance = 0, sumStrength = 0;
    for (const hit of hits) {
      const distance = hit.distance, reflectance = material(hit.body);
      if (!Number.isFinite(reflectance) || reflectance <= 0 || reflectance > 1) throw new Error('TF-Luna reflectance must be in (0,1]');
      const effectiveRange = 8 * Math.pow(reflectance / .9, Math.log(2.5 / 8) / Math.log(.1 / .9));
      const amplitude = 100 * (effectiveRange / Math.max(.1, distance)) ** 2;
      weightedDistance += distance * amplitude; sumStrength += amplitude;
    }
    if (sumStrength > 0) {
      const distance = weightedDistance / sumStrength;
      strength = Math.min(65535, Math.round(sumStrength / 9));
      const error = (distance <= 3 ? .06 : distance * .02) + (spec.noise ?? 0);
      cm = Math.round(Math.max(0, distance + (context.random() * 2 - 1) * error) * 100);
    }
    const bytes = encodeLuna(cm, strength), measurement = decodeLuna(bytes);
    return { kind: 'tf-luna', ...measurement, uartHex: Buffer.from(bytes).toString('hex'), minM: TF_LUNA.minM, maxM: TF_LUNA.maxM,
      fovRad: TF_LUNA.fovRad, frame: 'sensor-forward-x', timestampOrigin: 'host-acquisition; default UART packet has no device timestamp' };
  } };
}
export function validateLunaSpec(spec: SensorSpec) {
  if (!Number.isFinite(spec.hz) || spec.hz < 1 || spec.hz > 250 || Math.abs(500 / spec.hz - Math.round(500 / spec.hz)) > 1e-6) throw new Error('TF-Luna rate must be 500/n Hz for integer n in [2,500]');
  if (spec.config && Object.keys(spec.config).length) throw new Error('TF-Luna physical limits are fixed; unsupported config');
}

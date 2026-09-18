import type { SensorPlugin, Vec3 } from '../contracts.ts';
import { add, rotate, scale, vec } from '../math.ts';

/** Sparse spherical range samples, with acquisition pose embedded for later registration.
 * A missing hit is unobserved free extent, not a complete map or an object classification.
 */
export const rangeCloud: SensorPlugin = {
  id: 'range-cloud', requires: ['bodies', 'raycast'],
  sample(context, spec) {
    const range = Number(spec.config?.maxRange ?? 12), count = Number(spec.config?.azimuths ?? 24);
    if (!Number.isFinite(range) || range <= 0 || range > 100 || !Number.isInteger(count) || count < 4 || count > 48) throw new Error('Invalid range cloud configuration');
    const points: Vec3[] = [];
    const registrationNoise = Number(spec.config?.registrationNoiseM ?? 0);
    if (!Number.isFinite(registrationNoise) || registrationNoise < 0 || registrationNoise > .5) throw new Error('Invalid range registration noise');
    const noise = () => registrationNoise ? (context.random() * 2 - 1) * registrationNoise : 0;
    const origin = add(context.mount.position, vec(noise(), noise(), noise()));
    for (const elevation of [-60, -30, 0, 30, 60]) for (let i = 0; i < count; i++) {
      const a = i * Math.PI * 2 / count, e = elevation * Math.PI / 180;
      const direction = rotate(vec(Math.cos(e) * Math.cos(a), Math.cos(e) * Math.sin(a), Math.sin(e)), context.mount.rotation);
      const hit = context.physics.ray(context.mount.position, direction, range, context.bodyIds);
      if (hit) points.push(add(origin, scale(direction, Math.max(0, Math.min(range, hit.distance + (context.random() * 2 - 1) * (spec.noise ?? 0))))));
    }
    return { frame: 'world-ENU', registration: registrationNoise ? 'noisy-position-ideal-orientation' : 'ideal-pose', kind: 'sparse-range-returns', origin: { ...origin }, maxRange: range, rayCount: count * 5, points: points.map(p => ({ ...p })) };
  },
};

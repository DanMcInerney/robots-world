import type { Pose, Quat, Vec3 } from './contracts.ts';
export const vec = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const identity = (): Quat => ({ x: 0, y: 0, z: 0, w: 1 });
export const pose = (x = 0, y = 0, z = 0): Pose => ({ position: vec(x, y, z), rotation: identity() });
export const add = (a: Vec3, b: Vec3) => vec(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a: Vec3, b: Vec3) => vec(a.x - b.x, a.y - b.y, a.z - b.z);
export const scale = (a: Vec3, n: number) => vec(a.x * n, a.y * n, a.z * n);
export const norm = (a: Vec3) => Math.hypot(a.x, a.y, a.z);
export const distance = (a: Vec3, b: Vec3) => norm(sub(a, b));
export const clamp = (n: number, limit: number) => Math.max(-limit, Math.min(limit, n));
export function rotate(v: Vec3, q: Quat): Vec3 { const t = vec(2*(q.y*v.z-q.z*v.y),2*(q.z*v.x-q.x*v.z),2*(q.x*v.y-q.y*v.x)); return vec(v.x+q.w*t.x+q.y*t.z-q.z*t.y,v.y+q.w*t.y+q.z*t.x-q.x*t.z,v.z+q.w*t.z+q.x*t.y-q.y*t.x); }
export function multiply(a: Quat, b: Quat): Quat { return { x:a.w*b.x+a.x*b.w+a.y*b.z-a.z*b.y,y:a.w*b.y-a.x*b.z+a.y*b.w+a.z*b.x,z:a.w*b.z+a.x*b.y-a.y*b.x+a.z*b.w,w:a.w*b.w-a.x*b.x-a.y*b.y-a.z*b.z }; }
export const compose = (a: Pose, b: Pose): Pose => ({ position: add(a.position,rotate(b.position,a.rotation)),rotation:multiply(a.rotation,b.rotation) });
/** Independent named streams prevent unrelated plugins changing one another's noise. */
export function randomStream(seed: number, name: string) { let state = seed >>> 0; for (const c of name) state = Math.imul(state ^ c.charCodeAt(0),16777619) >>> 0; return () => { state = (Math.imul(state,1664525)+1013904223)>>>0; return state/4294967296; }; }

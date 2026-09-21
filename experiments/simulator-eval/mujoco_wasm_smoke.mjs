import { readFileSync } from 'node:fs';
import loadMujoco from '@mujoco/mujoco';
const t0 = performance.now();
const mujoco = await loadMujoco();
console.log(`wasm module loaded in ${(performance.now() - t0).toFixed(0)} ms on node ${process.version}`);
const xml = readFileSync(process.argv[2] ?? 'generated_arm.xml', 'utf8');   // MJCF written by mujoco_smoke.py
const t1 = performance.now();
const model = mujoco.MjModel.from_xml_string(xml);
const data = new mujoco.MjData(model);
console.log(`compiled the Python-generated arm MJCF in ${(performance.now() - t1).toFixed(1)} ms: nbody=${model.nbody} nu=${model.nu} nsensor=${model.nsensor}`);
const N = 5000, t2 = performance.now();
for (let i = 0; i < N; i++) { data.ctrl[0] = 0.6 + 0.3 * Math.sin(data.time); data.ctrl[1] = -1.2; mujoco.mj_step(model, data); }
const s = (performance.now() - t2) / 1000;
console.log(`physics in Node/WASM: ${Math.round(N / s).toLocaleString()} steps/s = ${(N * 0.002 / s).toFixed(0)}x real time`);
console.log('qpos', Array.from(data.qpos).map(v => +v.toFixed(4)), 'sensordata', Array.from(data.sensordata).map(v => +v.toFixed(3)));
// programmatic model building from JS too?
console.log('MjSpec in JS:', typeof mujoco.MjSpec, ' parseXMLString:', typeof mujoco.parseXMLString, ' mj_ray:', typeof mujoco.mj_ray, ' mj_multiRay:', typeof mujoco.mj_multiRay);

import * as THREE from 'three';

import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import './flight.css';



type Frame = { simMs: number; drone: { x: number; y: number; z: number }; target: { x: number; y: number; z: number }; crossing?: { x: number; y: number; z: number }; heading: number; pitch: number; hfov: number; visible: boolean; inspectable: boolean; fallback?: string | null; controllerStopped?: boolean };

type Run = { id: string; arm: string; seed: number; seconds: number; observedMs?: number; termination?: string; scenario: any; latencyP50Ms: number | null; config?: any; controllerArrangement?: any; capabilities?: any; evaluation: { metric?: { id: string }; fallbackMs?: number; controllerFailures?: number; guardInterventions?: number; staleResponses?: number; success: boolean; visibleFraction: number | null; inspectionAtMs: number | null; collisionTicks: number | null; boundsTicks: number | null; phases?: { inspectedAt: number | null; goal: string; framingFraction?: number }[]; trajectory: Frame[] }; replayEvents: { simMs: number; channel: string; data: unknown }[]; traceFile: string };

const root = document.querySelector<HTMLElement>('#flight-root')!;

root.innerHTML = `<header><div class="kicker">ROBOTS WORLD / RECORDED EVIDENCE</div><h1>Maneuver. Aim. Inspect.</h1><p>Recorded controller experiments. The camera view is a geometric replay; models received structured sensor detections.</p><div class="toolbar"><label>Load replay <input id="file" type="file" accept=".json"></label><label>Seed <select id="seed"></select></label><button id="play">Play</button><input id="seek" type="range" min="200" max="45000" step="100" value="200" aria-label="Replay time"><output id="time">0.2 s</output></div><p id="status">Load a replay.json generated from a completed experiment.</p></header><section id="cards"></section>`;

const status = root.querySelector<HTMLElement>('#status')!, seek = root.querySelector<HTMLInputElement>('#seek')!, time = root.querySelector<HTMLOutputElement>('#time')!, seedSelect = root.querySelector<HTMLSelectElement>('#seed')!, playButton = root.querySelector<HTMLButtonElement>('#play')!;

let runs: Run[] = [], cards: ReturnType<typeof card>[] = [], playing = false, last = performance.now(), paintAt = 0, cursorMs = 200;

const worldPoint = (p: { x: number; y: number; z: number }) => new THREE.Vector3(p.x, p.z, -p.y);

function box(scene: THREE.Object3D, size: { x: number; y: number; z: number }, color: string, position: THREE.Vector3) {

  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.z, size.y), new THREE.MeshStandardMaterial({ color, roughness: .8 })); mesh.position.copy(position); scene.add(mesh); return mesh;

}

function card(run: Run) {

  const el = document.createElement('article');

  el.innerHTML = `<div class="card-heading"><h2></h2><span></span></div><p class="metrics"></p><div class="scene"></div><div class="camera-label">World above · onboard camera below</div><div class="raw-heading"><b>Recorded I/O</b><select aria-label="Recorded data channel"><option value="lifecycle">Controller / fallback</option><option value="configuration">Capabilities / configuration</option><option value="decision">Model decisions</option><option value="response">Provider responses</option><option value="policy">Goals and advice</option><option value="protocol">MAVLink bytes</option><option value="sensor">Camera sensor</option><option value="network">Radio delivery</option></select></div><pre></pre>`;

  el.querySelector('h2')!.textContent = { jev: 'Jev', claude: 'Claude Opus 5 · low', codex: 'Codex Luna · xhigh', hybrid: 'Jev + Codex proposals', 'jev-bare': 'Jev · bare controls', 'jev-facts': 'Jev · calculated consequences', 'claude-facts': 'Claude Opus 5 · consequences', 'codex-facts': 'Codex Luna xhigh · consequences', 'jev-brief': 'Jev + Codex preflight brief', 'jev-repair': 'Jev + brief + online repair' }[run.arm] ?? run.arm;

  const badge = el.querySelector('span')!; badge.textContent = run.termination ? 'TERMINATED' : run.evaluation.success ? 'PASS' : 'FAILED'; badge.className = run.evaluation.success ? 'pass' : 'fail';

  const inspected = run.evaluation.phases ? `${run.evaluation.phases.filter(p => p.inspectedAt !== null).length}/${run.evaluation.phases.length} viewing goals reached` : run.evaluation.inspectionAtMs === null ? 'no inspection' : 'side inspected';

  el.querySelector('.metrics')!.textContent = run.termination ? `Stopped at ${(run.observedMs! / 1000).toFixed(1)} s after envelope violation · full-flight metrics unavailable` : `${((run.evaluation.visibleFraction ?? 0) * 100).toFixed(1)}% visible · ${run.latencyP50Ms === null ? 'no completed decision' : `${(run.latencyP50Ms / 1000).toFixed(2)} s median response`} · ${inspected} · ${(run.evaluation.collisionTicks ?? 0) * .02}s contact`;

  const metrics = el.querySelector('.metrics')!;

  if (run.evaluation.metric) metrics.textContent += ` · sustained framing ${(100 * (run.evaluation.phases ?? []).reduce((sum, p) => sum + (p.framingFraction ?? 0), 0) / Math.max(1, run.evaluation.phases?.length ?? 0)).toFixed(1)}% · ${((run.evaluation.fallbackMs ?? 0) / 1000).toFixed(1)} s local hold · ${run.evaluation.controllerFailures ?? 0} controller failures · ${run.evaluation.guardInterventions ?? 0} guard interventions`;

  else metrics.textContent += ' · legacy one-second attainment score';

  if (reportPath && /^\/\.runtime\/experiments\/[\w-]+\/replay\.json$/.test(reportPath) && /^[\w-]+\.jsonl$/.test(run.traceFile)) {

    const link = document.createElement('a'); link.href = reportPath.replace('replay.json', run.traceFile); link.download = run.traceFile; link.textContent = 'Full raw JSONL'; link.style.cssText = 'color:#63ebcf;margin:0 14px;font-size:11px'; el.append(link);

  }

  const scene = new THREE.Scene(); scene.background = new THREE.Color('#101c29'); scene.add(new THREE.HemisphereLight(0xe7f5ff, 0x263240, 2.5)); const light = new THREE.DirectionalLight(0xffffff, 3); light.position.set(5, 12, 4); scene.add(light);

  let crossing: THREE.Mesh | undefined;

  for (const obstacle of run.scenario.obstacles) {

    const mesh = box(scene, obstacle.shape.size, obstacle.shape.color ?? '#697786', worldPoint(obstacle.pose.position));

    const q = obstacle.pose.rotation; mesh.quaternion.set(q.x, q.z, -q.y, q.w);

    if (obstacle.id === 'crossing') crossing = mesh;

  }

  scene.add(new THREE.GridHelper(36, 36, '#4d6379', '#293c50'));

  const drone = new THREE.Group(); scene.add(drone); box(drone, { x: .65, y: .24, z: .14 }, '#63ebcf', new THREE.Vector3()); box(drone, { x: .24, y: .65, z: .12 }, '#63ebcf', new THREE.Vector3());

  const target = box(scene, { x: .55, y: .55, z: .18 }, '#478bff', new THREE.Vector3());

  const path = new THREE.Line(new THREE.BufferGeometry().setFromPoints(run.evaluation.trajectory.map(f => worldPoint(f.drone))), new THREE.LineBasicMaterial({ color: '#63ebcf', transparent: true, opacity: .45 })); scene.add(path);

  const camera = new THREE.PerspectiveCamera(48, 1, .05, 150); camera.position.set(12, 16, 14); camera.lookAt(0, 0, 0);

  const onboard = new THREE.PerspectiveCamera(45, 16 / 9, .05, 100);

  const renderer = new THREE.WebGLRenderer({ antialias: true }); renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5)); el.querySelector('.scene')!.append(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement); controls.target.set(0, 1, 0); controls.update();

  const raw = el.querySelector('pre')!, channel = el.querySelector<HTMLSelectElement>('select')!;

  function render(ms: number, text: boolean) {

    const trajectory = run.evaluation.trajectory, frame = trajectory[Math.min(trajectory.length - 1, Math.max(0, Math.floor(ms / 100) - 1))]!;

    if (!frame) return;

    drone.position.copy(worldPoint(frame.drone)); drone.rotation.y = frame.heading * Math.PI / 180; target.position.copy(worldPoint(frame.target));

    if (crossing && frame.crossing) crossing.position.copy(worldPoint(frame.crossing));

    const heading = frame.heading * Math.PI / 180, pitch = frame.pitch * Math.PI / 180;

    onboard.position.copy(drone.position); onboard.lookAt(onboard.position.clone().add(new THREE.Vector3(Math.cos(heading) * Math.cos(pitch), Math.sin(pitch), -Math.sin(heading) * Math.cos(pitch))));

    const w = Math.max(240, el.clientWidth), h = 340, lower = 132;

    renderer.setSize(w, h, false); camera.aspect = w / (h - lower); camera.updateProjectionMatrix();

    renderer.setScissorTest(true); renderer.setViewport(0, lower, w, h - lower); renderer.setScissor(0, lower, w, h - lower); renderer.render(scene, camera);

    onboard.aspect = 16 / 9; onboard.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(frame.hfov) / 2) / onboard.aspect)); onboard.updateProjectionMatrix();

    const cameraWidth = lower * 16 / 9, left = (w - cameraWidth) / 2;

    renderer.setViewport(0, 0, w, lower); renderer.setScissor(0, 0, w, lower); renderer.clear();

    renderer.setViewport(left, 0, cameraWidth, lower); renderer.setScissor(left, 0, cameraWidth, lower); drone.visible = false; path.visible = false; renderer.render(scene, onboard); drone.visible = true; path.visible = true;

    if (text) {

      const event = channel.value === 'configuration' ? { capabilities: run.capabilities ?? 'Not separately recorded in this legacy run', arrangement: run.controllerArrangement ?? 'See original experiment manifest', config: run.config ?? 'Legacy settings in frozen source', scoring: run.evaluation.metric ?? 'Original one-second attainment' } : run.replayEvents.findLast(e => e.channel === channel.value && e.simMs <= ms);

      raw.textContent = JSON.stringify({ atSeconds: ms / 1000, ...(run.termination && ms > run.observedMs! ? { recordingStoppedAtSeconds: run.observedMs! / 1000, lastRecordedPoseShown: true, termination: run.termination } : {}), ...(frame.fallback !== undefined ? { localHold: frame.fallback, controllerStopped: frame.controllerStopped } : {}), targetVisible: frame.visible, sideInspectionGeometry: frame.inspectable, event: event ?? 'No record yet' }, null, 2);

    }

  }

  channel.addEventListener('change', () => render(Number(seek.value), true));

  return { el, render, dispose() { controls.dispose(); scene.traverse(obj => { if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) { obj.geometry.dispose(); if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose()); else obj.material.dispose(); } }); renderer.dispose(); renderer.forceContextLoss(); } };

}

function selected() {

  cards.forEach(c => c.dispose()); cards = [];

  const element = root.querySelector('#cards')!; element.replaceChildren();

  const armOrder = ['jev', 'claude', 'codex', 'hybrid', 'jev-bare', 'jev-facts', 'claude-facts', 'codex-facts', 'jev-brief', 'jev-repair'];

  for (const run of runs.filter(r => r.seed === Number(seedSelect.value)).sort((a, b) => armOrder.indexOf(a.arm) - armOrder.indexOf(b.arm))) { const value = card(run); cards.push(value); element.append(value.el); }

  seek.value = '200'; cursorMs = 200; seek.max = String(Math.max(...runs.map(r => r.seconds)) * 1000); paintAt = 0;

}

function load(report: any) {

  if (!Array.isArray(report.results) || !report.results.length || report.results.length > 80 || report.results.some((r: any) => !r.scenario || !r.replayEvents || !r.evaluation?.trajectory?.length)) throw new Error('Expected a generated flight replay.json');

  runs = report.results; seedSelect.replaceChildren();

  for (const seed of [...new Set(runs.map(r => r.seed))]) { const option = document.createElement('option'); option.value = String(seed); option.textContent = String(seed); seedSelect.append(option); }

  status.textContent = `${report.manifest.phase === 'fixture' ? 'OFFLINE MECHANICS FIXTURE (no model inference). ' : ''}${runs.length} recorded trials${report.comparison && !report.comparison.complete ? ` of ${report.comparison.expected} planned (partial batch)` : ''}${report.comparison?.invalid ? ` · ${report.comparison.invalid} infrastructure-invalid (no flight score)` : ''}${report.comparison?.terminated ? ` · ${report.comparison.terminated} terminated early` : ''} · ${report.manifest.phase} · source ${String(report.manifest.sourceHash).slice(0, 12)} · raw complete JSONL traces remain beside this replay.`;

  selected();

}

root.querySelector<HTMLInputElement>('#file')!.addEventListener('change', async event => { try { const file = (event.target as HTMLInputElement).files?.[0]; if (file) { if (file.size > 75_000_000) throw new Error('Replay exceeds 75 MB'); load(JSON.parse(await file.text())); } } catch (e) { status.textContent = String(e); } });

seedSelect.addEventListener('change', selected);

seek.addEventListener('input', () => { cursorMs = Number(seek.value); paintAt = 0; });

playButton.addEventListener('click', () => { playing = !playing; playButton.textContent = playing ? 'Pause' : 'Play'; });

function frame(now: number) {

  if (playing) { cursorMs = Math.min(Number(seek.max), cursorMs + now - last); seek.value = String(cursorMs); if (cursorMs >= Number(seek.max)) { playing = false; playButton.textContent = 'Play'; } }

  last = now; const ms = Number(seek.value), paint = now - paintAt > 150; if (paint) paintAt = now;

  time.textContent = `${(ms / 1000).toFixed(1)} s`; cards.forEach(c => c.render(ms, paint)); requestAnimationFrame(frame);

}

requestAnimationFrame(frame);

const reportPath = new URL(location.href).searchParams.get('report');

if (reportPath && /^\/\.runtime\/experiments\/[\w-]+\/replay\.json$/.test(reportPath)) void fetch(reportPath).then(r => { if (!r.ok) throw new Error(`Replay HTTP ${r.status}`); return r.json(); }).then(load).catch(e => { status.textContent = String(e); });

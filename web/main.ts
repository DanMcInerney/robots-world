import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { BodySpec, BodyState, Diagnostic, Job, RobotDescription, Scenario, SensorReading } from '../src/contracts.ts';
import { installComparisonViewer } from './comparison.ts';
import type { ComparisonReport } from '../experiments/comparison-contract.ts';
import './style.css';

interface RobotView { id: string; model: string; owner?: string | null; description?: RobotDescription; sensors: Record<string, SensorReading>; jobs: Job[]; fault?: string }
interface Snapshot { epoch: string; simMs: number; paused: boolean; physics: string; scenario: Scenario; robots: RobotView[]; bodies: (BodySpec & BodyState)[]; diagnostics: Diagnostic[]; network?: Record<string, unknown>; demo?: boolean }
interface ScenarioOption { id: string; label: string; description: string }

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
<main class="app">
  <header class="masthead"><div class="brand-mark" aria-hidden="true">⌘</div><div><div class="brand-title">Robots World</div><div class="brand-subtitle">A laboratory for control</div></div><div class="divider"></div><div class="project-label">One world. Any controller.</div><div class="connection offline" id="connection"><span class="status-dot"></span><span id="connection-text">Connecting</span></div><button id="help" class="quiet icon" aria-label="Connection instructions">?</button></header>
  <div class="toolbar"><label class="field"><span class="field-label">Scene</span><select id="scenario" aria-label="Scenario"><option>Loading scenes…</option></select></label><label class="field"><span class="field-label">Physics</span><select id="physics" aria-label="Physics backend"><option value="rapier">Rapier · rigid bodies</option><option value="kinematic">Kinematic · motion only</option></select></label><button id="reset" title="Reset the scene and revoke existing controller access">↻ Reset</button><button id="compare" title="Inspect the latest recorded controller comparison">Compare experiments</button><span class="spacer"></span><button id="demo" class="primary">▶ Run baseline</button><button id="pause">Ⅱ Pause</button><button id="step" title="Advance one simulation tick">Step</button><button id="stop" class="danger">■ Stop all</button></div>
  <div id="error" class="error-banner" role="alert"></div>
  <section class="stage" aria-label="Three-dimensional world"><div id="viewport" style="position:absolute;inset:0"></div><div class="robot-labels" id="robot-labels"></div><div class="stage-top"><span class="stage-badge live" id="scene-badge">SIMULATION / ENU</span><span class="stage-badge" id="scenario-caption">Loading world</span></div><div class="stage-bottom"><div class="scene-caption"><strong>GROUND TRUTH · INSPECTOR VIEW</strong><br>Drag to orbit / scroll to zoom / click a robot label</div><div class="world-metrics"><div><span class="eyebrow">Sim clock</span><span class="metric-value" id="clock">0.00 <span class="metric-unit">s</span></span></div><div><span class="eyebrow">Robots</span><span class="metric-value" id="robot-count">—</span></div><div><span class="eyebrow">Devices</span><span class="metric-value" id="device-count">—</span></div><div><span class="eyebrow">Seed</span><span class="metric-value" id="seed">—</span></div></div></div></section>
  <section class="cockpit" aria-label="Robot data cockpit"><div class="cockpit-toolbar"><div class="section-name">Data cockpit</div><select id="robot" class="robot-select" aria-label="Inspected robot"></select><span class="owner-chip" id="owner">No controller attached</span><button id="manual" class="quiet icon">Command</button><span class="spacer"></span><input class="search" id="search" type="search" placeholder="Filter raw data…" aria-label="Filter diagnostics"><label class="scope"><input id="all-robots" type="checkbox" checked>All robots</label><button id="freeze" class="quiet icon" title="Freeze log rendering; simulation keeps running">Freeze logs</button><button id="export" class="quiet icon" title="Export the bounded diagnostic buffer as NDJSON">↓ Export</button></div>
  <div class="panels">
    <section class="panel"><header class="panel-header"><span class="panel-index">01</span><span class="panel-title">Controller activity</span><span class="panel-sub" id="control-count">0 events</span><button class="quiet icon" data-expand="control" title="Inspect controller log buffer">↗</button></header><div class="panel-body" id="control-body"></div></section>
    <section class="panel"><header class="panel-header"><span class="panel-index">02</span><span class="panel-title">Wire / protocol</span><span class="panel-sub" id="protocol-count">0 frames</span><button class="quiet icon" data-expand="protocol" title="Inspect protocol log buffer">↗</button></header><div class="panel-body" id="protocol-body"></div></section>
    <section class="panel"><header class="panel-header"><span class="panel-index">03</span><span class="panel-title">Robot telemetry</span><div class="panel-tabs"><button class="active" id="tab-sensors">Sensors</button><button id="tab-jobs">Jobs</button></div><button class="quiet icon" data-expand="telemetry" title="Inspect raw telemetry">↗</button></header><div class="panel-body" id="sensor-body"></div></section>
    <section class="panel"><header class="panel-header"><span class="panel-index">04</span><span class="panel-title" id="network-title">Peer network</span><div class="panel-tabs"><button class="active" id="tab-network">Radio</button><button id="tab-world">World</button></div><span class="panel-sub" id="network-count">0 events</span><button class="quiet icon" data-expand="network" title="Inspect network or world log buffer">↗</button></header><div class="network-strip" id="network-strip"><span><span class="dot"></span>Explicit peer messages</span><span>Queue admission ≠ delivery</span></div><div class="panel-body" id="network-body"></div></section>
  </div></section>
  <footer class="footer"><span id="footer-status">Waiting for simulator</span><span class="optional">Sensors acquire independently of inference</span><span class="spacer"></span><span id="buffer-count">0 / 1,200 events</span><span>SI · ENU</span></footer>
</main>
<dialog id="inspector"><header class="dialog-header"><span class="dialog-title" id="inspector-title">Raw data</span><button id="copy-json">Copy JSON</button><button id="close-inspector" class="quiet">✕</button></header><div class="dialog-content"><pre class="json" id="inspector-json"></pre></div></dialog>
<dialog id="manual-dialog"><header class="dialog-header"><span class="dialog-title" id="manual-title">Robot command</span><button id="close-manual" class="quiet">✕</button></header><div class="dialog-content"><form class="manual-form" id="manual-form"><label>Action<select id="action"></select></label><div class="muted" id="action-description"></div><label>Arguments · JSON<textarea id="arguments" spellcheck="false">{}</textarea></label><div class="muted">Commands go through the same admission and ownership checks as other controllers.</div><button class="primary" type="submit">Send command</button></form></div></dialog>
<dialog id="help-dialog"><header class="dialog-header"><span class="dialog-title">Connect a controller</span><button id="close-help" class="quiet">✕</button></header><div class="dialog-content help-content"><p>The world runs independently of its controllers. Start a scripted baseline here, or attach a controller from the project terminal. Every controller receives a scoped robot I/O port.</p><p>See controller options:<code>npm run agent -- --help</code></p><p>Run reproducible experiments:<code>npm run experiment -- --help</code></p><p>The cockpit shows real summaries, tool events, command receipts, sensor samples and protocol frames when an adapter emits them. Private model reasoning is not exposed.</p><p class="note">The scene is an inspector view with ground truth. Controllers receive only their robot's configured observations. Physics fidelity depends on the backend and model; hardware qualification is separate.</p></div></dialog>
<div class="toast" id="toast" hidden></div>`;

function el<T extends HTMLElement = HTMLElement>(id: string): T { return document.getElementById(id) as T; }
const fmt = (value: unknown) => JSON.stringify(value, null, 2);
const compact = (value: unknown) => JSON.stringify(value);
let token = '';
const bootstrap = new URLSearchParams(location.hash.slice(1));
let viewerToken = bootstrap.get('viewer') ?? sessionStorage.getItem('robots-world-viewer') ?? '';
if (bootstrap.has('viewer')) { sessionStorage.setItem('robots-world-viewer', viewerToken); history.replaceState(null, '', `${location.pathname}${location.search}`); }
let snapshot: Snapshot | undefined;
let diagnostics: Diagnostic[] = [];
let cursor = 0;
let epoch = '';
let selectedRobot = '';
let frozen = false;
let frozenDiagnostics: Diagnostic[] = [];
let telemetryTab: 'sensors' | 'jobs' = 'sensors';
let networkTab: 'network' | 'world' = 'network';
let selectedDiagnostic = -1;
let demo = false;
let pollBusy = false;
let toastTimer: ReturnType<typeof setTimeout>;
const scenarios: ScenarioOption[] = [];

function toast(message: string) { el('toast').textContent = message; el('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el('toast').hidden = true; }, 3300); }
function showError(message: string) { el('error').textContent = message; el('error').classList.toggle('visible', Boolean(message)); }
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'X-World-Admin': token } : {}), ...(path === '/api/session' && viewerToken ? { 'X-World-Viewer': viewerToken } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? value.message ?? `Request failed (${response.status})`);
  return value as T;
}
installComparisonViewer(el<HTMLButtonElement>('compare'), () => api<ComparisonReport | null>('/api/comparison'), trialId => api<Diagnostic[]>(`/api/comparison/trace/${encodeURIComponent(trialId)}`));
async function action(path: string, body: unknown) { try { showError(''); const result = await api(path, body); await poll(); return result; } catch (error) { showError(error instanceof Error ? error.message : String(error)); return undefined; } }
function inspect(title: string, value: unknown) { el('inspector-title').textContent = title; el('inspector-json').textContent = fmt(value) ?? String(value); el<HTMLDialogElement>('inspector').showModal(); }
function robot() { return snapshot?.robots.find(r => r.id === selectedRobot); }
function setRobot(id: string) { selectedRobot = id; el<HTMLSelectElement>('robot').value = id; renderData(); }
function visibleDiagnostics(channel?: string) {
  const query = el<HTMLInputElement>('search').value.toLowerCase();
  return (frozen ? frozenDiagnostics : diagnostics).filter(entry => (!channel || entry.channel === channel) && (el<HTMLInputElement>('all-robots').checked || !entry.robotId || entry.robotId === selectedRobot) && (!query || compact(entry).toLowerCase().includes(query)));
}
function summary(entry: Diagnostic) {
  const data = entry.data;
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object') {
    const object = data as Record<string, unknown>;
    const text = object.summary ?? object.text ?? object.message ?? object.reason;
    if (typeof text === 'string') return text;
  }
  return compact(data) ?? '';
}
function logRows(container: HTMLElement, entries: Diagnostic[], channel: string, emptyHTML: string) {
  if (!entries.length) { container.innerHTML = emptyHTML; return; }
  const previousTop = container.scrollTop;
  const fragment = document.createDocumentFragment();
  for (const entry of entries.slice(-75).reverse()) {
    const row = document.createElement('button'); row.className = `log-row ${channel}${entry.id === selectedDiagnostic ? ' selected' : ''}${/reject|error|drop|fault|expired/i.test(entry.kind) ? ' warn' : ''}`;
    const time = document.createElement('span'); time.className = 'log-time'; time.textContent = `${(entry.simMs / 1000).toFixed(2)}s`;
    const kind = document.createElement('span'); kind.className = 'log-kind'; kind.textContent = entry.kind; kind.title = entry.kind;
    const content = document.createElement('span'); content.className = 'log-content';
    if (entry.robotId) { const name = document.createElement('span'); name.className = 'log-robot'; name.textContent = `${entry.robotId} ›`; content.append(name); }
    content.append(document.createTextNode(summary(entry))); row.append(time, kind, content); row.onclick = () => { selectedDiagnostic = entry.id; inspect(`${entry.channel} / ${entry.kind}`, entry); }; fragment.append(row);
  }
  container.replaceChildren(fragment); container.scrollTop = previousTop;
}
function renderSensors() {
  const current = robot(); const body = el('sensor-body');
  if (!current) { body.innerHTML = '<div class="empty">Select a robot to inspect its devices.</div>'; return; }
  if (telemetryTab === 'jobs') {
    if (!current.jobs?.length) { body.innerHTML = '<div class="empty"><strong>No actuator jobs.</strong><br>Accepted commands appear here with their completion, cancellation or expiry status.</div>'; return; }
    const list = document.createElement('div'); list.className = 'job-list';
    for (const job of current.jobs.slice(-30).reverse()) { const card = document.createElement('button'); card.className = 'job-card'; card.style.width = '100%'; card.style.textAlign = 'left'; const title = document.createElement('strong'); title.textContent = job.action; const state = document.createElement('span'); state.className = 'status'; state.textContent = job.status; const args = document.createElement('div'); args.textContent = compact(job.args); card.append(title, state, args); card.onclick = () => inspect(`${current.id} / job ${job.id}`, job); list.append(card); }
    body.replaceChildren(list); return;
  }
  const entries = Object.entries(current.sensors ?? {});
  if (!entries.length) { body.innerHTML = '<div class="empty"><strong>Waiting for sensor acquisition.</strong><br>Sensor plugins determine frequency, noise, delivery delay and validity.</div>'; return; }
  const grid = document.createElement('div'); grid.className = 'sensor-grid';
  for (const [name, reading] of entries) {
    const card = document.createElement('button'); card.className = 'sensor-card'; const header = document.createElement('header'); const title = document.createElement('span'); title.className = 'name'; title.textContent = name;
    const quality = document.createElement('span'); quality.className = `quality${reading.valid ? '' : ' invalid'}`; quality.textContent = reading.valid ? 'VALID' : reading.reason ?? 'INVALID'; header.append(title, quality);
    const value = document.createElement('div'); value.className = 'sensor-value'; value.textContent = compact(reading.value);
    const meta = document.createElement('div'); meta.className = 'sensor-meta'; meta.textContent = `#${reading.sequence} · age ${Math.max(0, (snapshot?.simMs ?? 0) - reading.acquiredSimMs).toFixed(0)}ms · delay ${Math.max(0, reading.receivedSimMs - reading.acquiredSimMs).toFixed(0)}ms`;
    card.append(header, value, meta); card.onclick = () => inspect(`${current.id} / ${name}`, { specification: current.description?.sensors.find(sensor => sensor.id === name), reading }); grid.append(card);
  }
  const previousTop = body.scrollTop; body.replaceChildren(grid); body.scrollTop = previousTop;
}
function renderData() {
  const current = robot();
  el('owner').textContent = current?.owner ? String(current.owner) : 'No controller attached';
  el('owner').title = current?.fault ?? (current?.owner ? `Actuator owner: ${current.owner}` : 'This robot has no actuator owner.');
  const control = visibleDiagnostics('control'); const protocol = visibleDiagnostics('protocol'); const network = visibleDiagnostics(networkTab);
  el('control-count').textContent = `${control.length} events`; el('protocol-count').textContent = `${protocol.length} frames`; el('network-count').textContent = `${network.length} events`;
  logRows(el('control-body'), control, 'control', '<div class="empty"><strong>Ready for a controller.</strong><br>Run a baseline above or attach Codex, Claude, Nervelet or your own RobotPort controller. Tool calls and readable summaries appear here.<br><code>npm run agent -- --help</code></div>');
  logRows(el('protocol-body'), protocol, 'protocol', '<div class="empty"><strong>No wire frames yet.</strong><br>Attach a protocol adapter to inspect actual transmitted bytes, decoded messages and command receipts. Click an event for its complete payload.</div>');
  el('network-title').textContent = networkTab === 'network' ? 'Peer network' : 'World events';
  logRows(el('network-body'), network, networkTab, networkTab === 'network' ? '<div class="empty"><strong>No peer packets yet.</strong><br>Swarm controllers communicate through explicit channels with range, bandwidth, queue, latency, jitter and loss constraints.</div>' : '<div class="empty"><strong>No world events in this buffer.</strong><br>Lifecycle transitions, engine faults and inspector events appear here.</div>');
  renderSensors();
  const radio = current?.description?.radio;
  if (radio) { const strip = el('network-strip'); strip.replaceChildren(); for (const label of [`${radio.channel}`, `${radio.rangeM}m range`, `${Math.round(radio.bitrateBps / 1000)}kb/s`, `${radio.latencyMs}ms + jitter`, `${Math.round(radio.loss * 100)}% loss`]) { const item = document.createElement('span'); item.textContent = label; strip.append(item); } }
  el('buffer-count').textContent = `${diagnostics.length.toLocaleString()} / 1,200 events${frozen ? ' · FROZEN' : ''}`;
  labels.forEach((label, id) => label.classList.toggle('selected', id === selectedRobot));
}

const scene = new THREE.Scene(); scene.background = new THREE.Color('#172634'); scene.fog = new THREE.Fog('#172634', 35, 100);
const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 300); camera.up.set(0, 0, 1); camera.position.set(17, -23, 20);
let renderer: THREE.WebGLRenderer | undefined; let controls: OrbitControls | undefined;
const meshes = new Map<string, { mesh: THREE.Mesh; spec: string }>();
const labels = new Map<string, HTMLElement>();
const light = new THREE.HemisphereLight('#bcdcea', '#253845', 2.3); light.position.set(0, 0, 15); scene.add(light);
const sun = new THREE.DirectionalLight('#e7f0ee', 3.6); sun.position.set(-8, -12, 22); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.camera.left = -30; sun.shadow.camera.right = 30; sun.shadow.camera.top = 30; sun.shadow.camera.bottom = -30; sun.shadow.bias = -0.0005; scene.add(sun);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(160, 160), new THREE.MeshStandardMaterial({ color: '#1a2d3b', roughness: .96 })); floor.position.z = -.08; floor.receiveShadow = true; scene.add(floor);
const grid = new THREE.GridHelper(80, 80, '#446074', '#2a4253'); grid.rotation.x = Math.PI / 2; grid.position.z = .015; scene.add(grid);
const axes = new THREE.AxesHelper(2); axes.position.set(-.01, -.01, .02); scene.add(axes);
const selectionRing = new THREE.Mesh(new THREE.RingGeometry(.8, .83, 64), new THREE.MeshBasicMaterial({ color: '#75e0d0', transparent: true, opacity: .7, side: THREE.DoubleSide })); selectionRing.position.z = .025; scene.add(selectionRing);
try {
  renderer = new THREE.WebGLRenderer({ antialias: true }); renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap; renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.15; el('viewport').append(renderer.domElement);
  controls = new OrbitControls(camera, renderer.domElement); controls.target.set(0, 0, .5); controls.enableDamping = true; controls.maxPolarAngle = Math.PI * .48; controls.minDistance = 2; controls.maxDistance = 100;
  new ResizeObserver(() => { const { width, height } = el('viewport').getBoundingClientRect(); renderer!.setSize(width, height); camera.aspect = width / Math.max(height, 1); camera.updateProjectionMatrix(); }).observe(el('viewport'));
} catch (error) { el('viewport').innerHTML = '<div class="canvas-fallback">WebGL is unavailable. Live data and controller tools remain available below.</div>'; console.error(error); }
function rootBody(id: string) { return snapshot?.bodies.find(body => body.id === `${id}/base` || body.id === `${id}:base` || body.id === id) ?? snapshot?.bodies.find(body => body.id.startsWith(`${id}/`) || body.id.startsWith(`${id}:`) || body.id.startsWith(`${id}.`)); }
function updateScene(data: Snapshot, resetCamera: boolean) {
  const seen = new Set<string>();
  for (const body of data.bodies) {
    if (!body.shape) continue; seen.add(body.id); const spec = compact(body.shape); let existing = meshes.get(body.id);
    if (existing && existing.spec !== spec) { scene.remove(existing.mesh); existing.mesh.geometry.dispose(); (existing.mesh.material as THREE.Material).dispose(); meshes.delete(body.id); existing = undefined; }
    if (!existing) {
      const size = body.shape.size; let geometry: THREE.BufferGeometry;
      if (body.shape.kind === 'sphere') { geometry = new THREE.SphereGeometry(.5, 24, 16); geometry.scale(size.x, size.y, size.z); }
      else if (body.shape.kind === 'capsule') { const radius = Math.min(size.x, size.y) / 2; geometry = new THREE.CapsuleGeometry(radius, Math.max(.001, size.z - radius * 2), 6, 12); geometry.rotateX(Math.PI / 2); }
      else geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
      const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: body.shape.color ?? (body.mode === 'fixed' ? '#5c7180' : '#7bdccd'), metalness: .22, roughness: .6 })); mesh.castShadow = true; mesh.receiveShadow = true; mesh.userData.bodyId = body.id; scene.add(mesh); existing = { mesh, spec }; meshes.set(body.id, existing);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 20), new THREE.LineBasicMaterial({ color: '#cee6eb', transparent: true, opacity: .13 })); mesh.add(edges);
    }
    existing.mesh.position.set(body.pose.position.x, body.pose.position.y, body.pose.position.z); existing.mesh.quaternion.set(body.pose.rotation.x, body.pose.rotation.y, body.pose.rotation.z, body.pose.rotation.w);
  }
  for (const [id, entry] of meshes) if (!seen.has(id)) { scene.remove(entry.mesh); entry.mesh.geometry.dispose(); (entry.mesh.material as THREE.Material).dispose(); entry.mesh.children.forEach(child => { if (child instanceof THREE.LineSegments) { child.geometry.dispose(); (child.material as THREE.Material).dispose(); } }); meshes.delete(id); }
  for (const item of data.robots) if (!labels.has(item.id)) { const label = document.createElement('button'); label.className = 'robot-tag'; label.textContent = item.id; label.onclick = () => setRobot(item.id); labels.set(item.id, label); el('robot-labels').append(label); }
  for (const [id, label] of labels) if (!data.robots.some(item => item.id === id)) { label.remove(); labels.delete(id); }
  if (resetCamera && controls) { const bound = Math.max(data.scenario.bounds?.x ?? 14, data.scenario.bounds?.y ?? 14); const span = Math.max(7, Math.min(bound, 10)); camera.position.set(span * .85, -span * 1.2, span * .9); controls.target.set(0, 1, .7); controls.update(); }
}
function animate() {
  requestAnimationFrame(animate); if (!renderer) return; controls?.update();
  const rect = el('viewport').getBoundingClientRect();
  const placed: { x: number; y: number; width: number }[] = [];
  for (const [id, label] of labels) {
    const body = rootBody(id); if (!body) { label.hidden = true; continue; }
    const point = new THREE.Vector3(body.pose.position.x, body.pose.position.y, body.pose.position.z + .65).project(camera);
    label.hidden = point.z > 1 || point.z < -1 || Math.abs(point.x) > 1 || Math.abs(point.y) > 1;
    const width = label.offsetWidth || 70; const baseX = (point.x * .5 + .5) * rect.width; const baseY = (-point.y * .5 + .5) * rect.height;
    let x = baseX; let y = Math.max(48, baseY);
    for (let attempts = 0; attempts < 18 && placed.some(previous => Math.abs(previous.x - x) < (previous.width + width) / 2 + 5 && Math.abs(previous.y - y) < 23); attempts++) {
      const column = [1, -1, 0][attempts % 3]!; x = Math.max(width / 2 + 10, Math.min(rect.width - width / 2 - 10, baseX + column * (width + 8))); y = Math.max(48, baseY - Math.floor(attempts / 3) * 23);
    }
    placed.push({ x, y, width }); label.style.left = `${x}px`; label.style.top = `${y}px`;
  }
  const selected = rootBody(selectedRobot); selectionRing.visible = Boolean(selected); if (selected) selectionRing.position.set(selected.pose.position.x, selected.pose.position.y, .035);
  renderer.render(scene, camera);
}
animate();

async function poll() {
  if (pollBusy || !token) return; pollBusy = true;
  try {
    const data = await api<Snapshot>(`/api/inspect?after=${cursor}`);
    const changedEpoch = epoch !== data.epoch;
    if (changedEpoch) { epoch = data.epoch; cursor = 0; diagnostics = []; frozenDiagnostics = []; }
    snapshot = data;
    if (typeof data.demo === 'boolean') demo = data.demo;
    const known = new Set(diagnostics.map(entry => entry.id)); for (const entry of data.diagnostics ?? []) if (!known.has(entry.id)) { diagnostics.push(entry); cursor = Math.max(cursor, entry.id); }
    if (diagnostics.length > 1200) diagnostics.splice(0, diagnostics.length - 1200);
    const selector = el<HTMLSelectElement>('robot');
    if (selector.options.length !== data.robots.length || [...selector.options].some((option, index) => option.value !== data.robots[index]?.id)) { selector.replaceChildren(...data.robots.map(item => { const option = document.createElement('option'); option.value = item.id; option.textContent = `${item.id} / ${item.model}`; return option; })); }
    if (!data.robots.some(item => item.id === selectedRobot)) selectedRobot = data.robots[0]?.id ?? '';
    selector.value = selectedRobot;
    if (changedEpoch) { el<HTMLSelectElement>('scenario').value = data.scenario.id; el<HTMLSelectElement>('physics').value = data.physics; }
    el('clock').innerHTML = `${(data.simMs / 1000).toFixed(2)} <span class="metric-unit">s</span>`;
    el('robot-count').textContent = String(data.robots.length); el('device-count').textContent = String(data.robots.reduce((total, item) => total + (item.description?.sensors.length ?? Object.keys(item.sensors ?? {}).length), 0)); el('seed').textContent = String(data.scenario.seed);
    el('scene-badge').textContent = `${data.paused ? 'PAUSED' : 'SIMULATION'} / ${data.physics.toUpperCase()} / ENU`; el('scene-badge').classList.toggle('live', !data.paused);
    el('scenario-caption').textContent = scenarios.find(item => item.id === data.scenario.id)?.label ?? data.scenario.id;
    el('pause').textContent = data.paused ? '▶ Resume' : 'Ⅱ Pause'; el('demo').textContent = demo ? '■ End baseline' : '▶ Run baseline';
    el('connection').classList.remove('offline'); el('connection-text').textContent = data.paused ? 'World paused · connected' : 'Local world connected';
    el('footer-status').textContent = `${data.physics} · ${(1 / data.scenario.dt).toFixed(0)} Hz · ${data.bodies.length} bodies`;
    updateScene(data, changedEpoch); renderData();
  } catch (error) { el('connection').classList.add('offline'); el('connection-text').textContent = 'Disconnected · retrying'; el('footer-status').textContent = error instanceof Error ? error.message : String(error); }
  finally { pollBusy = false; }
}
el('robot').onchange = () => setRobot(el<HTMLSelectElement>('robot').value);
el('search').oninput = renderData; el('all-robots').onchange = renderData;
el('pause').onclick = () => void action('/api/pause', { paused: !snapshot?.paused });
el('step').onclick = () => void action('/api/step', { ticks: 1 });
el('stop').onclick = async () => { if (await action('/api/stop', {})) { demo = false; toast('All actuator owners stopped and revoked.'); } };
el('reset').onclick = async () => { const result = await action('/api/reset', { scenario: el<HTMLSelectElement>('scenario').value, physics: el<HTMLSelectElement>('physics').value }); if (result) { demo = false; toast('World reset. Previous controller access revoked.'); } };
el('demo').onclick = async () => { const desired = !demo; const result = await action('/api/demo', { enabled: desired }); if (result) { demo = desired; await poll(); toast(desired ? 'Scripted baseline started. No model inference.' : 'Scripted baseline stopped.'); } };
el('freeze').onclick = () => { frozen = !frozen; if (frozen) frozenDiagnostics = diagnostics.slice(); el('freeze').textContent = frozen ? 'Unfreeze logs' : 'Freeze logs'; el('freeze').classList.toggle('active', frozen); renderData(); };
el('tab-sensors').onclick = () => { telemetryTab = 'sensors'; el('tab-sensors').classList.add('active'); el('tab-jobs').classList.remove('active'); renderSensors(); };
el('tab-jobs').onclick = () => { telemetryTab = 'jobs'; el('tab-jobs').classList.add('active'); el('tab-sensors').classList.remove('active'); renderSensors(); };
el('tab-network').onclick = () => { networkTab = 'network'; el('tab-network').classList.add('active'); el('tab-world').classList.remove('active'); renderData(); };
el('tab-world').onclick = () => { networkTab = 'world'; el('tab-world').classList.add('active'); el('tab-network').classList.remove('active'); renderData(); };
el('close-inspector').onclick = () => el<HTMLDialogElement>('inspector').close();
el('copy-json').onclick = async () => { try { await navigator.clipboard.writeText(el('inspector-json').textContent ?? ''); toast('Raw JSON copied.'); } catch { toast('Clipboard unavailable. Select the JSON to copy it.'); } };
el('help').onclick = () => el<HTMLDialogElement>('help-dialog').showModal(); el('close-help').onclick = () => el<HTMLDialogElement>('help-dialog').close();
document.querySelectorAll<HTMLButtonElement>('[data-expand]').forEach(button => { button.onclick = () => { const channel = button.dataset.expand === 'network' ? networkTab : button.dataset.expand; return channel === 'telemetry' ? inspect(`${selectedRobot} / telemetry`, robot()) : inspect(`${channel} / buffered events`, visibleDiagnostics(channel)); }; });
el('export').onclick = () => { const blob = new Blob([visibleDiagnostics().map(entry => compact(entry)).join('\n') + '\n'], { type: 'application/x-ndjson' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `robots-world-${snapshot?.scenario.id ?? 'events'}-${Date.now()}.ndjson`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); toast('Exported the currently filtered diagnostic buffer.'); };
function defaultArgs(schema: Record<string, unknown>): Record<string, unknown> { const result: Record<string, unknown> = {}; const properties = schema.properties as Record<string, Record<string, unknown>> | undefined; for (const [name, spec] of Object.entries(properties ?? {})) { if (spec.default !== undefined) result[name] = spec.default; else if (Array.isArray(spec.enum)) result[name] = spec.enum[0]; else if (spec.type === 'number' || spec.type === 'integer') result[name] = Math.max(0, Number(spec.minimum ?? 0)); else if (spec.type === 'boolean') result[name] = false; else if (spec.type === 'object') result[name] = defaultArgs(spec); else if (spec.type === 'array') result[name] = []; else result[name] = ''; } return result; }
function renderAction() { const spec = robot()?.description?.commands[el<HTMLSelectElement>('action').value]; el('action-description').textContent = spec?.description ?? ''; el<HTMLTextAreaElement>('arguments').value = fmt(defaultArgs(spec?.schema ?? {})); }
el('manual').onclick = () => { const current = robot(); const commands = current?.description?.commands; if (!current || !commands) { toast('This robot has no declared command interface.'); return; } el('manual-title').textContent = `${current.id} / command`; el<HTMLSelectElement>('action').replaceChildren(...Object.keys(commands).map(name => { const option = document.createElement('option'); option.value = name; option.textContent = name; return option; })); renderAction(); el<HTMLDialogElement>('manual-dialog').showModal(); };
el('action').onchange = renderAction; el('close-manual').onclick = () => el<HTMLDialogElement>('manual-dialog').close();
el('manual-form').onsubmit = async event => { event.preventDefault(); try { const args: unknown = JSON.parse(el<HTMLTextAreaElement>('arguments').value); if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Arguments must be a JSON object.'); const result = await action('/api/command', { robotId: selectedRobot, action: el<HTMLSelectElement>('action').value, args }); if (result) { el<HTMLDialogElement>('manual-dialog').close(); inspect('Command receipt', result); } } catch (error) { toast(error instanceof Error ? error.message : String(error)); } };
async function start() { try { const session = await api<{ adminToken?: string; token?: string }>('/api/session'); token = session.adminToken ?? session.token ?? ''; if (!token) throw new Error('The server did not provide a local inspector session.'); const options = await api<ScenarioOption[]>('/api/scenarios'); scenarios.splice(0, scenarios.length, ...options); el<HTMLSelectElement>('scenario').replaceChildren(...options.map(option => { const element = document.createElement('option'); element.value = option.id; element.textContent = option.label; element.title = option.description; return element; })); showError(''); await poll(); } catch (error) { showError(error instanceof Error ? error.message : String(error)); } }
window.addEventListener('hashchange', () => { const next = new URLSearchParams(location.hash.slice(1)).get('viewer'); if (next) { viewerToken = next; token = ''; sessionStorage.setItem('robots-world-viewer', next); history.replaceState(null, '', `${location.pathname}${location.search}`); void start(); } });
void start(); setInterval(() => void poll(), 200);

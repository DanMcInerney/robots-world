import { flightScene } from './jev-scene.ts';
import './pixels.css';

const root = document.querySelector<HTMLElement>('#pixels-root')!;
root.innerHTML = `<header><a href="/">ROBOTS WORLD</a> / <a href="/jev.html">Earlier Jev flights</a><p class="eyebrow">Camera control lab · actual Jev inference</p><h1>From camera pixels to drone motion</h1><p>Matched control experiments. No rangefinder, target broadcast or simulator geometry enters Jev's input.</p><div class="load"><label>Report <input id="path" type="text" aria-label="Report path"></label><button id="load">Load / refresh</button><span id="status"></span></div></header>
<section><div class="pipeline"><div><b>1 · Camera → text</b><p>320×180 pixels at 5 Hz → coloured regions, image bearings and apparent sizes. Range stays unknown.</p></div><div><b>2 · Jev chooses</b><p>English goal + current measurements → parallel questions about movement, heading, pitch and zoom.</p></div><div><b>3 · Drone moves</b><p>Selected values → MAVLink velocity + a dated camera adapter. Physics continues during inference; commands expire after 1 second.</p></div></div><p class="disclaimer">Each movement branch permits 43,218 control combinations without listing them all: 7 forward × 7 sideways × 7 vertical × 9 heading × 7 pitch × 2 zoom. The experiments change the text representation or the way those questions are grouped.</p><div class="table-scroll"><table><thead><tr><th>Arm</th><th>Completed</th><th>Passed</th><th>Framed time</th><th>Moving choices</th><th>Mean path</th><th>Blue detected</th><th>API p50*</th><th>Image age p95*</th><th>Tokens</th></tr></thead><tbody id="summary"></tbody></table></div><p>*API p50 is the mean of flight medians. Image age is the maximum per-flight p95, acquisition to first application. Framing averages both phases after warmup; success also requires continuous dwell and no collisions/boundary violations.</p><details><summary>Exact experiment design, goals, assumptions and source freeze</summary><pre id="manifest"></pre></details></section>
<section id="review" hidden><h2>What these runs show</h2><p id="review-summary"></p><ul id="review-points"></ul><div class="transport" id="review-links"></div></section>
<section><div class="transport"><label>Seed <select id="seed"></select></label><label>Left <select id="left"></select></label><label>Right <select id="right"></select></label><button id="play">Play</button><input id="seek" type="range" aria-label="Replay time" min="300" step="100" value="300"><output id="time"></output></div><div class="paired" id="flights"></div></section>
<section><h2>Decision cockpit</h2><div class="transport"><label>Inspect <select id="side"><option value="0">Left flight</option><option value="1">Right flight</option></select></label><button id="previous">Previous</button><select id="decision" aria-label="Decision"></select><button id="next">Next</button><label><input id="follow" type="checkbox" checked>Follow replay</label><a id="trace">Raw trace</a></div><p id="decision-meta"></p><div class="panels">
<article class="panel"><h3>1 · Exact observation supplied to Jev</h3><pre id="state"></pre><details><summary>Raw delivered sensor snapshot</summary><pre id="observation"></pre></details></article>
<article class="panel"><h3>2 · Instructions, full choices and probabilities</h3><select id="question" aria-label="Question"></select><pre id="instructions"></pre><pre id="answer"></pre><details><summary>Complete request and all responses, including unused branches</summary><pre id="request"></pre><pre id="response"></pre></details></article>
<article class="panel"><h3>3 · Selected controls and actual application</h3><pre id="mapping"></pre><details><summary>Wire records in this decision interval</summary><pre id="wire"></pre></details></article>
<article class="panel"><h3>4 · Flight results, audit and events</h3><pre id="evaluation"></pre><details><summary>Goal changes, target turns, failures and dropped commands</summary><pre id="events"></pre></details></article></div></section>`;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const select = (id: string) => $<HTMLSelectElement>(id), json = (id: string, data: unknown) => { $(id).textContent = JSON.stringify(data, null, 2); };
const fmt = (n: any, digits = 1) => typeof n === 'number' && Number.isFinite(n) ? n.toFixed(digits) : '—';
const options = (id: string, rows: { id: string; label: string }[], value?: string) => { select(id).replaceChildren(...rows.map(r => new Option(r.label, r.id))); if (value && rows.some(r => r.id === value)) select(id).value = value; };
let report: any, reportURL: URL, runs: any[] = [], scenes: ReturnType<typeof flightScene>[] = [], cursor = 300, playing = false, last = 0, generation = 0;
let imageKeys = ['', ''];
function localURL(path: string, base = location.href) { const url = new URL(path, base); if (url.origin !== location.origin) throw new Error('Use a local report'); return url; }
async function fetchJSON(url: URL) { const response = await fetch(url); if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); }
function summary() {
  const body = $('summary'); body.replaceChildren();
  for (const arm of report.manifest.arms) {
    const rows = report.runs.filter((r: any) => r.arm === arm), n = rows.length, mean = (key: string) => n ? rows.reduce((s: number, r: any) => s + (r.metrics[key] ?? 0), 0) / n : null;
    const row = document.createElement('tr'), values = [report.manifest.definitions[arm].label, `${n}/${report.manifest.seeds.length}`, `${rows.filter((r: any) => r.metrics.success).length}/${n}`, `${fmt((mean('framingFraction') ?? 0) * 100)}%`, `${fmt((mean('movementFraction') ?? 0) * 100)}%`, `${fmt(mean('pathM'))} m`, `${fmt((mean('cameraBlueFraction') ?? 0) * 100)}%`, `${fmt(mean('apiP50Ms'), 0)} ms`, `${fmt(n ? Math.max(...rows.map((r: any) => r.metrics.appliedAgeP95Ms ?? 0)) : null, 0)} ms`, rows.reduce((s: number, r: any) => s + r.metrics.tokens, 0).toLocaleString()];
    if(report.manifest.inference==='synthetic')values[2]='Not scored';
    for (const value of values) { const td = document.createElement('td'); td.textContent = String(value); row.append(td); } body.append(row);
  }
}
async function load() {
  $('status').textContent = 'Loading…'; playing = false;
  try {
    reportURL = localURL($<HTMLInputElement>('path').value); report = await fetchJSON(reportURL);
    if (report.manifest.version !== 'jev-pixels-v1') throw new Error('This viewer expects a camera-only pixel report');
    summary(); json('manifest', report.manifest);
    root.querySelector<HTMLElement>('.eyebrow')!.textContent=report.manifest.inference==='synthetic'?'Camera control lab · MECHANICAL ONLY · no Jev inference':'Camera control lab · actual Jev inference';
    const sensorText=root.querySelector<HTMLElement>('.pipeline p');if(sensorText)sensorText.textContent=report.manifest.sensorDesign??'320×180 pixels at 5 Hz → coloured regions, image bearings and apparent sizes. Range stays unknown.';
    const scoringText=root.querySelector<HTMLElement>('.table-scroll + p');if(scoringText)scoringText.textContent=report.manifest.scoringNote??'*API p50 is the mean of flight medians. Image age is the maximum per-flight p95, acquisition to first application. Framing averages both phases after warmup; success also requires continuous dwell and no collisions/boundary violations.';
    const controls = root.querySelector<HTMLElement>('.disclaimer');
    if (controls && report.manifest.questionDesign) controls.textContent = report.manifest.questionDesign;
    $('review').hidden = !report.review;
    if (report.review) {
      $('review-summary').textContent = report.review.summary;
      $('review-points').replaceChildren(...report.review.points.map((text: string) => { const li = document.createElement('li'); li.textContent = text; return li; }));
      $('review-links').replaceChildren(...report.review.links.map((item: {label: string; url: string}) => { const link = document.createElement('a'); link.textContent = item.label; link.href = localURL(item.url, reportURL.href).href; return link; }));
    }
    options('seed', [...new Set<number>(report.runs.map((r: any) => r.seed))].map(n => ({ id: String(n), label: String(n) })));
    const rows = report.manifest.arms.map((id: string) => ({ id, label: report.manifest.definitions[id].label }));
    options('left', rows); options('right', rows, ['loop-temporal','pixels-history','colour-servo'].find(id=>rows.some((r:any)=>r.id===id))??rows[1]?.id);
    $<HTMLInputElement>('seek').max = String(report.manifest.seconds * 1000);
    $('status').textContent = `${report.runs.length} completed flights · ${report.manifest.phase}${report.stopped ? ' · BATCH STOPPED' : ''}${report.invalid.length ? ` · ${report.invalid.length} invalid attempts: ${JSON.stringify(report.invalid)}` : ''}`;
    await pair();
  } catch (error) { $('status').textContent = String(error); }
}
async function pair() {
  const currentGeneration = ++generation; playing = false; $('play').textContent = 'Play';
  const selected = ['left', 'right'].map(id => report.runs.find((r: any) => r.arm === select(id).value && r.seed === Number(select('seed').value)));
  if (selected.some(r => !r)) { $('status').textContent = 'Selected pair is not available yet; choose completed arms or refresh after the batch.'; return; }
  const loaded = await Promise.all(selected.map(r => fetchJSON(localURL(r.file, reportURL.href))));
  if (generation !== currentGeneration) return;
  for (const scene of scenes) scene.dispose(); scenes = []; runs = loaded; imageKeys = ['', '']; $('flights').replaceChildren();
  for (const [i, run] of runs.entries()) {
    const article = document.createElement('article'); article.className = 'flight';
    article.innerHTML = `<h2></h2><p class="description"></p><div class="metrics"></div><div class="scene"></div><p class="caption">3D inspector + geometric camera preview above. Actual recorded perception image below.</p><canvas class="image" width="320" height="180"></canvas><p class="caption frame-caption"></p>`;
    article.querySelector('h2')!.textContent = report.manifest.definitions[run.arm].label;
    article.querySelector('.description')!.textContent = report.manifest.definitions[run.arm].description;
    article.querySelector('.metrics')!.textContent = `${run.inference==='synthetic'?'MECHANICAL · not scored':run.metrics.success ? 'PASS' : 'FAIL'} · ${fmt(run.metrics.pathM)} m travelled · ${fmt(run.metrics.movementFraction * 100)}% moving choices · ${run.metrics.collisionTicks} collision ticks`;
    $('flights').append(article); scenes[i] = flightScene(article.querySelector<HTMLElement>('.scene')!, run);
  }
  changeSide(); draw();
}
function at(run: any) { return run.decisions.findLast((d: any) => d.observation.simMs <= cursor) ?? run.decisions[0]; }
function draw() {
  $('time').textContent = `${fmt(cursor / 1000)} s`; $<HTMLInputElement>('seek').value = String(cursor);
  for (const [i, run] of runs.entries()) {
    scenes[i]!.render(cursor); const d = at(run); if (!d) continue;
    const sensor = d.observation.sensors.camera, camera = sensor.value, card = $('flights').children[i]!;
    const key = `${generation}:${camera.frame}`; if (imageKeys[i] === key) continue; imageKeys[i] = key;
    const image = new Image(); image.onload = () => {
      if (imageKeys[i] !== key) return;
      const canvas = card.querySelector<HTMLCanvasElement>('canvas.image')!, context = canvas.getContext('2d')!; context.drawImage(image, 0, 0, 320, 180);
      context.lineWidth = 1; context.font = '10px monospace';
      for (const object of camera.objects) { const [x0, y0, x1, y1] = object.box; context.strokeStyle = '#6dffb2'; context.strokeRect(x0, y0, x1 - x0, y1 - y0); context.fillStyle = '#000'; context.fillRect(x0, Math.max(0, y0 - 12), 95, 12); context.fillStyle = '#fff'; context.fillText(`${object.id} ${object.color}`, x0 + 2, Math.max(10, y0 - 2)); }
    };
    image.src = localURL(camera.frame, reportURL.href).href;
    card.querySelector('.frame-caption')!.textContent = `Actual PNG used by this decision · acquired ${fmt(sensor.acquiredSimMs / 1000)} s · ${camera.objects.length} pixel regions · ${camera.kind==='tracked-regions-v1'?'optional vision worker':'perception'} ${fmt(camera.perceptionMs, 2)} ms. Boxes/IDs are computed overlays.`;
  }
  if ($<HTMLInputElement>('follow').checked && runs.length) { const run = runs[Number(select('side').value)]!; select('decision').value = String(run.decisions.indexOf(at(run))); inspect(); }
}
function changeSide() {
  const run = runs[Number(select('side').value)]; if (!run) return;
  options('decision', run.decisions.map((d: any, i: number) => ({ id: String(i), label: `${i + 1} · ${fmt(d.observation.simMs / 1000, 2)} s` })));
  $<HTMLAnchorElement>('trace').href = localURL(`${run.id}.jsonl`, reportURL.href).href;
  inspect();
}
function inspect() {
  const run = runs[Number(select('side').value)], d = run?.decisions[Number(select('decision').value)]; if (!d) return;
  $('decision-meta').textContent = `Decision ${Number(select('decision').value) + 1}: ${d.request.state.goal} API ${fmt(d.latencyMs, 0)} ms; image-to-application ${fmt(d.acquisitionToApplicationMs, 0)} ms. ${d.mapping?.receipt?.status ?? 'Not applied / cancelled'}.`;
  json('state', d.request.state); json('observation', d.observation); json('request', d.request); json('response', d.response ?? { cancelled: true });
  json('mapping', { selection: d.mapping, admission: d.admission, firstApplication: d.firstApplication });
  json('wire', run.wire.filter((w: any) => w.simMs >= d.observation.simMs && w.simMs < (run.decisions[Number(select('decision').value) + 1]?.observation.simMs ?? d.observation.simMs + 1000)));
  json('evaluation', { ...(run.scout?{scouting:run.scout,geometricDiagnostics:{meaning:'Legacy evaluator diagnostics; mission uses visible-patch scouting score above.',phases:run.evaluation.phases}}:{phases:run.evaluation.phases}), metrics: run.metrics, audit: run.audit, maxSimulationLagMs: run.maxLagMs }); json('events', run.events);
  const old = select('question').value; options('question', Object.keys(d.request.questions).map(id => ({ id, label: id })), old); question();
}
function question() { const d = runs[Number(select('side').value)]?.decisions[Number(select('decision').value)]; if (!d) return; json('instructions', { sharedContract: d.request.state.contract, question: d.request.questions[select('question').value] }); json('answer', d.response?.answers[select('question').value] ?? { cancelled: true }); }
$('load').onclick = () => { void load(); }; for (const id of ['seed', 'left', 'right']) select(id).onchange = () => { void pair().catch(e => { $('status').textContent = String(e); }); };
select('side').onchange = changeSide; select('decision').onchange = () => { $<HTMLInputElement>('follow').checked = false; const run = runs[Number(select('side').value)]; cursor = run.decisions[Number(select('decision').value)].observation.simMs; draw(); inspect(); }; select('question').onchange = question;
for (const [id, step] of [['previous', -1], ['next', 1]] as const) $(id).onclick = () => { select('decision').selectedIndex = Math.max(0, Math.min(select('decision').options.length - 1, select('decision').selectedIndex + step)); select('decision').dispatchEvent(new Event('change')); };
$('play').onclick = () => { playing = !playing; $('play').textContent = playing ? 'Pause' : 'Play'; };
$<HTMLInputElement>('seek').oninput = () => { cursor = Number($<HTMLInputElement>('seek').value); draw(); };
function tick(now: number) { if (playing && report && now - last > 90) { cursor = Math.min(report.manifest.seconds * 1000, cursor + now - last); if (cursor >= report.manifest.seconds * 1000) { playing = false; $('play').textContent = 'Play'; } draw(); } if (now - last > 90) last = now; requestAnimationFrame(tick); }
$<HTMLInputElement>('path').value = new URLSearchParams(location.search).get('report') ?? '/.runtime/experiments/jev-pixels-held-out-v2/report.json';
void load(); requestAnimationFrame(tick);

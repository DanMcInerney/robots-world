import { flightScene } from "./jev-scene.ts";
import "./jev.css";
const root = document.querySelector<HTMLElement>("#jev-root")!;
root.innerHTML = `<header><a href="/">ROBOTS WORLD</a><span class="eyebrow">/ REAL INFERENCE · RECORDED EXPERIMENTS</span><h1>Jev Flight Lab<span>From sensor to decision to motion.</span></h1><p>Inspect every input, option, probability and applied command. The world continues while Jev answers.</p><nav><a href="?report=/.runtime/experiments/jev-strategies-resumed-v1/report.json">Eight-strategy comparison</a> · <a href="?report=/.runtime/experiments/jev-axes-held-out-v1/report.json">Six-control geometry ablation</a> · <a href="/docs/jev-docs-audit.md">Documentation audit</a></nav><div class="load"><label>Report <input id="report-path" aria-label="Report path"></label><button id="load">Load / refresh</button><span id="status">Loading evidence…</span></div></header>
<section class="overview"><div class="section-title"><h2>Strategy comparison</h2><span>Same moving environment per seed · inspect each phase separately</span></div><p id="batch-stop" hidden></p><div id="continuation"></div><div id="incomplete-list"></div><div id="summary"></div><details id="method"><summary>How these tests work · assumptions · audit · sources</summary><div id="method-text"></div><pre id="manifest"></pre></details></section>
<section class="replay"><div class="transport"><label>Seed <select id="seed"></select></label><button id="play">Play</button><button id="back">−1 s</button><button id="forward">+1 s</button><input id="seek" aria-label="Replay time" type="range" min="100" max="60000" step="100" value="100"><output id="time">0.1 s</output><span>World + geometric camera replay</span></div><div id="flights"></div></section>
<section class="cockpit"><div class="section-title"><h2>Decision cockpit</h2><span>Exact recorded payloads · Jev supplies probabilities, no reasoning transcript</span></div><div class="inspect-controls"><label>Inspect <select id="inspect"><option value="0">Left flight</option><option value="1">Right flight</option></select></label><button id="previous">Previous decision</button><select id="decision" aria-label="Decision"></select><button id="next">Next decision</button><label><input id="follow" type="checkbox" checked> Follow replay</label><a id="trace">Full raw trace</a><a id="download">Decision JSON</a></div><p id="decision-status"></p>
<div class="panels"><article><h3>01 / Instructions & questions</h3><label>API stage <select id="stage"></select></label><label>Question <select id="question"></select></label><pre id="instructions"></pre><details><summary>Exact complete API request</summary><pre id="request"></pre></details></article>
<article><h3>02 / Choices & model output</h3><div id="probabilities"></div><label>Candidate <select id="candidate"></select></label><pre id="candidate-data"></pre><details open><summary>Exact answer for this question</summary><pre id="answer"></pre></details><details><summary>All responses + shortlist</summary><pre id="responses"></pre></details></article>
<article><h3>03 / What Jev could see</h3><p>Acquired timestamps are distinct from receipt and execution. Evaluator truth never enters these requests.</p><figure id="pixel-evidence" hidden><img id="pixel-frame" alt="Exact camera pixels used by the marker detector" style="width:100%;height:auto"><figcaption id="pixel-caption"></figcaption></figure><label>View <select id="sensor-view"><option value="delivered">Presented to Jev</option><option value="raw">Original delivered sensor snapshot</option></select></label><pre id="sensors"></pre></article>
<article><h3>04 / Robot I/O & timeline</h3><pre id="execution"></pre><details><summary>Exact wire records in this decision interval</summary><pre id="wire"></pre></details><details><summary>Goal changes, failures, holds and disturbances</summary><pre id="events"></pre></details></article></div></section>`;
for (const panel of root.querySelectorAll<HTMLElement>(".panels > article")) {
  const button = document.createElement("button");
  button.className = "expand-panel";
  button.textContent = "Expand";
  button.onclick = () => {
    const open = panel.classList.toggle("expanded");
    button.textContent = open ? "Close" : "Expand";
  };
  panel.prepend(button);
}
const sensorLink = document.createElement('a');
sensorLink.href = '?report=/.runtime/experiments/jev-sensors-held-out-v1/report.json';
sensorLink.textContent = 'Camera + TF-Luna comparison';
root.querySelector('nav')!.prepend(sensorLink, document.createTextNode(' · '));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape")
    for (const panel of root.querySelectorAll(".expanded")) {
      panel.classList.remove("expanded");
      panel.querySelector("button")!.textContent = "Expand";
    }
});
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const select = (id: string) => $<HTMLSelectElement>(id),
  json = (id: string, value: unknown) => {
    $(id).textContent = JSON.stringify(value, null, 2);
  };
function options(
  element: HTMLSelectElement,
  rows: { value: string; text: string }[],
  value?: string,
) {
  element.replaceChildren(...rows.map((r) => new Option(r.text, r.value)));
  if (value && rows.some((r) => r.value === value)) element.value = value;
}
const fmt = (n: any, d = 1) => (typeof n === "number" ? n.toFixed(d) : "—");
let report: any,
  path = "",
  active: any[] = [],
  views: ReturnType<typeof flightScene>[] = [],
  cursor = 100,
  playing = false,
  last = performance.now(),
  selected: any,
  loadingId = "",
  generation = 0;
const input = $<HTMLInputElement>("report-path");
input.value =
  new URL(location.href).searchParams.get("report") ??
  "/.runtime/experiments/jev-strategies-resumed-v1/report.json";
async function get(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.json();
}
function url(file: string) {
  return path.slice(0, path.lastIndexOf("/") + 1) + file;
}
async function load() {
  try {
    if (!/^\/\.runtime\/experiments\/[\w-]+\/report\.json$/.test(input.value))
      throw new Error("Use /.runtime/experiments/<batch>/report.json");
    const incoming = await get(input.value);
    path = input.value;
    report = incoming;
    $("continuation").replaceChildren();
    if (report.manifest.continuation) {
      const c = report.manifest.continuation, p = document.createElement('p');
      p.textContent = `CONTINUATION AFTER FUNDING — ${c.retainedTrials.length} original non-billing flights retained; ${c.priorBillingAttempts.length} billing-blocked attempts were retried. This table measures performance conditional on service availability. Original failures remain preserved. `;
      if (/^\/\.runtime\/experiments\/[\w-]+\/report\.json$/.test(c.originalReport)) {
        const a = document.createElement('a'); a.href = `?report=${encodeURIComponent(c.originalReport)}`; a.textContent = 'Inspect original billing attempts'; p.append(a);
      }
      $('continuation').append(p);
    }
    $("batch-stop").hidden = !report.stopped;
    $("batch-stop").textContent = report.stopped
      ? `BATCH STOPPED — ${report.stopped.message}${report.stopped.reason === "billing-exhausted" ? " Billing failures remain in the all-attempt table; they do not measure Jev decision quality." : ""}`
      : "";
    $("incomplete-list").replaceChildren();
    for (const item of report.invalidTrials) {
      const p = document.createElement("p");
      p.textContent = `${item.id}: ${item.error} `;
      if (/^[\w-]+$/.test(item.id)) {
        const a = document.createElement("a");
        a.href = url(`${item.id}.jsonl`);
        a.textContent = "Preserved raw trace";
        a.download = `${item.id}.jsonl`;
        p.append(a);
      }
      $("incomplete-list").append(p);
    }
    history.replaceState(null, "", `?report=${encodeURIComponent(path)}`);
    $("status").textContent =
      `${report.manifest.phase.toUpperCase()} · ${report.runs.length}/${report.manifest.strategies.length * report.manifest.seeds.length} full-length flights · ${report.stopped ? "STOPPED" : report.complete ? "batch complete" : "partial batch"} · ${report.invalidTrials.length} incomplete / invalid`;
    const table = document.createElement("table");
    table.innerHTML =
      "<thead><tr><th>Strategy</th><th>Pass / runs</th><th>Framing</th><th>Rover visible</th><th>Questions / calls</th><th>Decision p50 / p95</th><th>Applied sensor age p50</th><th>Contact / hold</th><th>Rejected / errors / guards</th><th>Input tokens</th></tr></thead><tbody></tbody>";
    for (const s of report.summary) {
      const tr = document.createElement("tr");
      const ds = report.runs.filter((r: any) => r.arm === s.id).flatMap((r: any) => r.decisions);
      const rs = report.runs.filter((r: any) => r.arm === s.id);
      const range = (ns: number[]) => !ns.length ? '—' : Math.min(...ns) === Math.max(...ns) ? String(ns[0]) : `${Math.min(...ns)}–${Math.max(...ns)}`;
      for (const v of [
        report.manifest.definitions[s.id].label,
        `${s.successes}/${s.attempts}${s.invalid ? ` +${s.invalid} invalid` : ""}`,
        `${fmt(s.framingFraction === null ? null : s.framingFraction * 100)}%`,
        `${fmt(rs.length ? rs.reduce((sum: number, r: any) => sum + r.evaluation.visibleFraction, 0) / rs.length * 100 : null)}%`,
        `${range(ds.flatMap((d: any) => d.questions))} / ${range(ds.filter((d: any) => d.selection).map((d: any) => d.calls))}`,
        `${fmt(s.decisionP50Ms, 0)} / ${fmt(s.decisionP95Ms, 0)} ms`,
        `${fmt(s.applicationAgeP50Ms, 0)} ms`,
        `${fmt(s.contactsSeconds)} / ${fmt(s.fallbackSeconds)} s`,
        `${s.rejected} / ${s.errors} / ${s.guardInterventions}`,
        Number(s.tokens).toLocaleString(),
      ]) {
        const td = document.createElement("td");
        td.textContent = v;
        tr.append(td);
      }
      table.querySelector("tbody")!.append(tr);
    }
    $("summary").replaceChildren(table);
    const tableNote = document.createElement('p'); tableNote.textContent = 'Visibility measures camera geometry, not successful task completion or delivered-detection rate. Questions = questions in each API request. Calls = requests per completed decision. Ranges show observed counts; inspect a decision for its exact request structure.'; $('summary').append(tableNote);
    if (report.runs.some((r: any) => r.sensorCoverage)) {
      const coverage = document.createElement('table');
      coverage.innerHTML = '<caption>Actual sensor evidence available to the controller</caption><thead><tr><th>Flight</th><th>Observed images with marker</th><th>Fresh marker at request</th><th>Fresh valid TF-Luna at request</th></tr></thead><tbody></tbody>';
      for (const run of report.runs.filter((r: any) => r.sensorCoverage)) {
        const c = run.sensorCoverage, tr = document.createElement('tr');
        for (const value of [run.id, `${c.imagesWithMarker} / ${c.uniqueImages}`, `${c.freshMarkerObservations} / ${c.observations}`, c.rangeObservations ? `${c.freshValidRangeObservations} / ${c.rangeObservations}` : 'Not installed']) {
          const td = document.createElement('td'); td.textContent = value; tr.append(td);
        }
        coverage.querySelector('tbody')!.append(tr);
      }
      const note = document.createElement('p');
      note.textContent = 'The camera preprocessing detects only the declared printed roof marker. A blank detection list supplies no target pose or visual obstacle map. Images are counted once; request counts include repeated images and the final cancelled inference. TF-Luna validity requires both a fresh delivery and a usable physical return; it does not identify the hit object.';
      $('summary').append(coverage, note);
    }
    $("method-text").replaceChildren();
    for (const text of [
      report.manifest.design,
      "Primary pass: at least 50% correct side + distance + central framing in EACH goal phase after its five-second warm-up, with a one-second continuous dwell; no collisions, boundary breaches, controller failures or delivery-guard intervention.",
      ...report.manifest.limitations.map((text: string) => {
        const correction = report.manifest.displayCorrections?.find((c: any) => c.original === text);
        return correction ? `Reporting correction (original wording retained in the manifest): ${correction.corrected}` : text;
      }),
      "The returned Choice field selects the action. After development exposed a one-percentage-point disagreement with the largest displayed probability, the frozen validator allows that discrepancy for rounded tables; larger disagreements fail the controller. Its cause is unverified. Raw responses are retained, and no alternative is substituted. Confidence and probabilities are model judgments, not measured mission-success rates.",
      "Framing percentages average the two phases equally. Contact and hold columns are totals across runs. Latency excludes unfinished requests; raw traces preserve cancellation and failures. Tokens include all received API usage, including responses rejected by validation; cancelled calls may have unreported billing.",
      ...(report.manifest.strategies.includes('flat-prose') ? ["Raw controls, calculated geometry and compact prose differ in information presentation. One-second commands also alter prediction horizon and menu coverage. Neither comparison isolates just model speed."] : []),
    ]) {
      const p = document.createElement("p");
      p.textContent = text;
      $("method-text").append(p);
    }
    for (const [id, definition] of Object.entries(
      report.manifest.definitions,
    ) as any) {
      const p = document.createElement("p");
      p.textContent = `${definition.label}: ${definition.description}`;
      $("method-text").append(p);
    }
    for (const source of report.manifest.sources) {
      const a = document.createElement("a");
      a.href = source;
      a.textContent = source;
      a.target = "_blank";
      a.rel = "noreferrer";
      $("method-text").append(a, document.createElement("br"));
    }
    const snapshot = document.createElement('a'); snapshot.href = url('source/SNAPSHOT.json'); snapshot.textContent = 'Archived source manifest and frozen source hash'; snapshot.target = '_blank'; snapshot.rel = 'noreferrer'; $('method-text').append(snapshot);
    json("manifest", {
      manifest: report.manifest,
      audit: report.audit,
      invalidTrials: report.invalidTrials,
      stopped: report.stopped,
    });
    options(
      select("seed"),
      report.manifest.seeds.map((s: number) => ({
        value: String(s),
        text: String(s),
      })),
      select("seed").value,
    );
    buildFlights();
  } catch (e) {
    $("status").textContent = String(e);
  }
}
function buildFlights() {
  views.forEach((v) => v.dispose());
  views = [];
  active = [];
  $("flights").replaceChildren();
  const runs = report.runs.filter(
    (r: any) => r.seed === Number(select("seed").value),
  );
  for (let i = 0; i < 2; i++) {
    const card = document.createElement("article");
    card.className = "flight";
    card.innerHTML =
      '<div class="flight-heading"><select aria-label="Flight strategy"></select><b></b></div><p class="flight-description"></p><div class="scene"></div><p class="flight-state"></p><details class="flight-score"><summary>Exact goals & scoring for this flight</summary><p></p><pre></pre></details>';
    $("flights").append(card);
    const chooser = card.querySelector("select")!;
    options(
      chooser,
      runs.map((r: any) => ({
        value: r.id,
        text: report.manifest.definitions[r.arm].label,
      })),
    );
    if (i && runs[1]) chooser.value = runs[1].id;
    const setup = () => {
      views[i]?.dispose();
      const run = runs.find((r: any) => r.id === chooser.value);
      active[i] = run;
      const container = card.querySelector<HTMLElement>(".scene")!;
      container.replaceChildren();
      if (!run) { container.textContent = 'No full flight recorded for this seed. Incomplete attempts, if any, remain listed above.'; return; }
      card.querySelector("b")!.textContent = run.evaluation.success
        ? "PASS"
        : "FAIL";
      card.querySelector("b")!.className = run.evaluation.success
        ? "pass"
        : "fail";
      card.querySelector(".flight-description")!.textContent =
        `${run.stats.completed} decisions · ${fmt(run.latencyP50Ms, 0)} ms median · framing ${run.evaluation.phases.map((p: any) => fmt(p.framingFraction * 100)).join("% / ")}% · ${run.stats.errors} errors · ${run.evaluation.guardInterventions} guards`;
      const { trajectory: _trajectory, ...evaluation } = run.evaluation;
      const reasons: string[] = [];
      evaluation.phases.forEach((phase: any, index: number) => {
        if (phase.framingFraction < evaluation.metric.minimumFramingFraction)
          reasons.push(
            `Goal ${index + 1}: ${fmt(phase.framingFraction * 100)}% correct side + range + framing, below ${evaluation.metric.minimumFramingFraction * 100}%.`,
          );
        if (phase.inspectedAt === null)
          reasons.push(`Goal ${index + 1}: continuous dwell not achieved.`);
      });
      for (const [key, label] of [
        ["collisionTicks", "contact ticks"],
        ["boundsTicks", "boundary violation ticks"],
        ["controllerFailures", "controller failures"],
        ["guardInterventions", "delivery guard interventions"],
      ])
        if (evaluation[key]) reasons.push(`${evaluation[key]} ${label}.`);
      card.querySelector(".flight-score p")!.textContent = evaluation.success
        ? "All predeclared conditions passed."
        : reasons.join(" ");
      card.querySelector(".flight-score pre")!.textContent = JSON.stringify(
        { evaluation, config: run.config, sourceHash: run.sourceHash },
        null,
        2,
      );
      views[i] = flightScene(container, run);
      rebuildDecisions();
      paint();
    };
    chooser.onchange = setup;
    setup();
  }
  $<HTMLInputElement>("seek").max = String(report.manifest.seconds * 1000);
  rebuildDecisions();
  paint();
}
function currentRun() {
  return active[Number(select("inspect").value)];
}
function rebuildDecisions() {
  const run = currentRun();
  if (!run) {
    generation++; selected=null; loadingId='';
    for(const id of ['decision','stage','question','candidate'])options(select(id),[]);
    for(const id of ['instructions','request','candidate-data','answer','responses','sensors','execution','wire','events'])$(id).textContent='No recorded decision for this selection.';
    $('probabilities').replaceChildren();$('decision-status').textContent='No completed flight for this seed and strategy.';
    $('trace').hidden=true;$('download').hidden=true;return;
  }
  $('trace').hidden=false;$('download').hidden=false;
  options(
    select("decision"),
    run.decisions.map((d: any) => ({
      value: String(d.index),
      text: `#${d.index + 1} · ${(d.simMs / 1000).toFixed(2)} s · ${d.choice ?? "no valid selection"}`,
    })),
  );
  loadingId = "";
  $<HTMLAnchorElement>("trace").href = url(run.traceFile);
  $<HTMLAnchorElement>("trace").download = run.traceFile;
  loadDecision();
}
async function loadDecision() {
  const run = currentRun(),
    meta = run?.decisions[Number(select("decision").value)];
  if (!meta || loadingId === meta.id) return;
  loadingId = meta.id;
  const gen = ++generation;
  try {
    const d = await get(url(meta.file));
    if (gen !== generation) return;
    selected = d;
    $("decision-status").textContent =
      `${run.id} · decision #${meta.index + 1} · observed ${(meta.simMs / 1000).toFixed(2)} s · ${Number(meta.offered).toLocaleString()} ${d.candidateScope ? 'joint tuples via factored questions' : 'offered bundles'} · ${meta.calls} API call(s) · ${fmt(meta.latencyMs, 0)} ms · ${meta.accepted === null ? "not admitted" : meta.accepted ? "admitted" : "rejected"} · first applied ${meta.appliedMs === null ? "never" : `${(meta.appliedMs / 1000).toFixed(2)} s (${meta.applicationAgeMs} ms old)`}`;
    options(
      select("stage"),
      d.requests.map((r: any, i: number) => ({
        value: String(i),
        text: `${i + 1}. ${r.stage}`,
      })),
    );
    options(
      select("candidate"),
      d.candidates.map((c: any) => ({
        value: c.id,
        text: `${c.id === d.selection?.choice ? "✓ " : ""}${c.id} · ${c.motion}; ${c.camera}`,
      })),
      d.selection?.choice,
    );
    $<HTMLAnchorElement>("download").href = url(meta.file);
    $<HTMLAnchorElement>("download").download = meta.file.split("/").at(-1);
    json("responses", {
      responses: d.responses,
      shortlist: d.shortlist,
      selection: d.selection,
    });
    json("execution", {
      source: d.source,
      execution: d.execution ?? "No validated action executed",
      admission: d.admission ?? null,
      applications: d.applications,
      checks: run.checks,
    });
    json("wire", { scope: d.wireScope, records: d.wire });
    json("events", run.events);
    stage();
    candidate();
  } catch (e) {
    $("decision-status").textContent = String(e);
  }
}
function stage() {
  if (!selected) return;
  const request = selected.requests[Number(select("stage").value)]?.request;
  if (!request) return;
  options(
    select("question"),
    Object.keys(request.questions).map((id) => ({ value: id, text: id })),
  );
  json("request", request);
  question();
  sensors();
}
function question() {
  if (!selected) return;
  const request = selected.requests[Number(select("stage").value)],
    name = select("question").value,
    q = request.request.questions[name],
    response = selected.responses.find((r: any) => r.id === request.id),
    answer = response?.body?.answers?.[name];
  json("instructions", {
    exactEnglishGoal: request.request.state.goal,
    instructions: q.instructions,
    questionCountInThisCall: Object.keys(request.request.questions).length,
    offeredOptionsInThisQuestion: q.criteria,
    ...(q.type === "score" ? { scoreLevels: q.criteria } : {}),
  });
  json("answer", answer ?? response ?? "No response recorded");
  $("probabilities").replaceChildren();
  for (const [id, probability] of Object.entries(answer?.probabilities ?? {})
    .sort((a: any, b: any) => b[1] - a[1])
    .slice(0, 10) as [string, number][]) {
    const row = document.createElement("div");
    row.className = "probability";
    const label = document.createElement("span");
    label.textContent = id;
    label.title = typeof q.criteria?.[id] === 'string' ? q.criteria[id] : JSON.stringify(q.criteria?.[id]) ?? id;
    const bar = document.createElement("meter");
    bar.min = 0;
    bar.max = 1;
    bar.value = probability;
    const value = document.createElement("span");
    value.textContent = `${fmt(probability * 100)}%`;
    row.append(label, bar, value);
    $("probabilities").append(row);
  }
  candidate();
}
function candidate() {
  if (selected) {
    const id = select("candidate").value,
      request = selected.requests[Number(select("stage").value)]?.request,
      q = request?.questions[select("question").value];
    const requestId = selected.requests[Number(select('stage').value)]?.id;
    const chosen = selected.responses.find((r: any) => r.id === requestId)?.body?.answers?.[select('question').value]?.choice;
    json("candidate-data", {
      modelSelectedForThisQuestion: chosen ? { id: chosen, description: q?.criteria?.[chosen] } : null,
      offeredInThisQuestion:
        q?.criteria?.[id] ??
        "This question uses another grouping; inspect its complete request.",
      diagnosticOnly: selected.candidates.find((c: any) => c.id === id),
      note: selected.candidateScope ?? "diagnosticOnly includes reconstructed geometry even for raw-control runs. Only the exact API request is evidence of what Jev received.",
    });
  }
}
function sensors() {
  const camera = selected?.rawObservation?.sensors?.camera;
  const frame = camera?.value?.frame;
  $('pixel-evidence').hidden = !frame;
  if (typeof frame === 'string' && /^frames\/[\w-]+\/camera-\d+\.png$/.test(frame)) {
    $<HTMLImageElement>('pixel-frame').src = url(frame);
    $('pixel-caption').textContent = `Actual perception input acquired at ${(camera.acquiredSimMs / 1000).toFixed(2)} s. ${camera.value.detections.length} marker detection(s). Jev receives the computed measurements below, not image pixels. The 3D replay above is evaluator-only.`;
  } else $('pixel-evidence').hidden = true;
  if (selected)
    json(
      "sensors",
      select("sensor-view").value === "raw"
        ? selected.rawSensors
        : selected.requests[Number(select("stage").value)].request.state,
    );
}
function paint() {
  for (const [i, run] of active.entries()) {
    if (!run) continue;
    views[i]?.render(cursor);
    const f =
      run.evaluation.trajectory.findLast((f: any) => f.simMs <= cursor) ??
      run.evaluation.trajectory[0];
    const state = document.querySelectorAll(".flight-state")[i];
    if (state && f)
      state.textContent = `Goal ${f.goalVersion ?? 1} · ${f.inspectable ? "view geometry met" : "seeking requested view"} · ${f.visible ? "rover visible" : "rover out of view"}${f.fallback ? ` · HOLD: ${f.fallback}` : ""}`;
  }
  $<HTMLInputElement>("seek").value = String(cursor);
  $("time").textContent = `${(cursor / 1000).toFixed(1)} s`;
  if ($<HTMLInputElement>("follow").checked) {
    const run = currentRun(),
      d = run?.decisions.findLast((d: any) => d.simMs <= cursor);
    if (d) {
      select("decision").value = String(d.index);
      loadDecision();
    }
  }
}
$("load").onclick = load;
select("seed").onchange = buildFlights;
select("inspect").onchange = () => {
  rebuildDecisions();
  paint();
};
select("stage").onchange = stage;
select("question").onchange = question;
select("candidate").onchange = candidate;
select("sensor-view").onchange = sensors;
select("decision").onchange = () => {
  $<HTMLInputElement>("follow").checked = false;
  loadDecision();
};
function step(delta: number) {
  const run = currentRun();
  if (!run) return;
  $<HTMLInputElement>("follow").checked = false;
  const index = Math.max(
    0,
    Math.min(
      run.decisions.length - 1,
      Number(select("decision").value) + delta,
    ),
  );
  select("decision").value = String(index);
  cursor = run.decisions[index].simMs;
  loadDecision();
  paint();
}
$("previous").onclick = () => step(-1);
$("next").onclick = () => step(1);
$("play").onclick = () => {
  playing = !playing;
  $("play").textContent = playing ? "Pause" : "Play";
};
$<HTMLInputElement>("seek").oninput = () => {
  cursor = Number($<HTMLInputElement>("seek").value);
  paint();
};
$("back").onclick = () => {
  cursor = Math.max(100, cursor - 1000);
  paint();
};
$("forward").onclick = () => {
  cursor = Math.min(report.manifest.seconds * 1000, cursor + 1000);
  paint();
};
let paintedAt = 0;
function animate(now: number) {
  const dt = now - last;
  last = now;
  if (playing && report) {
    cursor = Math.min(report.manifest.seconds * 1000, cursor + dt);
    if (cursor >= report.manifest.seconds * 1000) {
      playing = false;
      $("play").textContent = "Play";
    }
  }
  if (report && now - paintedAt >= 100) {
    paint();
    paintedAt = now;
  }
  requestAnimationFrame(animate);
}
await load();
requestAnimationFrame(animate);

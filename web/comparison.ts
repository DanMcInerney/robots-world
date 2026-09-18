import type { ComparisonReport, ComparisonTrial, Distribution } from '../experiments/comparison-contract.ts';
import { comparisonLabel } from '../experiments/comparison-contract.ts';
import type { Diagnostic } from '../src/contracts.ts';

type Loader = () => Promise<ComparisonReport | null | { report: ComparisonReport | null }>;
type TraceLoader = (trialId: string) => Promise<Diagnostic[]>;
const SVG = 'http://www.w3.org/2000/svg';
const COLORS = ['#75e0d0', '#e5ae76'] as const;
function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag); element.className = className; if (text !== undefined) element.textContent = text; return element;
}
function button(text: string, callback: () => void, className = '') { const element = node('button', className, text); element.type = 'button'; element.onclick = callback; return element; }
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number>, text?: string): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG, tag); for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value)); if (text !== undefined) element.textContent = text; return element;
}
const number = (value: number | null | undefined, digits = 2, unit = '') => typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(digits)}${unit}` : 'unknown';
const percentile = (value: Distribution, key: 'p50' | 'p95' = 'p50') => number(value[key], 0, ' ms');
const pretty = (value: unknown) => JSON.stringify(value, null, 2);
function evidenceLabel(trial: ComparisonTrial) { return trial.evidence === 'live-jev' ? 'LIVE JEV' : trial.arm === 'code-local' ? 'LOCAL CODE' : 'SIMULATED'; }
function option(value: string, text: string) { const element = node('option', '', text); element.value = value; return element; }
function correlations(value: unknown, prefix = '', depth = 0): { key: string; value: string }[] {
  if (!value || typeof value !== 'object' || depth > 6) return [];
  const result: { key: string; value: string }[] = [];
  for (const [key, entry] of Object.entries(value).slice(0, 100)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (/(decision.?id|command.?id|job.?id|observation.?id|observation.?sequence|sensor.?sequence|parent.?id|event.?id)$/i.test(key) && (typeof entry === 'string' || typeof entry === 'number')) result.push({ key: path, value: String(entry) });
    else if (key === 'observation' && (typeof entry === 'number' || typeof entry === 'string')) result.push({ key: path, value: String(entry) });
    if (entry && typeof entry === 'object') result.push(...correlations(entry, path, depth + 1));
  }
  return result;
}
function decisionIds(entry: Diagnostic): string[] { return correlations(entry.data).filter(item => /decision.?id$/i.test(item.key)).map(item => item.value); }
function describeDistribution(label: string, distribution: Distribution) {
  return `${label}: n=${distribution.count}; p50 ${number(distribution.p50, 1)}; p95 ${number(distribution.p95, 1)}; p99 ${number(distribution.p99, 1)}; max ${number(distribution.max, 1)} ms`;
}

/** The host supplies an authenticated loader; credentials never enter this module or report exports. */
export function installComparisonViewer(trigger: HTMLButtonElement, load: Loader, loadTrace: TraceLoader): void {
  const dialog = node('dialog', 'comparison-dialog'); dialog.setAttribute('aria-labelledby', 'comparison-title');
  const header = node('header', 'comparison-header');
  const heading = node('div'); const eyebrow = node('div', 'eyebrow', 'Experiment evidence'); const title = node('h2', '', 'Controller comparison'); title.id = 'comparison-title'; heading.append(eyebrow, title);
  const headerActions = node('div', 'comparison-header-actions');
  const reload = button('↻ Reload latest', () => void refresh());
  const exportButton = button('↓ Export summary', () => { if (report) download(report); }); exportButton.disabled = true;
  const close = button('✕', () => dialog.close(), 'quiet'); close.setAttribute('aria-label', 'Close comparison'); headerActions.append(reload, exportButton, close); header.append(heading, headerActions);
  const content = node('div', 'comparison-content'); dialog.append(header, content); document.body.append(dialog);
  let report: ComparisonReport | undefined;
  let request = 0;
  let playing = false;
  let replayFrame = 0;
  let lastFrame = 0;
  let lastPaint = 0;
  let cursorMs = 0;
  let firstId = '';
  let secondId = '';
  let traceSide = 'a';
  let selectedTrace: Diagnostic | undefined;
  let seek: HTMLInputElement | undefined;
  let timelineReadout: HTMLElement | undefined;
  let playButton: HTMLButtonElement | undefined;
  let chartCards: HTMLElement[] = [];
  let durationMs = 0;
  let timelineDetails: HTMLElement | undefined;
  let traceList: HTMLElement | undefined;
  let traceDetail: HTMLElement | undefined;
  let traceCoverage: HTMLElement | undefined;
  let traceCount: HTMLElement | undefined;
  let decisionFilter: HTMLInputElement | undefined;
  let eventFilter: HTMLInputElement | undefined;
  let traceSelector: HTMLSelectElement | undefined;
  let traceLoadButton: HTMLButtonElement | undefined;
  let traceExportButton: HTMLButtonElement | undefined;
  let traceLoadError = '';
  const fullTraces = new Map<string, Diagnostic[]>();
  const loadingTraces = new Set<string>();

  const selected = () => [report?.trials.find(trial => trial.id === firstId), report?.trials.find(trial => trial.id === secondId)].filter((trial): trial is ComparisonTrial => Boolean(trial));
  const traceTrial = () => selected()[traceSide === 'b' ? 1 : 0];
  function stopPlayback() { playing = false; cancelAnimationFrame(replayFrame); if (playButton) playButton.textContent = '▶ Replay'; }
  dialog.addEventListener('close', stopPlayback);
  trigger.onclick = () => { if (!dialog.open) dialog.showModal(); void refresh(); };
  async function refresh() {
    const currentRequest = ++request; stopPlayback(); exportButton.disabled = true; reload.disabled = true;
    content.replaceChildren(node('div', 'comparison-empty', 'Loading the latest experiment report…'));
    try {
      const response = await load(); if (currentRequest !== request) return;
      const result = response && 'report' in response ? response.report : response;
      if (!result) { report = undefined; empty(); return; }
      if (result.schemaVersion !== 1 || result.kind !== 'controller-comparison' || !Array.isArray(result.trials)) throw new Error('Unsupported comparison artifact. Expected controller-comparison schema version 1.');
      if (report?.id !== result.id || report?.createdAt !== result.createdAt) fullTraces.clear();
      report = { ...result, trials: result.trials.map(trial => ({ ...trial, label: comparisonLabel(trial) })) };
      if (!report.trials.some(trial => trial.id === firstId)) firstId = report.trials[0]?.id ?? '';
      const first = report.trials.find(trial => trial.id === firstId);
      if (!report.trials.some(trial => trial.id === secondId)) secondId = report.trials.find(trial => trial.seed === first?.seed && trial.id !== firstId)?.id ?? report.trials[1]?.id ?? firstId;
      exportButton.disabled = false; renderReport();
    } catch (error) { if (currentRequest === request) empty(error instanceof Error ? error.message : String(error)); }
    finally { if (currentRequest === request) reload.disabled = false; }
  }
  function empty(message?: string) {
    const box = node('div', 'comparison-empty'); box.append(node('div', 'comparison-empty-symbol', '↔'), node('h3', '', 'No comparison report available'), node('p', '', 'Generate a comparison artifact in the project terminal, then reload it here.'), node('code', '', 'npm run compare'));
    box.append(node('p', 'muted', 'Opening this viewer does not launch controllers, model calls or hardware.'));
    if (message) box.append(node('p', 'comparison-error', message)); content.replaceChildren(box);
  }
  function renderReport() {
    if (!report) return; content.replaceChildren();
    const banner = node('section', `comparison-evidence ${report.evidence === 'mixed' ? 'mixed' : ''}`);
    const hasLive = report.trials.some(trial => trial.evidence === 'live-jev');
    const hasSimulated = report.trials.some(trial => trial.arm !== 'code-local' && (trial.evidence !== 'live-jev' || trial.arm === 'agent-jev'));
    banner.append(node('strong', '', hasLive ? hasSimulated ? 'MIXED EVIDENCE · CHECK EACH TRIAL' : 'MEASURED LIVE JEV · LOCAL CONTROL COMPARISON' : 'NO LIVE INFERENCE · SIMULATED TIMING'));
    banner.append(node('p', '', hasLive ? hasSimulated ? 'Simulated controller timing and live Jev requests are labeled per trial. Any native-agent startup remains simulated.' : 'Jev rows contain actual API responses and measured client latency. Local-code rows use deterministic control. No native Codex or Claude session was run.' : 'These trials inject controller delays to test control architectures. They do not measure Codex, Claude or Jev inference speed, reasoning quality, token usage or price.'));
    const meta = node('div', 'comparison-run-meta'); meta.append(node('span', '', `Report ${report.id}`), node('span', '', new Date(report.createdAt).toLocaleString()), node('span', '', `${report.trials.length} trials · ${new Set(report.trials.map(trial => trial.seed)).size} seeds`)); banner.append(meta); content.append(banner);
    content.append(renderTable());
    if (!report.trials.length) { content.append(node('p', 'comparison-empty', 'This report contains no trials.')); content.append(provenance()); return; }
    const compareSection = node('section', 'comparison-section');
    const sectionHeading = node('div', 'comparison-section-heading'); sectionHeading.append(node('h3', '', 'Inspect two trials'), node('p', '', 'Shared axes and a synchronized simulation-time cursor. These evaluator ground-truth trajectories show ENU X/Y; altitude remains in the sample readout. Controller observations may be delayed or noisy.')); compareSection.append(sectionHeading);
    const selectors = node('div', 'comparison-selectors');
    for (const [index, label] of ['Trial A', 'Trial B'].entries()) {
      const wrapper = node('label', `comparison-selector side-${index}`); wrapper.append(node('span', '', label)); const select = node('select'); select.setAttribute('aria-label', label);
      select.append(...report.trials.map(trial => option(trial.id, `${trial.label} · seed ${trial.seed} · ${evidenceLabel(trial)}`))); select.value = index === 0 ? firstId : secondId;
      select.onchange = () => { if (index === 0) firstId = select.value; else secondId = select.value; selectedTrace = undefined; updateComparison(); }; wrapper.append(select); selectors.append(wrapper);
    }
    compareSection.append(selectors);
    const timeline = node('div', 'comparison-timeline'); playButton = button('▶ Replay', () => { if (playing) stopPlayback(); else { if (cursorMs >= durationMs) cursorMs = 0; playing = true; playButton!.textContent = 'Ⅱ Pause replay'; lastFrame = performance.now(); replayFrame = requestAnimationFrame(tickReplay); } });
    seek = node('input'); seek.type = 'range'; seek.min = '0'; seek.step = '1'; seek.setAttribute('aria-label', 'Synchronized simulation time'); seek.oninput = () => { stopPlayback(); cursorMs = Number(seek!.value); drawCharts(); };
    timelineReadout = node('output', 'mono'); timeline.append(playButton, seek, timelineReadout); compareSection.append(timeline);
    timelineDetails = node('div', 'comparison-cursor-note'); compareSection.append(timelineDetails);
    const plots = node('div', 'comparison-plots'); chartCards = [node('article', 'comparison-chart-card'), node('article', 'comparison-chart-card')]; plots.append(...chartCards); compareSection.append(plots); content.append(compareSection);
    content.append(renderTracePanel(), provenance()); updateComparison();
  }
  function renderTable() {
    const section = node('section', 'comparison-section'); const heading = node('div', 'comparison-section-heading'); heading.append(node('h3', '', 'All arms & seeds'), node('p', '', 'Each row is one trial; seeds are not pooled. Hover timing values for the complete distribution. Click a trial name for all metrics and event outcomes.')); section.append(heading);
    const scroll = node('div', 'comparison-table-scroll'); const table = node('table', 'comparison-table'); const caption = node('caption', 'sr-only', 'Comparison metrics for each controller architecture and seed'); table.append(caption);
    const head = node('thead'); const row = node('tr');
    for (const name of ['Controller arm / seed', 'Evidence', 'Tracking RMSE', 'Within radius', 'Contacts · excluding ground', 'Hold time', 'Judge requests', 'Applied / rejected', 'Discarded', 'Decision p50 · sim', 'Response p50 · wall', 'Activation delay p50 · wall', 'Sensor age p95', 'Reaction p50 · sim', 'Input / output tokens', 'Cost USD', 'Evidence gaps']) { const cell = node('th', '', name); cell.scope = 'col'; row.append(cell); }
    head.append(row); table.append(head); const body = node('tbody');
    for (const trial of report!.trials) {
      const line = node('tr'); const identity = node('th'); identity.scope = 'row'; const label = button(trial.label, () => trialDetails(trial), 'comparison-trial-link'); label.title = `Inspect ${trial.id}`; identity.append(label, node('small', '', `${trial.arm} · seed ${trial.seed}`)); line.append(identity);
      const badgeCell = node('td'); badgeCell.append(node('span', `comparison-badge ${trial.evidence === 'live-jev' ? 'live' : ''}`, evidenceLabel(trial))); line.append(badgeCell);
      const m = trial.metrics;
      const reactions = `${m.eventReactionMs.count ? percentile(m.eventReactionMs) : 'not observed'} (${m.eventReactionMs.count}/${trial.events.length})`;
      const activation = m.decisionActivationDelayWallMs ?? { count: 0, p50: null, p95: null, p99: null, max: null };
      const values = [number(m.trackingRmseM, 3, ' m'), number(m.withinRadiusPct, 1, '%'), number(m.collisionStarts, 0), number(m.holdMs / 1000, 2, ' s'), number(m.calls, 0), `${m.appliedCommands} / ${m.rejectedCommands}`, number(m.discardedDecisions, 0), percentile(m.decisionLatencySimMs), percentile(m.decisionLatencyWallMs), percentile(activation), percentile(m.sensorAgeAtCommandMs, 'p95'), reactions, `${number(m.inputTokens, 0)} / ${number(m.outputTokens, 0)}`, number(m.costUsd, 5), `${trial.traceCoverage.dropped} dropped / ${trial.traceCoverage.truncated} truncated`];
      values.forEach((value, index) => { const cell = node('td', value.includes('unknown') || value.includes('not observed') ? 'comparison-unavailable' : '', value); if (index === 7) cell.title = describeDistribution('Decision latency, simulation time', m.decisionLatencySimMs); if (index === 8) cell.title = describeDistribution('Request to response arrival, wall time', m.decisionLatencyWallMs); if (index === 9) cell.title = describeDistribution('Response arrival to controller activation, wall time', activation); if (index === 10) cell.title = describeDistribution('Sensor age at command', m.sensorAgeAtCommandMs); if (index === 11) cell.title = `${describeDistribution('Observed physical event reaction', m.eventReactionMs)}. Quantiles exclude events with no observed response.`; if (index === 14 && (trial.traceCoverage.dropped || trial.traceCoverage.truncated)) cell.classList.add('comparison-warning'); line.append(cell); }); body.append(line);
    }
    table.append(body); scroll.append(table); section.append(scroll, node('p', 'comparison-footnote', 'Simulation latency describes the trial schedule. Wall response time ends at arrival; activation delay measures the wait for the control poll. Selections exclude injected agent startup. Unknown usage and cost are not zero. A missing physical response is “not observed.”')); return section;
  }
  function trialDetails(trial: ComparisonTrial) {
    const nested = node('dialog', 'comparison-details-dialog'); const heading = node('header', 'dialog-header'); const title = node('h3', 'dialog-title', `${trial.label} · seed ${trial.seed}`); const close = button('✕', () => nested.close(), 'quiet'); close.setAttribute('aria-label', 'Close trial details'); heading.append(title, close); const content = node('div', 'dialog-content'); content.append(node('span', 'comparison-badge', evidenceLabel(trial)), node('p', 'comparison-footnote', 'Metrics retain their original null values in the artifact. null means unavailable or not observed, never zero.'), node('pre', 'json', pretty({ id: trial.id, arm: trial.arm, evidence: trial.evidence, configuration: trial.configuration, metrics: trial.metrics, events: trial.events, traceCoverage: trial.traceCoverage, finalStateHash: trial.finalStateHash })));
    nested.append(heading, content); document.body.append(nested); nested.onclose = () => nested.remove(); nested.showModal();
  }
  function updateComparison() {
    stopPlayback(); traceLoadError = ''; const trials = selected(); durationMs = Math.max(0, ...trials.map(trial => trial.series.at(-1)?.simMs ?? 0)); cursorMs = durationMs;
    if (seek) { seek.max = String(durationMs); seek.disabled = durationMs === 0; }
    if (traceSelector) { traceSelector.replaceChildren(...trials.map((trial, index) => option(index === 0 ? 'a' : 'b', `${index === 0 ? 'A' : 'B'} · ${trial.label} · seed ${trial.seed}`))); traceSelector.value = traceSide; }
    if (decisionFilter) decisionFilter.value = ''; drawCharts(); renderTrace();
  }
  function tickReplay(now: number) { if (!playing) return; cursorMs = Math.min(durationMs, cursorMs + Math.min(now - lastFrame, 250)); lastFrame = now; if (now - lastPaint >= 50 || cursorMs >= durationMs) { lastPaint = now; drawCharts(); } if (cursorMs >= durationMs) stopPlayback(); else replayFrame = requestAnimationFrame(tickReplay); }
  function drawCharts() {
    const trials = selected(); if (!trials.length || !seek || !timelineReadout) return;
    seek.value = String(cursorMs); timelineReadout.textContent = `${number(cursorMs / 1000, 2)} / ${number(durationMs / 1000, 2)} s`;
    const allSamples = trials.flatMap(trial => trial.series); const points = allSamples.flatMap(sample => [sample.robot, sample.target]);
    const xs = points.map(point => point.x), ys = points.map(point => point.y);
    const minX = xs.length ? Math.min(...xs) : -1, maxX = xs.length ? Math.max(...xs) : 1, minY = ys.length ? Math.min(...ys) : -1, maxY = ys.length ? Math.max(...ys) : 1;
    const extent = Math.max(maxX - minX, maxY - minY, 1) * 1.18; const centerX = (maxX + minX) / 2, centerY = (maxY + minY) / 2;
    const errorMax = Math.max(.1, ...allSamples.map(sample => sample.errorM)) * 1.12;
    timelineDetails!.textContent = trials[0]?.seed !== trials[1]?.seed ? 'Different seeds selected. Shared axes aid inspection; trajectories are different trials, not paired evidence.' : `Paired seed ${trials[0]?.seed}. Cursor selects the most recent recorded world sample at or before this simulation time.`;
    trials.forEach((trial, index) => {
      const card = chartCards[index]!; card.replaceChildren();
      const heading = node('header', 'comparison-chart-heading'); const label = node('div'); label.append(node('span', `comparison-side side-${index}`, index === 0 ? 'A' : 'B'), node('strong', '', trial.label)); heading.append(label, node('span', `comparison-badge ${trial.evidence === 'live-jev' ? 'live' : ''}`, evidenceLabel(trial))); card.append(heading);
      const current = [...trial.series].reverse().find(sample => sample.simMs <= cursorMs); const ended = cursorMs > (trial.series.at(-1)?.simMs ?? 0);
      const trajectory = svg('svg', { viewBox: '0 0 440 260', role: 'img', 'aria-label': `${trial.label} trajectory in world ENU X/Y metres` }); trajectory.append(svg('title', {}, `${trial.label}: target path and robot path on shared X/Y axes`));
      const toX = (value: number) => 222 + (value - centerX) / extent * 198; const toY = (value: number) => 124 - (value - centerY) / extent * 198;
      for (let grid = 0; grid <= 4; grid++) { const value = grid / 4 - .5, x = 222 + value * 198, y = 124 + value * 198; trajectory.append(svg('line', { x1: 123, y1: y, x2: 321, y2: y, stroke: '#2a3b49' }), svg('line', { x1: x, y1: 25, x2: x, y2: 223, stroke: '#2a3b49' }), svg('text', { x, y: 238, 'text-anchor': 'middle', class: 'comparison-axis' }, number(centerX + value * extent, 1)), svg('text', { x: 115, y: y + 3, 'text-anchor': 'end', class: 'comparison-axis' }, number(centerY - value * extent, 1))); }
      trajectory.append(svg('text', { x: 222, y: 254, 'text-anchor': 'middle', class: 'comparison-axis' }, 'X east · m'), svg('text', { x: 23, y: 124, transform: 'rotate(-90 23 124)', 'text-anchor': 'middle', class: 'comparison-axis' }, 'Y north · m'));
      const path = (samples: typeof trial.series, kind: 'robot' | 'target') => samples.map((sample, offset) => `${offset ? 'L' : 'M'}${toX(sample[kind].x).toFixed(2)},${toY(sample[kind].y).toFixed(2)}`).join(' ');
      trajectory.append(svg('path', { d: path(trial.series, 'target'), fill: 'none', stroke: '#a7b6c4', 'stroke-width': 1.2, 'stroke-dasharray': '5 4' }), svg('path', { d: path(trial.series, 'robot'), fill: 'none', stroke: COLORS[index]!, 'stroke-width': 1.5, opacity: .23 }), svg('path', { d: path(trial.series.filter(sample => sample.simMs <= cursorMs), 'robot'), fill: 'none', stroke: COLORS[index]!, 'stroke-width': 2 }));
      if (current) trajectory.append(svg('line', { x1: toX(current.robot.x), y1: toY(current.robot.y), x2: toX(current.target.x), y2: toY(current.target.y), stroke: '#667e91', 'stroke-dasharray': '3 3' }), svg('circle', { cx: toX(current.target.x), cy: toY(current.target.y), r: 4, fill: '#111b25', stroke: '#cad5df', 'stroke-width': 1.4 }), svg('circle', { cx: toX(current.robot.x), cy: toY(current.robot.y), r: 4, fill: COLORS[index]! }));
      card.append(trajectory); const legend = node('div', 'comparison-chart-legend'); legend.append(node('span', `side-${index}`, '━ robot'), node('span', '', '┄ target'), node('span', '', `seed ${trial.seed}`)); card.append(legend);
      const error = svg('svg', { viewBox: '0 0 440 144', role: 'img', 'aria-label': `${trial.label} tracking error over simulation time` }); error.append(svg('title', {}, 'Tracking error in metres over simulation time in seconds'));
      const timeX = (value: number) => 48 + value / Math.max(durationMs, 1) * 368; const errorY = (value: number) => 105 - value / errorMax * 78;
      for (let grid = 0; grid <= 4; grid++) { const x = 48 + grid / 4 * 368; error.append(svg('line', { x1: x, y1: 27, x2: x, y2: 105, stroke: '#263845' }), svg('text', { x, y: 122, 'text-anchor': 'middle', class: 'comparison-axis' }, number(durationMs * grid / 4000, 1))); }
      error.append(svg('line', { x1: 48, y1: 105, x2: 416, y2: 105, stroke: '#526a7b' }), svg('text', { x: 40, y: 108, 'text-anchor': 'end', class: 'comparison-axis' }, '0'), svg('text', { x: 40, y: 30, 'text-anchor': 'end', class: 'comparison-axis' }, number(errorMax, 1)), svg('text', { x: 48, y: 15, class: 'comparison-axis' }, 'Tracking error · m'), svg('text', { x: 416, y: 139, 'text-anchor': 'end', class: 'comparison-axis' }, 'Simulation time · s'));
      for (const event of trial.events) { const mark = svg('line', { x1: timeX(event.simMs), y1: 27, x2: timeX(event.simMs), y2: 105, stroke: '#ba8896', opacity: .55, 'stroke-dasharray': '2 4' }); mark.append(svg('title', {}, `${event.kind} @ ${number(event.simMs / 1000, 2)}s · reaction ${event.reactionMs === null ? 'not observed' : number(event.reactionMs, 0, ' ms')}`)); error.append(mark); }
      error.append(svg('path', { d: trial.series.map((sample, offset) => `${offset ? 'L' : 'M'}${timeX(sample.simMs).toFixed(2)},${errorY(sample.errorM).toFixed(2)}`).join(' '), fill: 'none', stroke: COLORS[index]!, 'stroke-width': 1.8 }), svg('line', { x1: timeX(cursorMs), y1: 23, x2: timeX(cursorMs), y2: 108, stroke: '#dfebf4', opacity: .8 })); card.append(error);
      const readout = node('div', 'comparison-sample'); if (current) { readout.append(node('span', '', `t ${number(current.simMs / 1000, 2)}s${ended ? ' · trial ended' : ''}`), node('strong', '', `error ${number(current.errorM, 3)} m`), node('span', '', `XYZ ${number(current.robot.x, 2)}, ${number(current.robot.y, 2)}, ${number(current.robot.z, 2)} m`), node('span', '', `${number(current.speedMps, 2)} m/s · ${current.held ? 'holding' : 'moving'}`)); } else readout.append(node('span', '', 'No sample at or before the selected time.')); card.append(readout);
    });
  }
  function renderTracePanel() {
    const section = node('section', 'comparison-section'); const heading = node('div', 'comparison-section-heading'); heading.append(node('h3', '', 'Decision & event evidence'), node('p', '', 'Inspect recorded events and their explicit IDs. Correlation links identify shared provenance; they do not by themselves prove a physical reaction.')); section.append(heading);
    const controls = node('div', 'comparison-trace-controls'); traceSelector = node('select'); traceSelector.setAttribute('aria-label', 'Trace trial'); traceSelector.onchange = () => { traceSide = traceSelector!.value; selectedTrace = undefined; traceLoadError = ''; renderTrace(); };
    decisionFilter = node('input'); decisionFilter.type = 'search'; decisionFilter.placeholder = 'Exact decision ID'; decisionFilter.setAttribute('aria-label', 'Filter exact decision ID'); decisionFilter.oninput = () => { selectedTrace = undefined; renderTrace(); };
    eventFilter = node('input'); eventFilter.type = 'search'; eventFilter.placeholder = 'Filter event or payload…'; eventFilter.setAttribute('aria-label', 'Filter trace events'); eventFilter.oninput = () => { selectedTrace = undefined; renderTrace(); };
    controls.append(traceSelector, decisionFilter, eventFilter, button('Clear filters', () => { decisionFilter!.value = ''; eventFilter!.value = ''; selectedTrace = undefined; renderTrace(); }, 'quiet')); section.append(controls);
    const traceActions = node('div', 'comparison-trace-actions'); traceLoadButton = button('Load full trace', () => void fetchTrace()); traceExportButton = button('↓ Export shown trace', () => { const trial = traceTrial(); if (trial) { const full = fullTraces.get(trial.id); downloadValue(full ?? trial.trace, `${trial.id}-${full || !trial.traceArtifact ? 'trace' : 'trace-preview'}.json`); } }, 'quiet'); traceActions.append(traceLoadButton, traceExportButton, node('span', 'comparison-footnote', 'Summary exports contain preview events. Full raw traces load and export separately, one trial at a time.')); section.append(traceActions);
    traceCoverage = node('div', 'comparison-coverage'); section.append(traceCoverage); traceCount = node('div', 'comparison-footnote'); section.append(traceCount);
    const split = node('div', 'comparison-trace-split'); traceList = node('div', 'comparison-trace-list'); traceDetail = node('div', 'comparison-trace-detail'); split.append(traceList, traceDetail); section.append(split); return section;
  }
  function renderTrace() {
    const trial = traceTrial(); if (!trial || !traceList || !traceDetail || !traceCoverage || !traceCount) return;
    const coverage = trial.traceCoverage; const full = fullTraces.get(trial.id); const available = full ?? trial.trace;
    traceCoverage.textContent = `${full || !trial.traceArtifact ? 'Loaded trace' : 'Preview'} ${available.length.toLocaleString()} events · persisted ${coverage.retained.toLocaleString()} / ${coverage.total.toLocaleString()} · dropped ${coverage.dropped.toLocaleString()} · truncated ${coverage.truncated.toLocaleString()}${traceLoadError ? ` · ${traceLoadError}` : ''}`; traceCoverage.classList.toggle('comparison-warning', coverage.dropped > 0 || coverage.truncated > 0 || Boolean(traceLoadError));
    if (traceLoadButton) { traceLoadButton.hidden = !trial.traceArtifact; traceLoadButton.disabled = Boolean(full) || loadingTraces.has(trial.id); traceLoadButton.textContent = full ? 'Full trace loaded' : loadingTraces.has(trial.id) ? 'Loading full trace…' : 'Load full trace'; }
    if (traceExportButton) traceExportButton.textContent = full || !trial.traceArtifact ? '↓ Export full trace' : '↓ Export preview';
    const decision = decisionFilter?.value.trim() ?? '', query = eventFilter?.value.trim().toLowerCase() ?? '';
    const filtered = available.filter(entry => (!decision || decisionIds(entry).includes(decision)) && (!query || JSON.stringify(entry).toLowerCase().includes(query)));
    traceCount.textContent = `${Math.min(filtered.length, 150).toLocaleString()} of ${filtered.length.toLocaleString()} matching loaded records shown, latest first. Trace export includes all loaded records. Wall timestamps and simulation time remain separate.`;
    traceList.replaceChildren();
    for (const entry of filtered.slice(-150).reverse()) {
      const row = button('', () => { selectedTrace = entry; renderTraceDetail(entry); renderTrace(); }, `comparison-trace-row${entry.id === selectedTrace?.id ? ' selected' : ''}`);
      const data = entry.data as Record<string, unknown> | null; const summary = typeof data === 'string' ? data : data && (typeof data.summary === 'string' || typeof data.reason === 'string') ? String(data.summary ?? data.reason) : JSON.stringify(data);
      row.append(node('span', 'comparison-trace-time', `${number(entry.simMs / 1000, 3)}s`), node('span', 'comparison-trace-kind', entry.kind), node('span', 'comparison-trace-summary', `${decisionIds(entry).join(', ')}${decisionIds(entry).length ? ' · ' : ''}${summary ?? ''}`)); traceList.append(row);
    }
    if (!filtered.length) traceList.append(node('p', 'empty', 'No retained events match these filters.'));
    if (!selectedTrace || !filtered.some(entry => entry.id === selectedTrace!.id)) selectedTrace = filtered.at(-1);
    if (selectedTrace) renderTraceDetail(selectedTrace); else traceDetail.replaceChildren(node('p', 'empty', 'Choose an event to inspect its raw payload and correlation IDs.'));
  }
  async function fetchTrace() {
    const trial = traceTrial(); const reportId = report?.id; if (!trial?.traceArtifact || loadingTraces.has(trial.id)) return;
    loadingTraces.add(trial.id); traceLoadError = ''; renderTrace();
    try {
      const entries = await loadTrace(trial.id); if (report?.id !== reportId) return;
      if (!Array.isArray(entries)) throw new Error('The trace response is not an event array.');
      fullTraces.set(trial.id, entries);
      while (fullTraces.size > 2) { const oldest = fullTraces.keys().next().value; if (oldest) fullTraces.delete(oldest); else break; }
    } catch (error) { if (report?.id === reportId) traceLoadError = error instanceof Error ? error.message : String(error); }
    finally { loadingTraces.delete(trial.id); if (report?.id === reportId) renderTrace(); }
  }
  function renderTraceDetail(entry: Diagnostic) {
    if (!traceDetail) return; traceDetail.replaceChildren();
    const title = node('h4', '', `${entry.channel} / ${entry.kind}`); const times = node('div', 'comparison-event-times'); times.append(node('span', '', `Simulation ${number(entry.simMs, 1)} ms`), node('span', '', `Wall ${Number.isFinite(entry.wallMs) ? new Date(entry.wallMs).toISOString() : 'unknown'}`)); traceDetail.append(title, times);
    const links = correlations(entry.data); const group = node('div', 'comparison-correlations');
    for (const link of links) { if (/decision.?id$/i.test(link.key)) { const item = button(`${link.key}: ${link.value}`, () => { decisionFilter!.value = link.value; renderTrace(); }, 'comparison-correlation'); item.title = 'Filter this trial by exact decision ID'; group.append(item); } else group.append(node('span', 'comparison-correlation', `${link.key}: ${link.value}`)); }
    if (!links.length) group.append(node('span', 'comparison-footnote', 'No explicit correlation IDs recorded on this event.'));
    traceDetail.append(group); if (entry.truncated) traceDetail.append(node('p', 'comparison-warning', 'This event payload was truncated by the recorder.'));
    traceDetail.append(node('pre', 'json', pretty(entry)));
  }
  function provenance() {
    const section = node('section', 'comparison-section comparison-provenance'); const heading = node('h3', '', 'Provenance & limits'); section.append(heading);
    if (report!.limitations.length) { const list = node('ul'); for (const limitation of report!.limitations) list.append(node('li', '', limitation)); section.append(list); }
    const details = node('details'); details.append(node('summary', '', 'Inspect report configuration, versions and trial hashes'), node('pre', 'json', pretty({ schemaVersion: report!.schemaVersion, kind: report!.kind, id: report!.id, createdAt: report!.createdAt, evidence: report!.evidence, configuration: report!.configuration, versions: report!.versions, trials: report!.trials.map(trial => ({ id: trial.id, arm: trial.arm, seed: trial.seed, evidence: trial.evidence, configuration: trial.configuration, finalStateHash: trial.finalStateHash, traceCoverage: trial.traceCoverage, traceArtifact: trial.traceArtifact })) }))); section.append(details); return section;
  }
}

function download(report: ComparisonReport) {
  downloadValue(report, `controller-comparison-${report.id}.json`);
}
function downloadValue(value: unknown, filename: string) { const link = document.createElement('a'); const url = URL.createObjectURL(new Blob([pretty(value)], { type: 'application/json' })); link.href = url; link.download = filename.replace(/[^a-zA-Z0-9_.-]/g, '_'); link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }

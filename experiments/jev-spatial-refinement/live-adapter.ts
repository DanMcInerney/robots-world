import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';
import { YAW_ACTIONS, wrapYaw, validateBenchResponse, type BenchRequest, type BenchResponse } from '../jev-spatial-text/bench.ts';
import { digest, durable } from '../jev-spatial-text/transport.ts';
import { GEOMETRY_HEADS, GEOMETRY_REPRESENTATIONS } from './geometry.ts';

export type LiveSelection = { arm: string; representation: typeof GEOMETRY_REPRESENTATIONS[number]; heads: typeof GEOMETRY_HEADS[number] };
export type LiveCondition = 'receipt-baseline' | 'selected-representation';
export function parseLiveSelection(arm: string): LiveSelection {
  const [representation, heads, extra] = arm.split('__');
  assert(!extra && GEOMETRY_REPRESENTATIONS.includes(representation as LiveSelection['representation']) && GEOMETRY_HEADS.includes(heads as LiveSelection['heads']), 'Unsupported selected geometry arm');
  return { arm, representation: representation as LiveSelection['representation'], heads: heads as LiveSelection['heads'] };
}
const rad = Math.PI / 180, rounded = (n: number) => Math.round(n * 1e6) / 1e6;
const record = (v: unknown): Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
const side = (v: number) => v < 0 ? 'left' : v > 0 ? 'right' : 'midline';
const relation = (v: number, limit: number) => v < -limit ? 'left of goal band' : v > limit ? 'right of goal band' : 'inside goal band';
export const LIVE_HYPOTHESIS = 'For each offered action independently, assume the currently measured blue pixel rectangle is a stationary set of rays in the world, translation is zero, and the rigid zero-pitch camera rotates with body yaw. Assume that action applies and reaches its final heading exactly before observation, with no expiry, supersession, target motion, new occlusion, changed shape, association failure or detection failure. This is a conditional stationary/full-settling calculation, NOT a forecast of what the moving bench will actually do. It supplies no range, hidden geometry, route or future measurement. Pixel bounding rectangles are measured envelopes, not exact object surfaces; rasterization and simulated attitude uncertainty remain.';
export const LIVE_TRANSFER = 'Measured-state transfer of a development-selected geometry representation to the original yaw-framing task. The action question still asks for framing/maintenance/reacquisition, not the synthetic minimum-bearing objective. Pinhole reprojection of a measured pixel rectangle replaces stipulated angular extents; unknown inputs remain unknown. Optional forecast heads ask independent hypothetical full-settling geometry, not the engine200ms realized forecast. Their answers never select, filter, rank or replace the yaw answer. This is not verbatim synthetic-prompt replication; no prompt tuning after live outcomes.';
export type ConditionalGeometry = { action: keyof typeof YAW_ACTIONS; final_absolute_heading_left_deg: number; actual_yaw_left_deg: number; after_image_right_bearing_deg: number | null; projected_pixel_rectangle: number[] | null; entire_target_rectangle_inside_view: boolean; physical_view_category: string; target_center_relation_to_goal_band: string };

/** Its only inputs are the current acquired camera measurement and declared actuator setpoint. */
export function measuredGeometry(request: BenchRequest) {
  const state = request.state, s = record(state.snapshot), camera = record(state.camera), controls = record(state.controls), k = record(camera.calibration);
  const source = { acquisitionId: typeof s.id === 'string' ? s.id : null, acquiredMs: Number.isFinite(s.acquiredMs) ? s.acquiredMs : null,
    inputs: ['snapshot.objects:unique unclipped blue bounding rectangle', 'camera.calibration', 'camera.widthPx/heightPx/fixedPitchDeg', 'snapshot.headingDeg', 'controls.acquiredHeadingDeg', 'controls.lastAcceptedHeadingDeg'],
    attitude: 'Declared simulated acquired attitude plus an accepted command setpoint; the accepted setpoint is not measured motion.', measurementUncertainty: 'Point calculations from finite-resolution pixels and simulated attitude. No calibrated future-outcome confidence or metric range.' };
  const unknown = (reason: string) => ({ available: false as const, reason, source, current: null, consequences: [] as ConditionalGeometry[] });
  if (!Array.isArray(s.objects) || s.overflow !== 0) return unknown('No valid bounded region observation');
  const objects = s.objects.map(record).filter(o => o.color === 'blue');
  if (objects.length !== 1) return unknown(objects.length ? 'Ambiguous blue association' : 'Blue region absent');
  const o = objects[0]!, box = o.box;
  if (o.clipped !== false) return unknown('Blue rectangle clipped or clipping validity absent');
  if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite)) return unknown('Invalid measured pixel rectangle');
  const { fx, fy, cx, cy } = k, width = camera.widthPx, height = camera.heightPx, acquired = controls.acquiredHeadingDeg, accepted = controls.lastAcceptedHeadingDeg;
  if (![fx, fy, cx, cy, width, height, acquired, accepted, s.headingDeg].every(Number.isFinite) || fx <= 0 || fy <= 0 || cx <= 0 || cy <= 0 || width <= 0 || height <= 0 || acquired !== s.headingDeg || camera.fixedPitchDeg !== 0) return unknown('Unqualified camera calibration, attitude or fixed-pitch profile');
  const [x0, y0, x1, y1] = box as [number, number, number, number];
  if (!(0 < x0 && x0 < x1 && x1 < width && 0 < y0 && y0 < y1 && y1 < height)) return unknown('Pixel rectangle reaches image boundary or is invalid');
  const centerRight = Math.atan(((x0 + x1) / 2 - cx) / fx) / rad, band = Math.atan(.3 * cx / fx) / rad;
  const current = { acquisitionId: source.acquisitionId, regionId: String(o.id), acquired_heading_left_deg: acquired, previously_accepted_absolute_heading_left_deg: accepted,
    measured_pixel_rectangle: [x0, y0, x1, y1], calibration: { fx, fy, cx, cy }, image_size_px: [width, height],
    center_image_right_deg: rounded(centerRight), horizontal_angular_edges_deg: [rounded(Math.atan((x0 - cx) / fx) / rad), rounded(Math.atan((x1 - cx) / fx) / rad)],
    goal_band_right_deg: [-rounded(band), rounded(band)] };
  const consequences = Object.entries(YAW_ACTIONS).map(([name, amount]) => {
    const action = name as keyof typeof YAW_ACTIONS, finalHeading = wrapYaw(action === 'retain' ? accepted : acquired + amount), delta = wrapYaw(finalHeading - acquired), c = Math.cos(delta * rad), sin = Math.sin(delta * rad);
    const corners = [[x0, y0], [x0, y1], [x1, y0], [x1, y1]].map(([x, y]) => {
      const right = (x! - cx) / fx, up = (cy - y!) / fy, forward = c - right * sin;
      return forward <= 0 ? null : [cx + fx * (right * c + sin) / forward, cy - fy * up / forward];
    });
    const projected = corners.some(v => v === null) ? null : [Math.min(...corners.map(v => v![0]!)), Math.min(...corners.map(v => v![1]!)), Math.max(...corners.map(v => v![0]!)), Math.max(...corners.map(v => v![1]!))];
    const fullyVisible = projected !== null && projected[0]! >= 0 && projected[1]! >= 0 && projected[2]! <= width && projected[3]! <= height;
    const after = projected ? Math.atan(((projected[0]! + projected[2]!) / 2 - cx) / fx) / rad : null;
    return { action, final_absolute_heading_left_deg: rounded(finalHeading), actual_yaw_left_deg: rounded(delta), after_image_right_bearing_deg: after === null ? null : rounded(after), projected_pixel_rectangle: projected?.map(rounded) ?? null,
      entire_target_rectangle_inside_view: fullyVisible, physical_view_category: !fullyVisible ? 'not_fully_visible' : after! < -5 ? 'left' : after! > 5 ? 'right' : 'center', target_center_relation_to_goal_band: after === null ? 'unknown' : relation(after, band) };
  });
  return { available: true as const, reason: 'Derived only from this acquired pixel rectangle and declared control state', source, current, consequences };
}

export function adaptLiveRequest(engine: BenchRequest, condition: LiveCondition, selection: LiveSelection): BenchRequest {
  assert.deepEqual(parseLiveSelection(selection.arm), selection); assert.deepEqual(Object.keys(engine.questions), ['yaw'], 'Live engine must use receipt baseline, without other history/head treatments');
  assert.deepEqual(Object.keys(engine.questions.yaw!.criteria), Object.keys(YAW_ACTIONS));
  const wire = structuredClone(engine); if (condition === 'receipt-baseline') return wire;
  assert.equal(condition, 'selected-representation');
  const measured = measuredGeometry(engine);
  const geometry: Record<string, unknown> = { selectedRepresentation: selection.representation, transferNotice: LIVE_TRANSFER, physicalHypothesis: LIVE_HYPOTHESIS, ...measured, consequences: undefined };
  delete geometry.consequences;
  if (!measured.available) geometry.conditionalData = Object.keys(YAW_ACTIONS).map(action => ({ action, status: 'unknown', reason: measured.reason }));
  else if (selection.representation === 'current-relations') geometry.declaredComputation = { source: 'Present-state arithmetic only; no action consequence or ranking.', target_side_of_current_midline: side(measured.current!.center_image_right_deg),
    target_center_relation_to_goal_band: relation(measured.current!.center_image_right_deg, measured.current!.goal_band_right_deg[1]!), accepted_setpoint_remaining_yaw_left_deg: rounded(wrapYaw(measured.current!.previously_accepted_absolute_heading_left_deg - measured.current!.acquired_heading_left_deg)),
    accepted_setpoint_relative_to_acquired_heading: side(-wrapYaw(measured.current!.previously_accepted_absolute_heading_left_deg - measured.current!.acquired_heading_left_deg)) };
  else if (selection.representation === 'after-bearing' || selection.representation === 'after-relations') geometry.declaredComputation = { source: 'Code-computed conditional consequences for EVERY offered action; no ranking or recommended action.', conditional_consequences: measured.consequences.map(c => ({ action: c.action,
    final_absolute_heading_left_deg: c.final_absolute_heading_left_deg, actual_yaw_left_deg: c.actual_yaw_left_deg, after_image_right_bearing_deg: c.after_image_right_bearing_deg,
    ...(selection.representation === 'after-relations' ? { physical_view_category: c.physical_view_category, target_center_relation_to_goal_band: c.target_center_relation_to_goal_band, entire_target_rectangle_inside_view: c.entire_target_rectangle_inside_view } : {}) })) };
  wire.state.liveGeometry = geometry;
  if (selection.heads === 'action-and-forecasts') for (const [action, description] of Object.entries(engine.questions.yaw!.criteria)) wire.questions[`geometry_forecast_${action}`] = { type: 'choice',
    instructions: `Independent CONDITIONAL geometry forecast specifically for action ${action}: ${description} Assume this named action applies and fully settles under the stationary/full-settling hypothesis in state.liveGeometry. Classify the reprojected acquired blue rectangle immediately afterward. No sibling answer is available. This is not a prediction at the engine200ms outcome horizon. If the current source geometry is unknown, abstain rather than asserting an unseen object location.`,
    criteria: { left: 'The entire measured target rectangle is inside the image and its center is more than5 degrees left.', center: 'The entire measured target rectangle is inside the image and its center is within[-5,+5] degrees inclusive.', right: 'The entire measured target rectangle is inside the image and its center is more than5 degrees right.', not_fully_visible: 'Part or all of the reprojected measured rectangle is outside the view under the stated hypothesis.', unknown: 'Abstain: no unique unclipped valid source rectangle/calibration/attitude supports this conditional calculation. This is epistemic unknown, not an extra physical outcome.' } };
  assert.deepEqual(wire.questions.yaw, engine.questions.yaw); assert.deepEqual(wire.state.goal, engine.state.goal); assert.deepEqual(wire.state.componentObjective, engine.state.componentObjective); return wire;
}
export function mapLiveResponse(engine: BenchRequest, wire: BenchRequest, response: BenchResponse): BenchResponse {
  validateBenchResponse(wire, response);
  const mapped: BenchResponse = { model: response.model, answers: { yaw: structuredClone(response.answers.yaw!) }, ...(response.usage === undefined ? {} : { usage: structuredClone(response.usage) }) };
  validateBenchResponse(engine, mapped); return mapped;
}

export function createLiveJudge(options: { condition: LiveCondition; selection: LiveSelection; directory: string; send(request: BenchRequest, id: string): Promise<BenchResponse> }) {
  const pending = new Set<Promise<BenchResponse>>(), ids: string[] = [], errors: string[] = [];
  const judge = (engine: BenchRequest, id: string): Promise<BenchResponse> => {
    assert(!ids.includes(id) && ids.length < 256); ids.push(id);
    const wire = adaptLiveRequest(engine, options.condition, options.selection);
    durable(resolve(options.directory, `${id}.wire-request.json`), wire, true);
    const promise = Promise.resolve().then(() => options.send(wire, id)).then(response => {
      durable(resolve(options.directory, `${id}.wire-response.json`), response, true);
      const mapped = mapLiveResponse(engine, wire, response);
      durable(resolve(options.directory, `${id}.adapter-mapping.json`), { id, condition: options.condition, selectedArm: options.selection.arm, engineRequestSha256: digest(JSON.stringify(engine)), wireRequestSha256: digest(JSON.stringify(wire)), wireResponseSha256: digest(JSON.stringify(response)), engineResponseSha256: digest(JSON.stringify(mapped)), mapping: 'answers.yaw copied verbatim; optional hypothetical geometry heads retained in raw wire response and ignored by engine', sameActionChoice: mapped.answers.yaw!.choice }, true);
      return mapped;
    }, error => { throw error; }).catch(error => { durable(resolve(options.directory, `${id}.adapter-error.json`), { id, error: String(error) }, true); throw error; });
    pending.add(promise); void promise.then(() => pending.delete(promise), error => { errors.push(`${id}: ${String(error)}`); pending.delete(promise); }); return promise;
  };
  return { judge, async drain() {
    await Promise.allSettled([...pending]); await immediate(); // F54: engine's nested late sink must finish before inventory.
    const sinks: { id: string; path: string; sha256: string }[] = [];
    for (const id of ids) {
      const candidates = [`${id}.response.json`, `${id}.late.json`].filter(path => existsSync(resolve(options.directory, path)));
      if (candidates.length !== 1) { errors.push(`${id}: expected exactly one settled engine response/late sink, got${candidates.length}`); continue; }
      const path = candidates[0]!, bytes = await readFile(resolve(options.directory, path)); sinks.push({ id, path, sha256: digest(bytes) });
    }
    return { requestIds: [...ids], errors: [...errors], sinks };
  } };
}

import type { Json } from '../src/contracts.ts';

/**
 * Pure, typed mapping from the streaming stereo-object sensor's NDJSON records (schema
 * `stereo-objects/2`, see `experiments/jev-library/sensor/`) to nervelet `processSource`
 * publishes, plus a helper that builds the `processSource` options themselves.
 *
 * This repo has no nervelet dependency (see package.json): everything below is type-only against
 * nervelet's `Source`/`processSource` contract, mirrored locally rather than imported at module
 * load — the same pattern `integrations/nervelet.ts` and `test/nervelet-world.test.ts` use,
 * loading a real nervelet build only behind `ROBOTS_NERVELET_MODULE` at test/run time.
 *
 * v2 changelog (repair pass; see docs/jev-live-sensor-results.md "Failures and repairs"):
 *  - `acquired.ms` is now unix epoch milliseconds (clock `"unix-epoch-ms"`), so this mapper can
 *    compute an age directly (`Date.now() - acquired.ms`) with no hello lookup — v1's
 *    `"sensor-wall"` label mislabelled a `time.monotonic()`-since-start value that was, on the
 *    sensor's Windows host, quantized to 15.625 ms.
 *  - A record whose acquisition is older than `maxAcquisitionAgeMs` at receipt is now published
 *    `valid:false` with `reason:"stale_record"` (unless the sensor already reported a more
 *    specific reason) — ObservationStore's own staleness check only looks at receipt time, so a
 *    delayed-but-fresh-looking record could previously reach a controller as valid.
 *  - `object_appeared` is now keyed on spatial identity alone (a coarse bearing bucket), not
 *    class + bucket: real data showed the reused, unmodified detector frequently relabelling one
 *    physical object car/truck/bus frame to frame, which under the old class-keyed scheme read as
 *    a flood of distinct "appearances". A minimum re-fire interval and a score hysteresis band
 *    bound the event rate further; a currently-present key is never evicted.
 *
 * Two outputs, matching the assignment:
 *  - `objects`: one replaceable sample — the sensor's already-capped object list for its latest
 *    processed frame, plus bookkeeping (`seq`, `skippedSinceLast`, `objectsTotal`,
 *    `ageAtReceiptMs`). `acquired` is always the record's own acquisition clock (never the
 *    consumer's receipt time).
 *  - `object_appeared`: a small, de-duplicated reliable event stream — one event per spatial slot
 *    transitioning from "absent for at least a declared interval" to present, rate-limited and
 *    score-hysteresis-gated, never one event per frame. This is the direct fix for
 *    design-failures.md F28 (a 0.4s glimpse that disappeared before inference could ever see it):
 *    even a consumer polling slower than the frame rate cannot miss a brief appearance once this
 *    event has fired, because nervelet's event FIFO is reliable/unread, unlike the coalescing
 *    `objects` sample.
 */

// ---- Local mirror of nervelet's Source/processSource contract (type-only; see module docstring) ----

export interface SourceOutput { name: string; kind: 'sample' | 'event'; maxAgeMs?: number }
export interface SourceSample { value: Json; acquired?: { clock: string; ms: number }; valid: boolean; reason?: string }
export interface ProcessRecordMapped { samples?: Record<string, SourceSample>; events?: { kind: string; data: Json }[] }
export interface ProcessSourceLikeOptions {
  id: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  outputs: SourceOutput[];
  map(record: Json): ProcessRecordMapped | null | undefined;
  maxLineBytes?: number;
  maxStderrBytes?: number;
}

// ---- Sensor record shapes (schema stereo-objects/2) ----

export const STEREO_OBJECTS_SCHEMA = 'stereo-objects/2';

export interface AltClass { class: string; score: number }

export interface StereoObject {
  class: string;
  score: number;
  bearingRightRad: number;
  bearingUpRad: number;
  surfaceRangeM: number | null;
  rangeValid: boolean;
  rangeReason?: string;
  rangeSource: string;
  maskPixels: number;
  boxNorm: [number, number, number, number];
  dominantColor?: string;
  /** Other classes the reused detector also assigned to the same physical object (its mask
   * overlapped this one's above the sensor's declared merge threshold), highest score first. */
  altClasses?: AltClass[];
}

export interface StereoObjectsFrameRecord {
  schema: string;
  seq: number;
  acquired: { clock: string; ms: number };
  emittedMs: number;
  skippedSinceLast: number;
  objects: StereoObject[];
  objectsTotal: number;
  objectsTruncated?: boolean;
  timingMs?: Record<string, number>;
  valid?: boolean;
  reason?: string;
}

// ---- objects sample value ----

export interface ObjectsSampleValue extends Record<string, Json> {
  seq: number;
  skippedSinceLast: number;
  objectsTotal: number;
  objects: StereoObject[] & Json;
  /** Milliseconds between this record's acquisition and this mapper call receiving it — computed
   * from `acquired.ms` (unix epoch ms) and `Date.now()`, so it is recomputable from raw evidence
   * alone (the record plus the receiving process' own clock), no saved anchors required. */
  ageAtReceiptMs: number;
}

export const DEFAULT_MAX_OBJECTS_IN_SAMPLE = 8;
/** A record whose acquisition is older than this at receipt is published invalid
 * (`reason:"stale_record"`), regardless of what ObservationStore's own receipt-time staleness
 * check would otherwise conclude. Default 5000ms — generous relative to every age actually
 * measured in this sensor's live runs (worst case ~600ms at 5 Hz on a quiet machine; see
 * docs/jev-live-sensor-results.md), while still catching a genuinely stuck/delayed record. */
export const DEFAULT_MAX_ACQUISITION_AGE_MS = 5000;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isAltClass(value: unknown): value is AltClass {
  if (typeof value !== 'object' || value === null) return false;
  const o = value as Record<string, unknown>;
  return typeof o.class === 'string' && isFiniteNumber(o.score);
}

function isStereoObject(value: unknown): value is StereoObject {
  if (typeof value !== 'object' || value === null) return false;
  const o = value as Record<string, unknown>;
  return typeof o.class === 'string' && isFiniteNumber(o.score) && isFiniteNumber(o.bearingRightRad)
    && isFiniteNumber(o.bearingUpRad) && (o.surfaceRangeM === null || isFiniteNumber(o.surfaceRangeM))
    && typeof o.rangeValid === 'boolean' && typeof o.rangeSource === 'string'
    && isFiniteNumber(o.maskPixels) && Array.isArray(o.boxNorm) && o.boxNorm.length === 4
    && (o.altClasses === undefined || (Array.isArray(o.altClasses) && o.altClasses.every(isAltClass)));
}

/** Structural validation only (not a full schema check): throwing here makes `processSource`
 * count the record as malformed instead of the mapper silently accepting garbage. */
function asFrameRecord(record: Json): StereoObjectsFrameRecord {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) throw new Error('stereo-objects record is not an object');
  const r = record as Record<string, unknown>;
  if (r.schema !== STEREO_OBJECTS_SCHEMA) throw new Error(`Unexpected schema "${String(r.schema)}"; expected "${STEREO_OBJECTS_SCHEMA}"`);
  if (!isFiniteNumber(r.seq)) throw new Error('stereo-objects record missing numeric seq');
  const acquired = r.acquired as { clock?: unknown; ms?: unknown } | undefined;
  if (!acquired || typeof acquired.clock !== 'string' || !isFiniteNumber(acquired.ms)) throw new Error('stereo-objects record missing acquired{clock,ms}');
  if (!Array.isArray(r.objects) || !r.objects.every(isStereoObject)) throw new Error('stereo-objects record has an invalid objects array');
  if (!isFiniteNumber(r.objectsTotal)) throw new Error('stereo-objects record missing numeric objectsTotal');
  if (!isFiniteNumber(r.skippedSinceLast)) throw new Error('stereo-objects record missing numeric skippedSinceLast');
  return record as unknown as StereoObjectsFrameRecord;
}

// ---- object_appeared de-duplication (bounded state) ----

interface AppearanceEntry { present: boolean; sinceMs: number; lastFiredMs?: number }

export interface AppearanceTrackerOptions {
  /** How long a spatial slot must have been absent before its next appearance counts as fresh and
   * is eligible to fire an event again, instead of being treated as continued/flickering
   * presence. Default 300ms — comfortably shorter than F28's dropped 0.4s glimpse, so a glimpse
   * of that length still produces exactly one event, not zero and not a flood. */
  appearAfterAbsenceMs?: number;
  /** Width, in radians, of the coarse bearing bucket used as the dedup key, so two simultaneous
   * objects at clearly different bearings are tracked separately. Default 30 degrees. Class is
   * deliberately NOT part of the key (v2): real data showed the same physical object frequently
   * relabelled car/truck/bus frame to frame by the reused, unmodified detector, which under a
   * class-keyed scheme read as a flood of distinct appearances for one object. */
  bearingBucketRad?: number;
  /** Upper bound on distinct tracked keys (bounded state; a currently-present key is NEVER
   * evicted — only absent entries are eviction candidates, oldest first). Default 64 — far more
   * than any realistic single-frame object population. */
  maxTrackedKeys?: number;
  /** Hard floor on how often the SAME spatial key may fire `object_appeared`, independent of the
   * absence-duration check above — directly bounds worst-case event rate per key even under
   * detector score flicker right at the sensor's own score threshold. Default 2000ms. */
  minReappearanceIntervalMs?: number;
  /** An object's score must be at least this high for its slot to count as a FRESH appearance
   * (the transition that fires an event); once a slot is marked present, any score the sensor
   * already reported (it already filtered below its own lower threshold) keeps the slot present
   * without needing to re-clear this bar. A hysteresis band around the sensor's own score
   * threshold, so score noise right at that boundary does not read as appear/disappear/appear.
   * Default 0.35 — comfortably above the sensor's typical 0.25 default `scoreThreshold`; raise or
   * lower it to match a different configured threshold. */
  presenceScoreThreshold?: number;
}

/** Bounded per-mapper-instance state for `object_appeared` de-duplication. Exported for direct
 * testing; `createStereoObjectsMapper` owns one instance per Source it builds. */
export class AppearanceTracker {
  private readonly state = new Map<string, AppearanceEntry>();
  private readonly appearAfterAbsenceMs: number;
  private readonly bearingBucketRad: number;
  private readonly maxTrackedKeys: number;
  private readonly minReappearanceIntervalMs: number;
  private readonly presenceScoreThreshold: number;

  constructor(options: AppearanceTrackerOptions = {}) {
    this.appearAfterAbsenceMs = options.appearAfterAbsenceMs ?? 300;
    this.bearingBucketRad = options.bearingBucketRad ?? Math.PI / 6;
    this.maxTrackedKeys = options.maxTrackedKeys ?? 64;
    this.minReappearanceIntervalMs = options.minReappearanceIntervalMs ?? 2000;
    this.presenceScoreThreshold = options.presenceScoreThreshold ?? 0.35;
  }

  bucketKey(bearingRightRad: number): { key: string; bucket: number } {
    const bucket = Math.round(bearingRightRad / this.bearingBucketRad);
    return { key: `bearing#${bucket}`, bucket };
  }

  /** Feeds one frame's present spatial slots (already de-duplicated to one entry per key by the
   * caller — see `mapStereoObjectsRecord`) and returns the `object_appeared` events for this
   * frame, using `nowMs` (the record's own acquisition clock) as the time base. */
  update(nowMs: number, present: ReadonlyArray<{ key: string; score: number; data: Json }>): { kind: string; data: Json }[] {
    const events: { kind: string; data: Json }[] = [];
    const presentKeys = new Set(present.map(p => p.key));
    for (const { key, score, data } of present) {
      const existing = this.state.get(key);
      const wasAbsentLongEnough = !existing || (!existing.present && nowMs - existing.sinceMs >= this.appearAfterAbsenceMs);
      const scoreQualifies = score >= this.presenceScoreThreshold;
      const notRateLimited = existing?.lastFiredMs === undefined || nowMs - existing.lastFiredMs >= this.minReappearanceIntervalMs;
      const fires = wasAbsentLongEnough && scoreQualifies && notRateLimited;
      if (fires) events.push({ kind: 'object_appeared', data });
      if (!existing || !existing.present) {
        this.state.set(key, { present: true, sinceMs: nowMs, lastFiredMs: fires ? nowMs : existing?.lastFiredMs });
      }
    }
    for (const [key, entry] of this.state) {
      if (entry.present && !presentKeys.has(key)) this.state.set(key, { ...entry, present: false, sinceMs: nowMs });
    }
    this.evictOverflow();
    return events;
  }

  private evictOverflow(): void {
    const overflow = this.state.size - this.maxTrackedKeys;
    if (overflow <= 0) return;
    // A currently-present key is never evicted — only absent entries are eviction candidates,
    // oldest transition first. If every tracked key is present, the map may temporarily exceed
    // maxTrackedKeys rather than drop state for something still visible.
    const evictable = [...this.state.entries()].filter(([, entry]) => !entry.present);
    const toEvict = evictable.sort((a, b) => a[1].sinceMs - b[1].sinceMs).slice(0, overflow);
    for (const [key] of toEvict) this.state.delete(key);
  }

  get size(): number { return this.state.size; }
}

// ---- mapper ----

export interface StereoObjectsMapperOptions extends AppearanceTrackerOptions {
  maxObjectsInSample?: number;
  maxAcquisitionAgeMs?: number;
}

/** Pure mapping for one already-parsed record, given an explicit tracker — the form direct unit
 * tests drive. `hello`/`bye` (and anything else carrying a `type`) are skipped (return null), not
 * malformed: they are valid, expected envelope records this mapper simply has nothing to publish
 * for. */
export function mapStereoObjectsRecord(record: Json, tracker: AppearanceTracker, options: StereoObjectsMapperOptions = {}): ProcessRecordMapped | null {
  if (typeof record === 'object' && record !== null && !Array.isArray(record) && 'type' in (record as Record<string, unknown>)) return null;
  const parsed = asFrameRecord(record);
  const maxObjects = options.maxObjectsInSample ?? DEFAULT_MAX_OBJECTS_IN_SAMPLE;
  const objects = parsed.objects.slice(0, maxObjects);

  const ageAtReceiptMs = Date.now() - parsed.acquired.ms;
  const maxAcquisitionAgeMs = options.maxAcquisitionAgeMs ?? DEFAULT_MAX_ACQUISITION_AGE_MS;
  const isStale = ageAtReceiptMs > maxAcquisitionAgeMs;
  const valid = parsed.valid !== false && !isStale;
  const reason = typeof parsed.reason === 'string' ? parsed.reason : (isStale ? 'stale_record' : undefined);

  const sampleValue: ObjectsSampleValue = {
    seq: parsed.seq, skippedSinceLast: parsed.skippedSinceLast, objectsTotal: parsed.objectsTotal,
    objects: objects as unknown as StereoObject[] & Json, ageAtReceiptMs,
  };

  const present: { key: string; score: number; data: Json }[] = [];
  const seenKeys = new Set<string>();
  for (const object of parsed.objects) { // score-sorted already; first per bearing bucket wins
    const { key, bucket } = tracker.bucketKey(object.bearingRightRad);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    present.push({
      key, score: object.score,
      data: {
        class: object.class, altClasses: (object.altClasses ?? []) as unknown as Json,
        bearingBucket: bucket, bearingRightRad: object.bearingRightRad, bearingUpRad: object.bearingUpRad,
        surfaceRangeM: object.surfaceRangeM, rangeValid: object.rangeValid,
        dominantColor: object.dominantColor ?? null, score: object.score,
        acquired: parsed.acquired as unknown as Json, seq: parsed.seq,
      },
    });
  }
  const events = tracker.update(parsed.acquired.ms, present);

  return {
    samples: { objects: { value: sampleValue, acquired: parsed.acquired, valid, ...(reason ? { reason } : {}) } },
    events,
  };
}

/** Builds a fresh, bounded `AppearanceTracker` and returns the bound `map` function
 * `processSource` expects. Each Source instance should get its own mapper (its own tracker) —
 * this is a factory, not a shared singleton. */
export function createStereoObjectsMapper(options: StereoObjectsMapperOptions = {}): (record: Json) => ProcessRecordMapped | null {
  const tracker = new AppearanceTracker(options);
  return record => mapStereoObjectsRecord(record, tracker, options);
}

// ---- processSource options builder ----

export interface StereoObjectsSourceConfig {
  /** Source id; also the sample/event name prefix nervelet reserves (`<id>.diagnostics`,
   * `<id>.lifecycle`) for the underlying processSource. Default `stereoObjects`. */
  id?: string;
  /** Absolute path to the Python interpreter to run the sensor under (e.g. the pinned detector
   * venv's `python.exe` — ultralytics/torch live there; see `experiments/jev-library/README.md`). */
  pythonExecutable: string;
  /** Absolute path to `experiments/jev-library` (the sensor's `cwd`, so `-m sensor.main`
   * resolves the package and its sibling `geometry.py`/`detector.py`/`stereo_cached.py`). */
  sensorCwd: string;
  manifestPath: string;
  rateHz: number;
  checkpointPath: string;
  detectorRuntimeRoot: string;
  stereo?: 'sgbm' | 'ffs';
  ffsRuntimeRoot?: string;
  scoreThreshold?: number;
  maxObjects?: number;
  maxLineBytes?: number;
  sampleIdsFile?: string;
  device?: string;
  half?: boolean;
  env?: Record<string, string>;
  /** maxAgeMs for the `objects` sample output. Default: generous relative to rateHz (at least
   * 2s, or 3 missed frame periods, whichever is larger) so ordinary latest-wins skipping under a
   * fast replay never itself looks like a stalled sensor. */
  objectsMaxAgeMs?: number;
  mapperOptions?: StereoObjectsMapperOptions;
}

/** Builds the `processSource` options for the stereo-object sensor: command/args/cwd/outputs/map,
 * ready to pass straight to a dynamically-imported nervelet's `processSource(...)`. Does not
 * import nervelet itself (see module docstring) — the caller does that, matching
 * `integrations/nervelet.ts` and `test/nervelet-world.test.ts`'s `ROBOTS_NERVELET_MODULE`
 * pattern. */
export function buildStereoObjectsSourceOptions(config: StereoObjectsSourceConfig): ProcessSourceLikeOptions {
  const id = config.id ?? 'stereoObjects';
  const args = [
    '-m', 'sensor.main',
    '--manifest', config.manifestPath,
    '--rate-hz', String(config.rateHz),
    '--checkpoint', config.checkpointPath,
    '--detector-runtime-root', config.detectorRuntimeRoot,
    '--stereo', config.stereo ?? 'sgbm',
  ];
  if (config.ffsRuntimeRoot) args.push('--ffs-runtime-root', config.ffsRuntimeRoot);
  if (config.scoreThreshold !== undefined) args.push('--score-threshold', String(config.scoreThreshold));
  if (config.maxObjects !== undefined) args.push('--max-objects', String(config.maxObjects));
  if (config.maxLineBytes !== undefined) args.push('--max-line-bytes', String(config.maxLineBytes));
  if (config.sampleIdsFile) args.push('--sample-ids-file', config.sampleIdsFile);
  if (config.device) args.push('--device', config.device);
  if (config.half) args.push('--half');

  const maxAgeMs = config.objectsMaxAgeMs ?? Math.max(2000, Math.ceil(3000 / config.rateHz));
  return {
    id, command: config.pythonExecutable, args, cwd: config.sensorCwd, env: config.env,
    outputs: [
      { name: 'objects', kind: 'sample', maxAgeMs },
      { name: 'object_appeared', kind: 'event' },
    ],
    map: createStereoObjectsMapper(config.mapperOptions ?? {}),
  };
}

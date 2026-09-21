import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AppearanceTracker, buildStereoObjectsSourceOptions, mapStereoObjectsRecord, STEREO_OBJECTS_SCHEMA,
  type AppearanceTrackerOptions, type StereoObject,
} from '../integrations/stereo-objects.ts';
import type { Json } from '../src/contracts.ts';

const NOW = Date.now();

function object(overrides: Partial<StereoObject> = {}): StereoObject {
  return {
    class: 'car', score: 0.8, bearingRightRad: 0.1, bearingUpRad: -0.02, surfaceRangeM: 12.5,
    rangeValid: true, rangeSource: 'stereo:sgbm+mask_median', maskPixels: 500, boxNorm: [0.1, 0.1, 0.3, 0.3],
    ...overrides,
  };
}

/** `acquiredOffsetMs` is relative to a fixed real "now" captured at module load, so every test
 * record looks fresh (not spuriously stale) unless a test explicitly asks for an old one. */
function frameRecord(overrides: Partial<Record<string, Json>> & { acquiredOffsetMs?: number } = {}, objects: StereoObject[] = [object()]): Json {
  const { acquiredOffsetMs, ...rest } = overrides;
  return {
    schema: STEREO_OBJECTS_SCHEMA, seq: 1, acquired: { clock: 'unix-epoch-ms', ms: NOW + (acquiredOffsetMs ?? 0) },
    emittedMs: NOW + (acquiredOffsetMs ?? 0) + 5,
    skippedSinceLast: 0, objects: objects as unknown as Json, objectsTotal: objects.length,
    timingMs: { decode: 1, detect: 2, stereo: 3, aggregate: 1, total: 7 }, valid: true,
    ...rest,
  } as Json;
}

/** A tracker configured to isolate absence-duration behaviour: no rate limit, no score hysteresis,
 * so only the appearAfterAbsenceMs logic under test can affect firing. */
function isolatedTracker(overrides: AppearanceTrackerOptions = {}): AppearanceTracker {
  return new AppearanceTracker({ minReappearanceIntervalMs: 0, presenceScoreThreshold: 0, ...overrides });
}

test('maps a frame record to one replaceable objects sample, preserving the acquisition clock', () => {
  const tracker = isolatedTracker();
  const mapped = mapStereoObjectsRecord(frameRecord(), tracker)!;
  assert.ok(mapped.samples);
  const sample = mapped.samples!.objects!;
  assert.equal(sample.valid, true);
  assert.equal(sample.acquired!.clock, 'unix-epoch-ms');
  assert.equal(sample.acquired!.ms, NOW);
  const value = sample.value as any;
  assert.equal(value.seq, 1);
  assert.equal(value.skippedSinceLast, 0);
  assert.equal(value.objectsTotal, 1);
  assert.equal(value.objects.length, 1);
  assert.equal(value.objects[0].class, 'car');
  assert.equal(typeof value.ageAtReceiptMs, 'number');
  assert.ok(value.ageAtReceiptMs >= 0 && value.ageAtReceiptMs < 5000, 'a fresh record should have a small, non-negative age');
});

test('hello and bye envelope records are skipped, not treated as malformed', () => {
  const tracker = isolatedTracker();
  assert.equal(mapStereoObjectsRecord({ schema: STEREO_OBJECTS_SCHEMA, type: 'hello', frameCount: 10 } as Json, tracker), null);
  assert.equal(mapStereoObjectsRecord({ schema: STEREO_OBJECTS_SCHEMA, type: 'bye', processed: 3 } as Json, tracker), null);
});

test('a wrong schema throws so processSource counts it as malformed instead of silently accepting it', () => {
  const tracker = isolatedTracker();
  assert.throws(() => mapStereoObjectsRecord({ schema: 'something-else/1', seq: 1 } as Json, tracker));
  assert.throws(() => mapStereoObjectsRecord({ schema: 'stereo-objects/1', seq: 1 } as Json, tracker), /stereo-objects\/1/);
});

test('a structurally invalid frame record throws', () => {
  const tracker = isolatedTracker();
  assert.throws(() => mapStereoObjectsRecord({ schema: STEREO_OBJECTS_SCHEMA } as Json, tracker), /seq/);
  assert.throws(() => mapStereoObjectsRecord(frameRecord({ objects: [{ class: 'car' }] as unknown as Json }), tracker));
});

test('an explicit invalid record (from the sensor itself) maps to an invalid sample with its reason', () => {
  const tracker = isolatedTracker();
  const mapped = mapStereoObjectsRecord(frameRecord({ valid: false, reason: 'calibration_missing' }, []), tracker)!;
  const sample = mapped.samples!.objects!;
  assert.equal(sample.valid, false);
  assert.equal(sample.reason, 'calibration_missing');
});

test('a record whose acquisition is older than maxAcquisitionAgeMs at receipt is published invalid as stale_record', () => {
  const tracker = isolatedTracker();
  const stale = mapStereoObjectsRecord(frameRecord({ acquiredOffsetMs: -10_000 }), tracker, { maxAcquisitionAgeMs: 5000 })!;
  const sample = stale.samples!.objects!;
  assert.equal(sample.valid, false);
  assert.equal(sample.reason, 'stale_record');
  assert.ok((sample.value as any).ageAtReceiptMs >= 10_000);
});

test('a fresh record under maxAcquisitionAgeMs stays valid and still reports its age', () => {
  const tracker = isolatedTracker();
  const fresh = mapStereoObjectsRecord(frameRecord({ acquiredOffsetMs: -100 }), tracker, { maxAcquisitionAgeMs: 5000 })!;
  const sample = fresh.samples!.objects!;
  assert.equal(sample.valid, true);
  assert.equal(sample.reason, undefined);
});

test('the sensor\'s own failure reason takes priority over a coincidental stale_record label', () => {
  const tracker = isolatedTracker();
  const mapped = mapStereoObjectsRecord(frameRecord({ acquiredOffsetMs: -10_000, valid: false, reason: 'detector_failed' }, []), tracker, { maxAcquisitionAgeMs: 5000 })!;
  assert.equal(mapped.samples!.objects!.reason, 'detector_failed');
});

test('the objects sample is re-capped defensively even if a record carried more than the configured max', () => {
  const tracker = isolatedTracker();
  const many = Array.from({ length: 20 }, (_, i) => object({ score: 1 - i / 100, boxNorm: [0, 0, 0.1, 0.1] }));
  const mapped = mapStereoObjectsRecord(frameRecord({ objectsTotal: 20 }, many), tracker, { maxObjectsInSample: 5 })!;
  const value = mapped.samples!.objects!.value as any;
  assert.equal(value.objects.length, 5);
  assert.equal(value.objectsTotal, 20);
});

test('object_appeared fires once for a new spatial slot, not again while it stays continuously present', () => {
  const tracker = isolatedTracker({ appearAfterAbsenceMs: 100 });
  const first = mapStereoObjectsRecord(frameRecord({ acquiredOffsetMs: 0 }), tracker)!;
  assert.equal(first.events!.length, 1);
  assert.equal(first.events![0]!.kind, 'object_appeared');
  const second = mapStereoObjectsRecord(frameRecord({ seq: 2, acquiredOffsetMs: 50 }), tracker)!;
  assert.equal(second.events!.length, 0, 'continuously present objects must not fire an event every frame');
});

test('object_appeared does not re-fire on a reappearance shorter than the declared absence interval', () => {
  const tracker = isolatedTracker({ appearAfterAbsenceMs: 200 });
  mapStereoObjectsRecord(frameRecord({ acquiredOffsetMs: 0 }), tracker);
  const gone = mapStereoObjectsRecord(frameRecord({ seq: 2, acquiredOffsetMs: 50 }, []), tracker)!;
  assert.equal(gone.events!.length, 0);
  const backSoon = mapStereoObjectsRecord(frameRecord({ seq: 3, acquiredOffsetMs: 100 }), tracker)!; // absent only 50ms < 200ms
  assert.equal(backSoon.events!.length, 0, 'a brief flicker under the declared interval must not count as a fresh appearance');
});

test('object_appeared fires again after a real absence at least as long as the declared interval', () => {
  const tracker = isolatedTracker({ appearAfterAbsenceMs: 200 });
  mapStereoObjectsRecord(frameRecord({ acquiredOffsetMs: 0 }), tracker);
  mapStereoObjectsRecord(frameRecord({ seq: 2, acquiredOffsetMs: 50 }, []), tracker);
  const backLater = mapStereoObjectsRecord(frameRecord({ seq: 3, acquiredOffsetMs: 300 }), tracker)!; // absent 250ms >= 200ms
  assert.equal(backLater.events!.length, 1);
});

test('this is the F28 case: a brief glimpse that comes and goes still produces exactly one appeared event', () => {
  // design-failures.md F28: a 0.4s glimpse disappeared before inference. With this dedup, the glimpse
  // itself is never lost as an *event*, even though the coalescing sample would show it as absent again
  // by the time a slow poller reads it.
  const tracker = isolatedTracker({ appearAfterAbsenceMs: 300 });
  const seen = mapStereoObjectsRecord(frameRecord({ acquiredOffsetMs: 0 }), tracker)!;
  const goneAgain = mapStereoObjectsRecord(frameRecord({ seq: 2, acquiredOffsetMs: 400 }, []), tracker)!;
  assert.equal(seen.events!.length, 1);
  assert.equal(goneAgain.events!.length, 0);
});

test('two objects at clearly different bearings are tracked separately, regardless of class', () => {
  const tracker = isolatedTracker({ appearAfterAbsenceMs: 100, bearingBucketRad: Math.PI / 6 });
  const left = object({ bearingRightRad: -1.0 });
  const right = object({ bearingRightRad: 1.0 });
  const mapped = mapStereoObjectsRecord(frameRecord({}, [left, right]), tracker)!;
  assert.equal(mapped.events!.length, 2);
});

test('duplicate objects at the same bearing bucket in one frame produce at most one appeared event', () => {
  const tracker = isolatedTracker();
  const a = object({ bearingRightRad: 0.1, score: 0.9 });
  const b = object({ bearingRightRad: 0.11, score: 0.5 });
  const mapped = mapStereoObjectsRecord(frameRecord({}, [a, b]), tracker)!;
  assert.equal(mapped.events!.length, 1);
});

test('v2: the SAME physical object relabelled car/truck/bus across frames is one spatial key, not three', () => {
  // The direct regression for the real-data flood this repair pass fixed: class is no longer
  // part of the key, only bearing.
  const tracker = isolatedTracker({ appearAfterAbsenceMs: 100 });
  const car = mapStereoObjectsRecord(frameRecord({ acquiredOffsetMs: 0 }, [object({ class: 'car', bearingRightRad: 0.1 })]), tracker)!;
  const truck = mapStereoObjectsRecord(frameRecord({ seq: 2, acquiredOffsetMs: 10 }, [object({ class: 'truck', bearingRightRad: 0.1 })]), tracker)!;
  const bus = mapStereoObjectsRecord(frameRecord({ seq: 3, acquiredOffsetMs: 20 }, [object({ class: 'bus', bearingRightRad: 0.1 })]), tracker)!;
  assert.equal(car.events!.length, 1);
  assert.equal(truck.events!.length, 0, 'still the same physical object (same bearing), no re-fire');
  assert.equal(bus.events!.length, 0);
  assert.equal(tracker.size, 1);
});

test('minReappearanceIntervalMs rate-limits even a genuine absence/reappearance pattern', () => {
  const tracker = new AppearanceTracker({ appearAfterAbsenceMs: 10, presenceScoreThreshold: 0, minReappearanceIntervalMs: 1000 });
  const first = mapStereoObjectsRecord(frameRecord({ acquiredOffsetMs: 0 }), tracker)!;
  mapStereoObjectsRecord(frameRecord({ seq: 2, acquiredOffsetMs: 20 }, []), tracker); // gone
  const second = mapStereoObjectsRecord(frameRecord({ seq: 3, acquiredOffsetMs: 100 }), tracker)!; // absent 80ms >= 10ms, but only 100ms since last fire < 1000ms
  assert.equal(first.events!.length, 1);
  assert.equal(second.events!.length, 0, 'rate limit blocks this re-fire even though the absence-duration check alone would allow it');
});

test('presenceScoreThreshold hysteresis: a score at the sensor\'s own lower threshold does not count as a fresh appearance, but is still tracked present', () => {
  const tracker = new AppearanceTracker({ appearAfterAbsenceMs: 10, minReappearanceIntervalMs: 0, presenceScoreThreshold: 0.35 });
  const low = mapStereoObjectsRecord(frameRecord({ acquiredOffsetMs: 0 }, [object({ score: 0.3 })]), tracker)!; // above sensor's typical 0.25, below the 0.35 hysteresis band
  assert.equal(low.events!.length, 0, 'below the presence hysteresis band: tracked, but not a fresh appearance');
  const still = mapStereoObjectsRecord(frameRecord({ seq: 2, acquiredOffsetMs: 20 }, [object({ score: 0.3 })]), tracker)!;
  assert.equal(still.events!.length, 0, 'continues to be treated as present, not re-evaluated as absent-then-back');
});

test('a currently-present key is never evicted even when overflow would otherwise remove it', () => {
  const tracker = isolatedTracker({ maxTrackedKeys: 2, bearingBucketRad: 10.0 /* huge bucket: everything maps to bucket 0 unless bearing is large */ });
  // Two distinct, clearly-separated, continuously-present slots (never marked absent).
  mapStereoObjectsRecord(frameRecord({ acquiredOffsetMs: 0 }, [object({ bearingRightRad: 0 }), object({ bearingRightRad: 1000 })]), tracker);
  assert.equal(tracker.size, 2);
  // A third, brand-new, momentarily-present-then-absent slot should not be able to evict either
  // of the two still-present ones.
  mapStereoObjectsRecord(frameRecord({ seq: 2, acquiredOffsetMs: 10 }, [object({ bearingRightRad: 0 }), object({ bearingRightRad: 1000 }), object({ bearingRightRad: 2000 })]), tracker);
  mapStereoObjectsRecord(frameRecord({ seq: 3, acquiredOffsetMs: 20 }, [object({ bearingRightRad: 0 }), object({ bearingRightRad: 1000 })]), tracker); // the third one goes absent
  const present = mapStereoObjectsRecord(frameRecord({ seq: 4, acquiredOffsetMs: 30 }, [object({ bearingRightRad: 0 }), object({ bearingRightRad: 1000 })]), tracker)!;
  assert.equal(present.events!.length, 0, 'both original slots must still read as continuously present, not evicted-then-refired');
});

test('event data carries acquired, range/rangeValid, class+altClasses and dominantColor (F28 asked for dated events)', () => {
  const tracker = isolatedTracker();
  const withAlt = object({ altClasses: [{ class: 'truck', score: 0.5 }], dominantColor: 'blue', surfaceRangeM: 9.5, rangeValid: true });
  const mapped = mapStereoObjectsRecord(frameRecord({ acquiredOffsetMs: 0 }, [withAlt]), tracker)!;
  const data = mapped.events![0]!.data as any;
  assert.deepEqual(data.acquired, { clock: 'unix-epoch-ms', ms: NOW });
  assert.equal(data.class, 'car');
  assert.deepEqual(data.altClasses, [{ class: 'truck', score: 0.5 }]);
  assert.equal(data.dominantColor, 'blue');
  assert.equal(data.surfaceRangeM, 9.5);
  assert.equal(data.rangeValid, true);
});

test('tracked state stays bounded regardless of how many distinct bearings are seen', () => {
  const tracker = isolatedTracker({ maxTrackedKeys: 8, appearAfterAbsenceMs: 0 });
  for (let i = 0; i < 50; i++) {
    // Each frame's single object is at a new bearing then gone next frame, so nothing stays
    // "present" (which would otherwise be un-evictable) and the bound is exercised for real.
    mapStereoObjectsRecord(frameRecord({ seq: i * 2, acquiredOffsetMs: i * 1000 }, [object({ bearingRightRad: i * 10 })]), tracker);
    mapStereoObjectsRecord(frameRecord({ seq: i * 2 + 1, acquiredOffsetMs: i * 1000 + 500 }, []), tracker);
  }
  assert.ok(tracker.size <= 8, `expected bounded state, got ${tracker.size}`);
});

test('buildStereoObjectsSourceOptions returns a processSource-shaped config without importing nervelet', () => {
  const options = buildStereoObjectsSourceOptions({
    pythonExecutable: 'C:/fake/python.exe', sensorCwd: 'C:/fake/jev-library', manifestPath: 'manifest.json',
    rateHz: 10, checkpointPath: 'model.pt', detectorRuntimeRoot: 'C:/fake/runtime',
  });
  assert.equal(options.id, 'stereoObjects');
  assert.equal(options.command, 'C:/fake/python.exe');
  assert.equal(options.cwd, 'C:/fake/jev-library');
  assert.deepEqual(options.args!.slice(0, 2), ['-m', 'sensor.main']);
  assert.ok(options.args!.includes('--rate-hz'));
  assert.ok(options.args!.includes('10'));
  assert.equal(options.outputs.length, 2);
  assert.deepEqual(options.outputs[0], { name: 'objects', kind: 'sample', maxAgeMs: 2000 });
  assert.equal(options.outputs[1]!.kind, 'event');
  assert.equal(typeof options.map, 'function');
});

test('buildStereoObjectsSourceOptions threads --stereo ffs and its runtime root through', () => {
  const options = buildStereoObjectsSourceOptions({
    pythonExecutable: 'python', sensorCwd: 'cwd', manifestPath: 'm.json', rateHz: 10, checkpointPath: 'c.pt',
    detectorRuntimeRoot: 'r', stereo: 'ffs', ffsRuntimeRoot: 'ffs-root',
  });
  const args = options.args!;
  assert.ok(args.includes('--stereo') && args[args.indexOf('--stereo') + 1] === 'ffs');
  assert.ok(args.includes('--ffs-runtime-root') && args[args.indexOf('--ffs-runtime-root') + 1] === 'ffs-root');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AppearanceTracker, mapStereoObjectsRecord, STEREO_OBJECTS_SCHEMA } from '../integrations/stereo-objects.ts';
import type { Json } from '../src/contracts.ts';

/**
 * Regression for the real-data event flood a prior version of this mapper produced (see
 * docs/jev-live-sensor-results.md, "Failures and repairs"): keying `object_appeared` on class +
 * bearing bucket meant the reused, unmodified detector's frequent car/truck/bus relabelling of one
 * physical object read as a new "appearance" almost every time the label flipped. Any tracker
 * design can pass a test built from synthetic fixtures shaped to fit it — this one replays an
 * actual slice of a real GPU run's saved output (`test/fixtures/real-multi-class-frames.json`,
 * extracted from `.runtime/experiments/jev-live-sensor-v1/measurements/raw-5hz.ndjson`; see that
 * fixture's own `source`/`note` fields), 32 consecutive frames including 5 genuinely multi-object
 * ones spanning `car`/`truck`/`bus` labels for what is, on inspection, the same one or two
 * physical objects.
 */

interface FixtureFile {
  source: string;
  note: string;
  records: { seq: number; acquiredOffsetMs: number; emittedOffsetMs: number; skippedSinceLast: number; objects: Json[]; objectsTotal: number }[];
}

function loadFixture(): FixtureFile {
  const path = fileURLToPath(new URL('fixtures/real-multi-class-frames.json', import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8'));
}

test('real data: a 32-frame slice with 5 multi-class frames produces a small, bounded number of appeared events, not a flood', () => {
  const fixture = loadFixture();
  assert.ok(fixture.records.length >= 30, 'fixture should be a substantial real slice');
  const multiObjectFrames = fixture.records.filter(r => r.objects.length >= 2).length;
  assert.ok(multiObjectFrames >= 3, 'fixture should actually exercise the multi-class-per-frame case');

  const anchorMs = Date.now();
  const tracker = new AppearanceTracker(); // default options: the real, shipped configuration
  let totalEvents = 0;
  const seenKinds = new Set<string>();
  for (const record of fixture.records) {
    const wireRecord: Json = {
      schema: STEREO_OBJECTS_SCHEMA, seq: record.seq,
      acquired: { clock: 'unix-epoch-ms', ms: anchorMs + record.acquiredOffsetMs },
      emittedMs: anchorMs + record.emittedOffsetMs, skippedSinceLast: record.skippedSinceLast,
      objects: record.objects, objectsTotal: record.objectsTotal, valid: true,
    } as Json;
    const mapped = mapStereoObjectsRecord(wireRecord, tracker)!;
    for (const event of mapped.events ?? []) { totalEvents++; seenKinds.add(event.kind); }
  }

  // The old, class-keyed design fired roughly once per second on data like this (per the
  // independent review that found this bug) — this slice spans about 32/5 ≈ 6.4s, so a flood
  // would show up as somewhere around 5-6+ events. The fix (spatial-identity keying, a minimum
  // re-fire interval, and score hysteresis) should produce far fewer: this scene shows at most a
  // couple of genuinely distinct physical objects across the whole slice.
  assert.ok(totalEvents <= 3, `expected a small, bounded event count for 32 real frames (car/truck/bus relabelling of the same object must not each count as a fresh appearance), got ${totalEvents}`);
  assert.deepEqual([...seenKinds], ['object_appeared']);
});

test('real data: tracked state never exceeds the configured bound while replaying this slice', () => {
  const fixture = loadFixture();
  const anchorMs = Date.now();
  const tracker = new AppearanceTracker({ maxTrackedKeys: 4 });
  let maxObservedSize = 0;
  for (const record of fixture.records) {
    const wireRecord: Json = {
      schema: STEREO_OBJECTS_SCHEMA, seq: record.seq,
      acquired: { clock: 'unix-epoch-ms', ms: anchorMs + record.acquiredOffsetMs },
      emittedMs: anchorMs + record.emittedOffsetMs, skippedSinceLast: record.skippedSinceLast,
      objects: record.objects, objectsTotal: record.objectsTotal, valid: true,
    } as Json;
    mapStereoObjectsRecord(wireRecord, tracker);
    maxObservedSize = Math.max(maxObservedSize, tracker.size);
  }
  assert.ok(maxObservedSize <= 4, `tracker state exceeded its configured bound: max observed size ${maxObservedSize}`);
});

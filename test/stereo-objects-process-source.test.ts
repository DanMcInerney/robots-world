import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildStereoObjectsSourceOptions } from '../integrations/stereo-objects.ts';

// Gated: only runs when ROBOTS_NERVELET_MODULE points at a built nervelet entry (see
// test/nervelet-world.test.ts for the same pattern). Exercises the mapper through the REAL
// nervelet processSource + SourceGroup + ObservationStore, against a tiny fake NDJSON producer
// (test/fixtures/fake-stereo-objects-producer.mjs) standing in for the Python sensor — no Python,
// GPU or model weights needed to validate the wiring itself.
test('real processSource + SourceGroup + ObservationStore consume the stereo-objects schema end to end', { skip: !process.env.ROBOTS_NERVELET_MODULE }, async () => {
  const specifier = process.env.ROBOTS_NERVELET_MODULE!;
  const nervelet = await import(specifier.startsWith('file:') ? specifier : pathToFileURL(resolve(specifier)).href);
  if (typeof nervelet.processSource !== 'function' || typeof nervelet.SourceGroup !== 'function' || typeof nervelet.ObservationStore !== 'function') {
    throw new Error('ROBOTS_NERVELET_MODULE must resolve a build exporting processSource/SourceGroup/ObservationStore.');
  }

  const built = buildStereoObjectsSourceOptions({
    id: 'stereoObjects', pythonExecutable: process.execPath, sensorCwd: resolve('test/fixtures'),
    manifestPath: 'unused.json', rateHz: 1000, checkpointPath: 'unused.pt', detectorRuntimeRoot: 'unused',
  });
  // Swap in the fake producer in place of `python -m sensor.main`; everything else (outputs, map) is real.
  const source = nervelet.processSource({
    ...built, command: process.execPath, args: [resolve('test/fixtures/fake-stereo-objects-producer.mjs')], cwd: undefined,
  });

  const store = new nervelet.ObservationStore();
  const group = new nervelet.SourceGroup(store, [source]);
  const controller = new AbortController();
  await group.start(controller.signal);
  try {
    const deadline = Date.now() + 5000;
    let snapshot: any;
    // Wait specifically for the *second* frame record's seq, not just "any sample/event yet" —
    // the fake producer writes both frame records essentially back to back, and polling on a
    // weaker condition (e.g. "an event exists") can observe the state right after the first one
    // is mapped, before the second (latest-wins) publish lands, under system load.
    while (Date.now() < deadline) {
      snapshot = store.snapshot(0);
      if (snapshot.samples?.objects?.valid && snapshot.samples.objects.value?.seq >= 2 && (snapshot.events?.length ?? 0) > 0) break;
      await new Promise(resolveWait => setTimeout(resolveWait, 25));
    }
    assert.ok(snapshot.samples?.objects, 'expected an objects sample to have been published');
    const sample = snapshot.samples.objects;
    assert.equal(sample.valid, true);
    assert.equal(sample.acquired.clock, 'unix-epoch-ms');
    assert.equal(sample.value.seq, 2); // latest-wins: the second frame record replaced the first
    assert.equal(sample.value.objects[0].class, 'car');
    assert.ok(snapshot.events.some((event: any) => event.kind === 'object_appeared'), 'expected a de-duplicated object_appeared event');
    // Only one appeared event across both frame records (same bearing bucket both times).
    assert.equal(snapshot.events.filter((event: any) => event.kind === 'object_appeared').length, 1);

    // stdin robustness (finding 6 of the repair pass): through this REAL processSource spawn (not
    // a shell, not a manual pipe trick), the child's stdin must NOT look closed — confirms Node's
    // child_process itself does not reproduce the Git-Bash/MSYS quirk the Python sensor's own
    // grace period separately guards against. The fake producer reports this via stderr, which
    // processSource's own '<id>.lifecycle' exit event tails.
    const exitDeadline = Date.now() + 5000;
    let exitEvent: any;
    while (Date.now() < exitDeadline) {
      const latest = store.snapshot(0);
      exitEvent = latest.events?.find((event: any) => event.kind === 'stereoObjects.lifecycle' && event.data?.kind === 'exit');
      if (exitEvent) break;
      await new Promise(resolveWait => setTimeout(resolveWait, 25));
    }
    assert.ok(exitEvent, 'expected the fake producer to report its own clean exit');
    assert.match(String(exitEvent.data.stderrTail), /stdinEndedBeforeExit=false/);
  } finally {
    await group.stop();
  }

  // After stop(), the source's declared samples (and this reserved diagnostics sample) must be
  // marked invalid — matching processSource's documented stop() contract.
  const after = store.snapshot(0);
  assert.equal(after.samples?.objects?.valid, false);
});

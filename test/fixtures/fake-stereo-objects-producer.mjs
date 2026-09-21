// Tiny fake stdout NDJSON producer used only by the gated real-processSource integration test
// (test/stereo-objects-process-source.test.ts). Mimics the streaming sensor's schema
// (stereo-objects/2) shape closely enough for the mapper/store to accept it, without any Python,
// GPU, model weights or real stereo frames involved.
const write = (record) => process.stdout.write(JSON.stringify(record) + '\n');
const epochAnchorMs = Date.now();

// stdin robustness probe (finding 6 of the repair pass): confirms, through the REAL gated
// processSource path (not just the Python sensor's own defensive grace period), that Node's
// child_process gives this child a genuinely open stdin pipe by default — it must NOT see an
// immediate 'end' the way a native python.exe reading a Git-Bash/MSYS named pipe did. The result
// rides in stderr, which processSource's own '<id>.lifecycle' exit event already tails.
let stdinEndedBeforeExit = false;
process.stdin.on('end', () => { stdinEndedBeforeExit = true; });
process.stdin.resume();

write({
  schema: 'stereo-objects/2', type: 'hello', source: 'fake', manifestPath: 'unused.json', frameCount: 2,
  rateHz: 1000, calibration: {}, model: {}, stereo: { backend: 'fake' },
  thresholds: { scoreThreshold: 0.25, maxObjects: 8, maxLineBytes: 4000 },
  clock: { clock: 'unix-epoch-ms', epochAnchorMs, note: 'acquired.ms/emittedMs are already unix epoch ms' },
});

const object = {
  class: 'car', score: 0.9, bearingRightRad: 0.1, bearingUpRad: -0.05, surfaceRangeM: 9.5,
  rangeValid: true, rangeSource: 'stereo:fake+mask_median', maskPixels: 321, boxNorm: [0.1, 0.2, 0.3, 0.4],
  dominantColor: 'blue',
};

write({
  schema: 'stereo-objects/2', seq: 1, acquired: { clock: 'unix-epoch-ms', ms: epochAnchorMs + 10 }, emittedMs: epochAnchorMs + 12,
  skippedSinceLast: 0, objects: [object], objectsTotal: 1, objectsTruncated: false,
  timingMs: { decode: 1, detect: 2, stereo: 3, aggregate: 1, total: 7 }, valid: true,
});
write({
  schema: 'stereo-objects/2', seq: 2, acquired: { clock: 'unix-epoch-ms', ms: epochAnchorMs + 20 }, emittedMs: epochAnchorMs + 22,
  skippedSinceLast: 0, objects: [object], objectsTotal: 1, objectsTruncated: false,
  timingMs: { decode: 1, detect: 2, stereo: 3, aggregate: 1, total: 7 }, valid: true,
});
write({ schema: 'stereo-objects/2', type: 'bye', processed: 2, skippedTotal: 0, frameErrors: 0, truncatedFrames: 0, reason: 'end_of_replay' });

// Give stdout a moment to flush over a pipe (Windows) before the process exits.
setTimeout(() => {
  console.error(`[stdin-probe] stdinEndedBeforeExit=${stdinEndedBeforeExit}`);
  process.exit(0);
}, 100);

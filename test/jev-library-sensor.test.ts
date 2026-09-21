import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// The pinned detector venv (Torch/Ultralytics/OpenCV; also has cv2/numpy, all this CPU-only suite
// needs) lives in the main robots-world checkout, not under this worktree's own (git-ignored,
// otherwise-empty) .runtime — see docs/jev-live-sensor-results.md. Overridable via
// JEV_DETECTOR_PYTHON for a different machine; skips cleanly (not a failure) when the resolved
// interpreter does not exist, matching jev-library.test.ts's own skip-when-absent pattern for the
// sibling batch-comparison Python tests.
const detectorPython = process.env.JEV_DETECTOR_PYTHON
  ?? 'C:\\Users\\danhm\\tools\\robots-world\\.runtime\\experiments\\jev-library-v1\\detector\\.venv\\Scripts\\python.exe';
const base = new URL('../', import.meta.url);
const sensorDir = fileURLToPath(new URL('experiments/jev-library', base));

// One Node test per Python module (not a single `discover` call) so a failure in one module does
// not hide the others' results in `npm test` output.
const sensorTestModules = ['test_clock', 'test_emit', 'test_frames', 'test_main', 'test_pipeline', 'test_records'];

for (const moduleName of sensorTestModules) {
  test(`stereo-object sensor contracts: sensor.${moduleName} (CPU-only, no GPU/weights/network)`, {
    skip: !existsSync(detectorPython) ? 'Detector venv unavailable at the pinned main-checkout path (set JEV_DETECTOR_PYTHON); no installs or inference' : false,
  }, () => {
    const result = spawnSync(detectorPython, ['-B', '-m', 'unittest', `sensor.${moduleName}`, '-v'], {
      encoding: 'utf8', timeout: 60_000, cwd: sensorDir,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  });
}

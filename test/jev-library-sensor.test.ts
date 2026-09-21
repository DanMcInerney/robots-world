import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// The pinned detector venv (Torch/Ultralytics/OpenCV; also has cv2/numpy, all this CPU-only suite
// needs) is a git-ignored local environment under .runtime, resolved the same way as
// jev-library.test.ts. Overridable via JEV_DETECTOR_PYTHON (for example from a git worktree whose own
// .runtime is empty); skips cleanly (not a failure) when the interpreter does not exist.
const base = new URL('../', import.meta.url);
const detectorPython = process.env.JEV_DETECTOR_PYTHON
  ?? fileURLToPath(new URL('.runtime/experiments/jev-library-v1/detector/.venv/Scripts/python.exe', base));
const sensorDir = fileURLToPath(new URL('experiments/jev-library', base));

// One Node test per Python module (not a single `discover` call) so a failure in one module does
// not hide the others' results in `npm test` output.
const sensorTestModules = ['test_clock', 'test_emit', 'test_frames', 'test_main', 'test_pipeline', 'test_records'];

for (const moduleName of sensorTestModules) {
  test(`stereo-object sensor contracts: sensor.${moduleName} (CPU-only, no GPU/weights/network)`, {
    skip: !existsSync(detectorPython) ? 'Optional local detector environment unavailable (set JEV_DETECTOR_PYTHON to override); no installs or inference' : false,
  }, () => {
    const result = spawnSync(detectorPython, ['-B', '-m', 'unittest', `sensor.${moduleName}`, '-v'], {
      encoding: 'utf8', timeout: 60_000, cwd: sensorDir,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  });
}

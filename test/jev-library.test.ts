import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const base = new URL('../', import.meta.url);
const oldPython = fileURLToPath(new URL('.runtime/experiments/jev-round3-v1/perception/.venv/Scripts/python.exe', base));
const trackerPython = fileURLToPath(new URL('.runtime/experiments/jev-library-v1/detector/.venv/Scripts/python.exe', base));
for (const [name, executable] of [
  ['test_geometry.py', oldPython], ['test_artifacts.py', oldPython],
  ['test_evaluate.py', oldPython], ['test_integrity.py', oldPython], ['test_tracker.py', trackerPython],
] as const) {
  const script = fileURLToPath(new URL(`experiments/jev-library/${name}`, base));
  test(`library comparison contracts: ${name}`, {
    skip: !existsSync(executable) ? 'Optional local vision environment unavailable; no installs or inference' : false,
  }, () => {
    assert.ok(existsSync(script), `Missing implemented contract test ${name}`);
    const result = spawnSync(executable, ['-B', script], {
      encoding: 'utf8', timeout: 60_000, cwd: fileURLToPath(base),
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  });
}

test('learned stereo metric conversion and image-only manifest contracts', {
  skip: !existsSync(oldPython) ? 'Optional local NumPy/OpenCV environment unavailable' : false,
}, () => {
  const script = fileURLToPath(new URL('experiments/jev-library/learned_stereo.py', base));
  const result = spawnSync(oldPython, ['-B', script, '--self-test'], {
    encoding: 'utf8', timeout: 30_000, cwd: fileURLToPath(base),
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

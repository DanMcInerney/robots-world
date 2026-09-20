import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const python = fileURLToPath(new URL('../.runtime/vision-env/Scripts/python.exe', import.meta.url));
const contract = fileURLToPath(new URL('../experiments/jev-spatial-text/stereo/test_contract.py', import.meta.url));

test('optional OpenCV stereo conversion, unknown and thin-return contracts', {
  skip: !existsSync(python) ? 'Existing optional vision environment unavailable; no install or network in tests' : false,
}, () => {
  const result = spawnSync(python, ['-B', contract], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stderr, /Ran 6 tests/);
});

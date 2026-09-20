import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const python = fileURLToPath(new URL('../.runtime/experiments/jev-round3-v1/perception/.venv/Scripts/python.exe', import.meta.url));
const contract = fileURLToPath(new URL('../experiments/jev-round3/perception/test_measurement.py', import.meta.url));

test('Round 3 optional image-only radial range, association and evidence contracts', {
  skip: !existsSync(python) ? 'Round 3 optional vision environment unavailable; no installs or inference in tests' : false,
}, () => {
  const result = spawnSync(python, ['-B', contract], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stderr, /Ran 13 tests/);
});

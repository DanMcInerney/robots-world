import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ageCoverageMemory, cellIndexFor, coveredCells, createCoverageMemory, DEFAULT_COVERAGE_MEMORY_CONFIG,
  isCellSeen, newAreaSeenM2, seenCellCount, updateCoverageMemory,
} from '../experiments/jev-find-follow/coverage-memory.ts';

test('cellIndexFor floors position into cellSizeM-wide grid cells', () => {
  const config = DEFAULT_COVERAGE_MEMORY_CONFIG; // cellSizeM 2
  assert.deepEqual(cellIndexFor({ x: 0, y: 0 }, config), { cx: 0, cy: 0 });
  assert.deepEqual(cellIndexFor({ x: 1.9, y: -0.1 }, config), { cx: 0, cy: -1 });
  assert.deepEqual(cellIndexFor({ x: 2.0, y: 3.9 }, config), { cx: 1, cy: 1 });
});

test('coveredCells only returns cells within effectiveRangeM and within the HFOV wedge', () => {
  const config = { ...DEFAULT_COVERAGE_MEMORY_CONFIG, cellSizeM: 2, cameraHfovDeg: 70, effectiveRangeM: 18 };
  const covered = coveredCells({ x: 0, y: 0 }, 0, config); // facing east (0deg)
  assert.ok(covered.length > 0);
  for (const { cx, cy } of covered) {
    const centerX = (cx + 0.5) * config.cellSizeM, centerY = (cy + 0.5) * config.cellSizeM;
    assert.ok(Math.hypot(centerX, centerY) <= config.effectiveRangeM + 1e-9);
  }
  // A cell directly BEHIND the camera (west) must never be covered.
  assert.ok(!covered.some(({ cx, cy }) => cx < -2 && Math.abs(cy) < 2));
});

test('a fresh memory has nothing seen', () => {
  const memory = createCoverageMemory();
  assert.equal(seenCellCount(memory), 0);
  assert.equal(isCellSeen(memory, 0, 0), false);
});

test('updateCoverageMemory marks every currently-covered cell seen, age 0', () => {
  const config = DEFAULT_COVERAGE_MEMORY_CONFIG;
  let memory = createCoverageMemory();
  memory = updateCoverageMemory(memory, { x: 0, y: 0 }, 0, config);
  const covered = coveredCells({ x: 0, y: 0 }, 0, config);
  assert.ok(covered.length > 0);
  for (const { cx, cy } of covered) assert.equal(isCellSeen(memory, cx, cy), true);
  assert.equal(seenCellCount(memory), covered.length);
});

test('ageCoverageMemory advances age and drops cells past invalidateAfterMs (a stale "I looked here" fact is not trusted indefinitely)', () => {
  const config = { ...DEFAULT_COVERAGE_MEMORY_CONFIG, invalidateAfterMs: 1000 };
  let memory = createCoverageMemory();
  memory = updateCoverageMemory(memory, { x: 0, y: 0 }, 0, config);
  assert.ok(seenCellCount(memory) > 0);
  memory = ageCoverageMemory(memory, 500, config);
  assert.ok(seenCellCount(memory) > 0, 'still remembered before the horizon');
  memory = ageCoverageMemory(memory, 600, config); // total 1100ms > 1000ms horizon
  assert.equal(seenCellCount(memory), 0, 'aged out past the invalidation horizon');
});

test('ageCoverageMemory rejects a negative elapsed span', () => {
  assert.throws(() => ageCoverageMemory(createCoverageMemory(), -1, DEFAULT_COVERAGE_MEMORY_CONFIG));
});

test('newAreaSeenM2 is the full covered area for a never-visited position, and 0 once already seen from there', () => {
  const config = DEFAULT_COVERAGE_MEMORY_CONFIG;
  const memory = createCoverageMemory();
  const covered = coveredCells({ x: 0, y: 0 }, 0, config);
  const expectedM2 = Math.round(covered.length * config.cellSizeM * config.cellSizeM * 10) / 10;
  assert.equal(newAreaSeenM2(memory, { x: 0, y: 0 }, 0, config), expectedM2);

  const seenEverywhere = updateCoverageMemory(memory, { x: 0, y: 0 }, 0, config);
  assert.equal(newAreaSeenM2(seenEverywhere, { x: 0, y: 0 }, 0, config), 0);
});

// This is the property the S1 assignment's coverage-memory design is FOR: a translate option (a
// changed POSITION, same heading) must be able to show new area even when every heading direction
// is already "inspected" from the current spot — sector-memory.ts's heading-only memory structurally
// cannot represent this (see FAILURES.md's "6/24" translate-along-open-corridor finding).
test('advancing forward reveals new area even though the heading never changed (the translate-option gap sector memory cannot represent)', () => {
  const config = DEFAULT_COVERAGE_MEMORY_CONFIG; // effectiveRangeM 18, cellSizeM 2
  let memory = createCoverageMemory();
  memory = updateCoverageMemory(memory, { x: 0, y: 0 }, 0, config); // looked east from the origin
  const stillHere = newAreaSeenM2(memory, { x: 0, y: 0 }, 0, config);
  assert.equal(stillHere, 0, 'holding at the same spot/heading adds nothing new');
  const afterAdvance15m = newAreaSeenM2(memory, { x: 15, y: 0 }, 0, config);
  assert.ok(afterAdvance15m > 0, 'advancing 15m forward (same heading) must reveal new ground ahead');
});

test('coveredCells scans a bounded box (cheap per call) regardless of how large effectiveRangeM is', () => {
  const config = { ...DEFAULT_COVERAGE_MEMORY_CONFIG, effectiveRangeM: 40, cellSizeM: 2 };
  const covered = coveredCells({ x: 0, y: 0 }, 0, config);
  const rangeCells = Math.ceil(config.effectiveRangeM / config.cellSizeM) + 1;
  assert.ok(covered.length <= (2 * rangeCells + 1) ** 2);
});

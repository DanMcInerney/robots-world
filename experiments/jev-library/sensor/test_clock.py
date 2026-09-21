"""CPU-only, deterministic: EpochClock resolution and epoch-anchoring. No GPU, no weights, no
network. Regresses the 15.625 ms `time.monotonic()` (`GetTickCount64`) granularity bug found in
the first live GPU measurement: every stamp this sensor emitted was previously an exact multiple
of 15.625 ms, coarse enough to make some `emittedMs - acquired.ms` deltas come out negative.
"""
from __future__ import annotations

import time
import unittest

from sensor.clock import EpochClock


class EpochClockTests(unittest.TestCase):
    def test_now_ms_is_close_to_the_wall_clock_at_construction(self):
        before = time.time() * 1000.0
        clock = EpochClock()
        after = time.time() * 1000.0
        self.assertLessEqual(before - 5.0, clock.epoch_anchor_ms)
        self.assertLessEqual(clock.epoch_anchor_ms, after + 5.0)
        self.assertLessEqual(before - 5.0, clock.now_ms())

    def test_readings_strictly_increase_and_are_not_quantized_to_15_625ms(self):
        clock = EpochClock()
        readings = []
        for _ in range(200):
            readings.append(clock.now_ms())
        self.assertEqual(readings, sorted(readings), "monotonic: never goes backwards")
        # time.monotonic() on this platform quantizes every reading to a multiple of 15.625 ms;
        # a high-resolution clock reading 200 times in a tight loop should see at least one pair
        # of consecutive readings that are NOT 15.625 ms apart (usually far less than 1 ms apart).
        deltas = [b - a for a, b in zip(readings, readings[1:]) if b > a]
        self.assertTrue(any(abs(d - 15.625) > 1.0 for d in deltas) or any(d < 1.0 for d in deltas),
                         f"all {len(deltas)} nonzero deltas look quantized to the old GetTickCount64 granularity: {deltas[:10]}")

    def test_two_independent_clocks_agree_within_platform_epoch_jitter(self):
        a, b = EpochClock(), EpochClock()
        self.assertLess(abs(a.now_ms() - b.now_ms()), 50.0)


if __name__ == "__main__":
    unittest.main()

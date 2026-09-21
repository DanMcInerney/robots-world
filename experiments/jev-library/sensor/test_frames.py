"""CPU-only, deterministic: latest-wins skipping/counting. No GPU, no weights, no network.

The precise skip-count assertions run against `_LatestSlot` directly and synchronously (no
threads, no wall-clock timing), so they cannot be flaky. `ReplayFrameProviderTests` then checks
the same behaviour end to end through the real pacer thread, with generous timeouts.
"""
from __future__ import annotations

import io
import json
import time
import unittest

from sensor.frames import FrameRef, OnDemandFrameProvider, ReplayFrameProvider, _LatestSlot


def _ref(seq: int) -> FrameRef:
    return FrameRef(seq=seq, id=f"frame-{seq}", left_path="l", right_path="r", calibration_path="c", acquired_ms=float(seq))


class LatestSlotTests(unittest.TestCase):
    def test_take_blocks_until_a_newer_frame_is_published(self):
        slot = _LatestSlot()
        result = slot.take(after_seq=0, timeout_s=0.05)
        self.assertIsNone(result.frame)
        self.assertFalse(result.exhausted)

    def test_publishing_several_frames_before_any_take_reports_them_all_skipped_but_one(self):
        slot = _LatestSlot()
        for seq in (1, 2, 3, 4):
            slot.publish(_ref(seq))
        result = slot.take(after_seq=0, timeout_s=0)
        self.assertEqual(result.frame.seq, 4)
        self.assertEqual(result.skipped, 3)  # frames 1-3 were released but never taken

    def test_no_skip_when_every_release_is_taken_in_turn(self):
        slot = _LatestSlot()
        last = 0
        for seq in (1, 2, 3):
            slot.publish(_ref(seq))
            result = slot.take(after_seq=last, timeout_s=0)
            self.assertEqual(result.skipped, 0)
            last = result.frame.seq
        self.assertEqual(last, 3)

    def test_done_with_nothing_new_reports_exhausted(self):
        slot = _LatestSlot()
        slot.publish(_ref(1))
        first = slot.take(after_seq=0, timeout_s=0)
        slot.mark_done()
        second = slot.take(after_seq=first.frame.seq, timeout_s=0)
        self.assertTrue(second.exhausted)
        self.assertIsNone(second.frame)

    def test_a_pending_frame_is_still_returned_before_done_is_honored(self):
        slot = _LatestSlot()
        slot.publish(_ref(1))
        slot.mark_done()
        result = slot.take(after_seq=0, timeout_s=0)
        self.assertEqual(result.frame.seq, 1)
        self.assertFalse(result.exhausted)

    def test_wake_unblocks_a_pending_take_without_a_new_frame(self):
        import threading
        slot = _LatestSlot()
        woke = threading.Event()

        def waiter():
            slot.take(after_seq=0, timeout_s=5.0)
            woke.set()

        thread = threading.Thread(target=waiter, daemon=True)
        thread.start()
        time.sleep(0.05)
        slot.wake()
        thread.join(timeout=2.0)
        self.assertTrue(woke.is_set(), "wake() should have unblocked the pending take() well before its 5s timeout")


class ReplayFrameProviderTests(unittest.TestCase):
    def test_never_loops_and_marks_exhausted_after_the_last_sample(self):
        samples = [{"id": f"s{i}", "leftPath": "l", "rightPath": "r", "calibrationPath": "c"} for i in range(3)]
        # A deliberately generous period (50ms): this test asserts exact frame coverage, which a
        # very fast pacer cannot guarantee against ordinary thread-start/GIL scheduling jitter —
        # that's expected latest-wins behaviour, covered separately below, not a bug.
        provider = ReplayFrameProvider(samples, rate_hz=20.0)
        provider.start()
        try:
            last = 0
            seen = []
            while True:
                result = provider.take_latest(last, timeout_s=2.0)
                if result.frame is None:
                    self.assertTrue(result.exhausted)
                    break
                seen.append(result.frame.id)
                last = result.frame.seq
            self.assertEqual(seen, ["s0", "s1", "s2"])
        finally:
            provider.stop()

    def test_a_slow_consumer_skips_frames_instead_of_queueing(self):
        samples = [{"id": f"s{i}", "leftPath": "l", "rightPath": "r", "calibrationPath": "c"} for i in range(20)]
        provider = ReplayFrameProvider(samples, rate_hz=200.0)  # 5ms period
        provider.start()
        try:
            time.sleep(0.15)  # let the pacer release well ahead of this "slow" consumer
            result = provider.take_latest(0, timeout_s=1.0)
            self.assertIsNotNone(result.frame)
            self.assertGreater(result.skipped, 0, "a consumer that waited should have skipped older releases, not queued them")
        finally:
            provider.stop()

    def test_acquired_ms_is_stamped_independently_of_when_it_is_taken(self):
        samples = [{"id": "s0", "leftPath": "l", "rightPath": "r", "calibrationPath": "c"}]
        provider = ReplayFrameProvider(samples, rate_hz=1000.0)
        provider.start()
        try:
            result = provider.take_latest(0, timeout_s=1.0)
            acquired_at_release = result.frame.acquired_ms
            time.sleep(0.05)
            # Taking again (no new frame) must not change what was already stamped.
            still = provider.take_latest(0, timeout_s=0)
            self.assertEqual(still.frame.acquired_ms, acquired_at_release)
        finally:
            provider.stop()

    def test_rejects_nonpositive_rate_and_empty_samples(self):
        with self.assertRaises(ValueError):
            ReplayFrameProvider([], rate_hz=10.0)
        with self.assertRaises(ValueError):
            ReplayFrameProvider([{"id": "s0", "leftPath": "l", "rightPath": "r", "calibrationPath": "c"}], rate_hz=0)


class OnDemandFrameProviderTests(unittest.TestCase):
    def test_returns_exactly_one_frame_per_stdin_line_preserving_the_callers_acquired_ms(self):
        lines = [
            json.dumps({"id": "a", "leftPath": "/l1.png", "rightPath": "/r1.png", "calibrationPath": "/c1.json", "acquiredMs": 12345.5}),
            json.dumps({"id": "b", "leftPath": "/l2.png", "rightPath": "/r2.png", "calibrationPath": "/c2.json", "acquiredMs": 12545.5}),
        ]
        provider = OnDemandFrameProvider(stream=io.StringIO("\n".join(lines) + "\n"))
        first = provider.take_latest(0, timeout_s=0)
        self.assertEqual(first.frame.seq, 1)
        self.assertEqual(first.frame.id, "a")
        self.assertEqual(first.frame.left_path, "/l1.png")
        self.assertEqual(first.frame.acquired_ms, 12345.5)  # verbatim from the caller, not this process's own clock
        self.assertEqual(first.skipped, 0)
        self.assertFalse(first.exhausted)
        second = provider.take_latest(first.frame.seq, timeout_s=0)
        self.assertEqual(second.frame.seq, 2)
        self.assertEqual(second.frame.id, "b")

    def test_eof_marks_exhausted_never_skips(self):
        provider = OnDemandFrameProvider(stream=io.StringIO(""))
        result = provider.take_latest(0, timeout_s=0)
        self.assertIsNone(result.frame)
        self.assertTrue(result.exhausted)

    def test_blank_lines_are_ignored_not_treated_as_eof_or_a_frame(self):
        line = json.dumps({"id": "a", "leftPath": "l", "rightPath": "r", "calibrationPath": "c", "acquiredMs": 1.0})
        provider = OnDemandFrameProvider(stream=io.StringIO(f"\n\n{line}\n"))
        result = provider.take_latest(0, timeout_s=0)
        self.assertEqual(result.frame.id, "a")
        self.assertFalse(result.exhausted)

    def test_start_wake_stop_are_harmless_no_ops(self):
        provider = OnDemandFrameProvider(stream=io.StringIO(""))
        provider.start()
        provider.wake()
        provider.stop()  # must not raise


if __name__ == "__main__":
    unittest.main()

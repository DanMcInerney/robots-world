"""CPU-only, deterministic: the whole streaming loop (run_sensor) driven with fake
Detector/StereoBackend doubles and tiny synthetic on-disk frames (see testing.py) — NDJSON
framing/stdout purity, schema, latest-wins skipping/counting, object cap, null-range handling and
clean shutdown, all without a GPU, model weights or network access.
"""
from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

import numpy as np

from sensor.main import ShutdownWatcher, load_samples, run_sensor
from sensor.records import SCHEMA
from sensor.testing import FakeDetector, FakeStereoBackend, ManualFrameProvider, make_detection, make_mask, write_fixture_frame


def _lines(stream: io.StringIO) -> list:
    text = stream.getvalue()
    return [json.loads(line) for line in text.split("\n") if line]


class RunSensorTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)

    def _samples(self, count: int) -> list:
        return [write_fixture_frame(self.dir, f"f{i}") for i in range(count)]

    def test_stdout_is_only_valid_single_line_json_hello_first_bye_last(self):
        samples = self._samples(3)
        detector = FakeDetector(detections=[make_detection()], masks=make_mask(30, 40)[None])
        stream = io.StringIO()
        # A deterministic, synchronous provider: this test asserts EXACT frame-by-frame coverage,
        # which a real paced provider cannot guarantee under system load (see
        # ManualFrameProvider's docstring; a real flake this repair pass found and fixed).
        run_sensor(samples=samples, rate_hz=1.0, detector=detector, stereo_backend=FakeStereoBackend(),
                   score_threshold=0.25, max_objects=8, max_line_bytes=4000, manifest_path="fake.json",
                   model_meta={"checkpointName": "fake"}, out=stream, shutdown_event=threading.Event(),
                   poll_timeout_s=0.05, provider=ManualFrameProvider(samples))
        text = stream.getvalue()
        self.assertNotEqual(text, "")
        self.assertNotIn("\r", text, "lines must be LF-terminated, never CRLF")
        for raw_line in text.split("\n"):
            if not raw_line:
                continue
            record = json.loads(raw_line)  # raises if any line is not standalone valid JSON
            self.assertEqual(record["schema"], SCHEMA)
        records = _lines(stream)
        self.assertEqual(records[0]["type"], "hello")
        self.assertEqual(records[-1]["type"], "bye")
        frame_records = [r for r in records if "type" not in r]
        self.assertEqual(len(frame_records), 3)
        self.assertEqual([r["seq"] for r in frame_records], [1, 2, 3])
        self.assertTrue(all(r["valid"] for r in frame_records))

    def test_bye_reports_end_of_replay_when_the_manifest_is_exhausted(self):
        samples = self._samples(2)
        stream = io.StringIO()
        result = run_sensor(samples=samples, rate_hz=1.0, detector=FakeDetector(), stereo_backend=FakeStereoBackend(),
                             score_threshold=0.25, max_objects=8, max_line_bytes=4000, manifest_path="fake.json",
                             model_meta={}, out=stream, shutdown_event=threading.Event(), poll_timeout_s=0.05,
                             provider=ManualFrameProvider(samples))
        self.assertEqual(result["reason"], "end_of_replay")
        self.assertEqual(result["processed"], 2)
        self.assertEqual(_lines(stream)[-1]["reason"], "end_of_replay")

    def test_a_slow_pipeline_skips_frames_and_reports_the_skip_count_never_a_queue(self):
        samples = self._samples(12)
        detector = FakeDetector(detections=[make_detection()], masks=make_mask(30, 40)[None], delay_s=0.05)
        stream = io.StringIO()
        result = run_sensor(samples=samples, rate_hz=100.0, detector=detector, stereo_backend=FakeStereoBackend(),
                             score_threshold=0.25, max_objects=8, max_line_bytes=4000, manifest_path="fake.json",
                             model_meta={}, out=stream, shutdown_event=threading.Event(), poll_timeout_s=0.05)
        self.assertLess(result["processed"], 12, "a detector far slower than the release rate must not process every frame")
        self.assertGreater(result["skippedTotal"], 0)
        # Invariant, not an exact count (real pacing is inherently subject to scheduling jitter
        # under load): every released frame was either processed or counted as skipped, exactly
        # once, for a run that reaches end_of_replay (the pacer always finishes releasing the
        # whole sample list before this run's consumer stops asking for more).
        self.assertEqual(result["reason"], "end_of_replay")
        self.assertEqual(result["processed"] + result["skippedTotal"], 12)
        frame_records = [r for r in _lines(stream) if "type" not in r]
        # skippedSinceLast on each processed record, summed, must equal the reported total.
        self.assertEqual(sum(r["skippedSinceLast"] for r in frame_records), result["skippedTotal"])
        # seq strictly increases and is never repeated/reordered despite the skipping.
        seqs = [r["seq"] for r in frame_records]
        self.assertEqual(seqs, sorted(set(seqs)))

    def test_object_cap_is_reported_end_to_end(self):
        boxes = [(i, i, i + 3, i + 3) for i in range(0, 20, 4)]
        detections = [make_detection(confidence=0.9 - 0.01 * i, box=b, detection_id=f"d{i}") for i, b in enumerate(boxes)]
        masks = np.stack([make_mask(30, 40, b) for b in boxes])
        samples = self._samples(1)
        detector = FakeDetector(detections=detections, masks=masks)
        stream = io.StringIO()
        run_sensor(samples=samples, rate_hz=1.0, detector=detector, stereo_backend=FakeStereoBackend(),
                   score_threshold=0.25, max_objects=2, max_line_bytes=4000, manifest_path="fake.json",
                   model_meta={}, out=stream, shutdown_event=threading.Event(), poll_timeout_s=0.05,
                   provider=ManualFrameProvider(samples))
        frame_records = [r for r in _lines(stream) if "type" not in r]
        self.assertEqual(len(frame_records), 1)
        self.assertEqual(len(frame_records[0]["objects"]), 2)
        self.assertEqual(frame_records[0]["objectsTotal"], 5)
        self.assertTrue(frame_records[0]["objectsTruncated"])

    def test_null_range_with_a_reason_reaches_the_final_record_never_a_guess(self):
        samples = self._samples(1)
        detector = FakeDetector(detections=[make_detection()], masks=make_mask(30, 40)[None])
        stereo = FakeStereoBackend(depth=np.full((30, 40), np.nan, np.float32), valid=np.zeros((30, 40), bool))
        stream = io.StringIO()
        run_sensor(samples=samples, rate_hz=1.0, detector=detector, stereo_backend=stereo,
                   score_threshold=0.25, max_objects=8, max_line_bytes=4000, manifest_path="fake.json",
                   model_meta={}, out=stream, shutdown_event=threading.Event(), poll_timeout_s=0.05,
                   provider=ManualFrameProvider(samples))
        frame_records = [r for r in _lines(stream) if "type" not in r]
        obj = frame_records[0]["objects"][0]
        self.assertIsNone(obj["surfaceRangeM"])
        self.assertFalse(obj["rangeValid"])
        self.assertIn("rangeReason", obj)

    def test_a_frame_that_fails_to_process_gets_an_explicit_invalid_record_not_a_crash(self):
        good = write_fixture_frame(self.dir, "good")
        bad = dict(good)
        bad["id"] = "bad"
        bad["calibrationPath"] = str(self.dir / "does-not-exist.json")
        samples = [good, bad, write_fixture_frame(self.dir, "good2")]
        stream = io.StringIO()
        result = run_sensor(samples=samples, rate_hz=1.0, detector=FakeDetector(), stereo_backend=FakeStereoBackend(),
                             score_threshold=0.25, max_objects=8, max_line_bytes=4000, manifest_path="fake.json",
                             model_meta={}, out=stream, shutdown_event=threading.Event(), poll_timeout_s=0.05,
                             provider=ManualFrameProvider(samples))
        self.assertEqual(result["frameErrors"], 1)
        self.assertEqual(result["processed"], 2)
        self.assertEqual(result["reason"], "end_of_replay")  # a per-frame failure is recoverable, not fatal
        frame_records = [r for r in _lines(stream) if "type" not in r]
        # The failed frame is represented on the wire too — never silently dropped.
        self.assertEqual(len(frame_records), 3)
        failed = frame_records[1]
        self.assertEqual(failed["seq"], 2)
        self.assertFalse(failed["valid"])
        self.assertIn("reason", failed)
        self.assertEqual(failed["objects"], [])
        self.assertTrue(frame_records[0]["valid"])
        self.assertTrue(frame_records[2]["valid"])

    def test_an_exception_outside_frameprocessingerror_is_fatal_and_bye_says_so(self):
        # Belt-and-braces: even if a bug in the pipeline raised something other than
        # FrameProcessingError, the sensor must not silently report end_of_replay.
        class ExplodingProvider:
            def start(self): pass
            def take_latest(self, after_seq, timeout_s=None): raise RuntimeError("boom")
            def wake(self): pass
            def stop(self): pass

        samples = self._samples(1)
        stream = io.StringIO()
        with self.assertRaises(RuntimeError):
            run_sensor(samples=samples, rate_hz=1.0, detector=FakeDetector(), stereo_backend=FakeStereoBackend(),
                       score_threshold=0.25, max_objects=8, max_line_bytes=4000, manifest_path="fake.json",
                       model_meta={}, out=stream, shutdown_event=threading.Event(), poll_timeout_s=0.05,
                       provider=ExplodingProvider())
        bye = _lines(stream)[-1]
        self.assertEqual(bye["type"], "bye")
        self.assertIn("fatal_error", bye["reason"])
        self.assertNotEqual(bye["reason"], "end_of_replay")

    def test_shutdown_event_ends_the_loop_promptly_with_a_bye_record(self):
        samples = self._samples(50)
        detector = FakeDetector(detections=[make_detection()], masks=make_mask(30, 40)[None], delay_s=0.02)
        stream = io.StringIO()
        event = threading.Event()
        threading.Timer(0.08, event.set).start()
        result = run_sensor(samples=samples, rate_hz=100.0, detector=detector, stereo_backend=FakeStereoBackend(),
                             score_threshold=0.25, max_objects=8, max_line_bytes=4000, manifest_path="fake.json",
                             model_meta={}, out=stream, shutdown_event=event, poll_timeout_s=0.05)
        self.assertEqual(result["reason"], "shutdown_requested")
        self.assertLess(result["processed"], 50)
        self.assertEqual(_lines(stream)[-1]["type"], "bye")
        frame_records = [r for r in _lines(stream) if "type" not in r]
        seqs = [r["seq"] for r in frame_records]
        self.assertEqual(seqs, sorted(set(seqs)), "monotonic, never-repeated seq even under shutdown")


class LoadSamplesTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)
        self.manifest_path = self.dir / "manifest.json"
        self.manifest_path.write_text(json.dumps({"samples": [
            {"id": "a", "leftPath": "l", "rightPath": "r", "calibrationPath": "c"},
            {"id": "b", "leftPath": "l", "rightPath": "r", "calibrationPath": "c"},
            {"id": "c", "leftPath": "l", "rightPath": "r", "calibrationPath": "c"},
        ]}), encoding="utf-8")

    def test_no_sample_ids_file_returns_the_whole_manifest_in_order(self):
        samples = load_samples(self.manifest_path, None)
        self.assertEqual([s["id"] for s in samples], ["a", "b", "c"])

    def test_sample_ids_file_filters_and_reorders(self):
        ids_path = self.dir / "ids.txt"
        ids_path.write_text("c\na\n", encoding="utf-8")
        samples = load_samples(self.manifest_path, ids_path)
        self.assertEqual([s["id"] for s in samples], ["c", "a"])

    def test_an_unknown_sample_id_is_a_clear_error_not_a_silent_skip(self):
        ids_path = self.dir / "ids.txt"
        ids_path.write_text("a\nnope\n", encoding="utf-8")
        with self.assertRaises(ValueError):
            load_samples(self.manifest_path, ids_path)


class _FakeProvider:
    """Just enough of the FrameProvider surface for ShutdownWatcher: it only ever calls wake()."""
    def __init__(self) -> None:
        self.woken = 0

    def wake(self) -> None:
        self.woken += 1


class ShutdownWatcherStdinTests(unittest.TestCase):
    """Exercises watch_stdin() against a REAL OS pipe (os.pipe()), independent of any shell's own
    stdin plumbing — this is what proves the mechanism itself is correct. (A companion note in
    run_sensor()'s docstring records a shell-specific quirk found while manually driving the real
    CLI: Git-Bash/MSYS on Windows delivers immediate EOF to a native python.exe reading a named
    pipe even with a background writer holding it open, which is an MSYS translation artifact, not
    a bug in this mechanism — this test does not depend on any of that shell machinery.)"""

    def test_watch_stdin_does_not_trigger_while_the_write_end_stays_open(self):
        read_fd, write_fd = os.pipe()
        real_stdin = sys.stdin
        reader = os.fdopen(read_fd, "r", encoding="utf-8")
        sys.stdin = reader
        provider = _FakeProvider()
        watcher = ShutdownWatcher(provider)
        try:
            watcher.watch_stdin(grace_period_s=0.05)
            time.sleep(0.2)
            self.assertFalse(watcher.event.is_set(), "an open, silent stdin must not trigger shutdown")
        finally:
            sys.stdin = real_stdin
            os.close(write_fd)
            reader.close()

    def test_watch_stdin_triggers_promptly_once_the_write_end_closes_after_the_grace_period(self):
        read_fd, write_fd = os.pipe()
        real_stdin = sys.stdin
        reader = os.fdopen(read_fd, "r", encoding="utf-8")
        sys.stdin = reader
        provider = _FakeProvider()
        watcher = ShutdownWatcher(provider)
        try:
            watcher.watch_stdin(grace_period_s=0.05)
            time.sleep(0.15)  # past the grace period, so this close is trusted as genuine
            os.close(write_fd)  # the only thing that should look like "stdin closed"
            deadline = time.monotonic() + 2.0
            while time.monotonic() < deadline and not watcher.event.is_set():
                time.sleep(0.01)
            self.assertTrue(watcher.event.is_set())
            self.assertGreaterEqual(provider.woken, 1, "closing stdin must wake the frame provider promptly, not leave it polling")
        finally:
            sys.stdin = real_stdin
            reader.close()

    def test_an_immediate_eof_within_the_grace_period_is_suppressed_not_a_shutdown(self):
        # Regression for a real environment quirk: Git-Bash/MSYS on Windows delivered instant EOF
        # to a native python.exe reading even an open, held-open named pipe. Without a grace
        # period this made the sensor exit before processing a single frame. Closing the write end
        # immediately here reproduces that "instant EOF at startup" shape directly, independent of
        # any shell/mkfifo machinery.
        read_fd, write_fd = os.pipe()
        real_stdin = sys.stdin
        reader = os.fdopen(read_fd, "r", encoding="utf-8")
        sys.stdin = reader
        provider = _FakeProvider()
        watcher = ShutdownWatcher(provider)
        try:
            watcher.watch_stdin(grace_period_s=5.0)
            os.close(write_fd)  # instant EOF, well within the 5s grace period
            time.sleep(0.3)
            self.assertFalse(watcher.event.is_set(), "an EOF within the grace period must not trigger shutdown")
            self.assertEqual(provider.woken, 0)
        finally:
            sys.stdin = real_stdin
            reader.close()


if __name__ == "__main__":
    unittest.main()

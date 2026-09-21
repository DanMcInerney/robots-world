"""CPU-only, deterministic: schema shape, object cap + line-size bound, and the generic colour
attribute. No GPU, no weights, no network.
"""
from __future__ import annotations

import json
import unittest

import numpy as np

from sensor.records import SCHEMA, bye_record, dominant_color_name, failed_frame_record, frame_record, hello_record


def _object(score: float, extra_bytes: int = 0) -> dict:
    return {"class": "car", "score": score, "bearingRightRad": 0.01, "bearingUpRad": -0.02,
            "surfaceRangeM": 5.0, "rangeValid": True, "rangeSource": "stereo:sgbm+mask_median",
            "maskPixels": 100, "boxNorm": [0.1, 0.1, 0.2, 0.2], "padding": "x" * extra_bytes}


class FrameRecordTests(unittest.TestCase):
    def test_caps_to_max_objects_and_reports_the_pre_cap_total(self):
        objects = [_object(score) for score in (0.9, 0.8, 0.7, 0.6, 0.5)]
        record, truncated = frame_record(seq=1, acquired_ms=10.0, emitted_ms=20.0, skipped_since_last=0,
                                          objects=objects, objects_total=len(objects), timing_ms={"total": 1.0},
                                          max_objects=3)
        self.assertTrue(truncated)
        self.assertEqual(len(record["objects"]), 3)
        self.assertEqual(record["objectsTotal"], 5)
        self.assertTrue(record["objectsTruncated"])
        self.assertEqual([o["score"] for o in record["objects"]], [0.9, 0.8, 0.7])

    def test_no_truncation_flag_when_everything_fits(self):
        objects = [_object(0.9)]
        record, truncated = frame_record(seq=1, acquired_ms=0.0, emitted_ms=0.0, skipped_since_last=0,
                                          objects=objects, objects_total=1, timing_ms={}, max_objects=8)
        self.assertFalse(truncated)
        self.assertFalse(record["objectsTruncated"])
        self.assertEqual(record["objectsTotal"], 1)

    def test_shrinks_further_and_still_reports_truncation_when_the_line_would_stay_oversize(self):
        # Eight compact objects, but an artificially tiny max_line_bytes forces additional shrinking
        # beyond the max_objects cap; the record must still end up at or under budget.
        objects = [_object(0.9 - 0.01 * i, extra_bytes=50) for i in range(8)]
        record, truncated = frame_record(seq=1, acquired_ms=0.0, emitted_ms=0.0, skipped_since_last=0,
                                          objects=objects, objects_total=len(objects), timing_ms={}, max_objects=8,
                                          max_line_bytes=400)
        self.assertTrue(truncated)
        self.assertLessEqual(len(json.dumps(record).encode("utf-8")), 400 + 200)  # generous slack for the shrink loop's own overhead
        self.assertLess(len(record["objects"]), 8)

    def test_record_line_is_valid_single_line_json_with_the_declared_schema(self):
        record, _ = frame_record(seq=7, acquired_ms=1.0, emitted_ms=2.0, skipped_since_last=3,
                                  objects=[_object(0.5)], objects_total=1,
                                  timing_ms={"decode": 1.0, "detect": 2.0, "stereo": 3.0, "aggregate": 4.0, "total": 10.0},
                                  max_objects=8)
        line = json.dumps(record)
        self.assertNotIn("\n", line)
        parsed = json.loads(line)
        self.assertEqual(parsed["schema"], SCHEMA)
        self.assertEqual(parsed["seq"], 7)
        self.assertEqual(parsed["skippedSinceLast"], 3)
        self.assertEqual(parsed["acquired"], {"clock": "unix-epoch-ms", "ms": 1.0})
        self.assertEqual(parsed["valid"], True)
        self.assertEqual(set(parsed["timingMs"]), {"decode", "detect", "stereo", "aggregate", "total"})

    def test_no_goal_specific_fields_anywhere_in_a_frame_record(self):
        record, _ = frame_record(seq=1, acquired_ms=0.0, emitted_ms=0.0, skipped_since_last=0,
                                  objects=[_object(0.5)], objects_total=1, timing_ms={}, max_objects=8)
        blob = json.dumps(record).lower()
        for forbidden in ("bluecarcandidate", "targetidentity", "selecteddetectionid", "blue_car", "target_car"):
            self.assertNotIn(forbidden, blob)


class FailedFrameRecordTests(unittest.TestCase):
    def test_shape_and_json_purity(self):
        record = failed_frame_record(seq=5, acquired_ms=10.0, emitted_ms=20.0, skipped_since_last=1, reason="boom")
        self.assertEqual(record["schema"], SCHEMA)
        self.assertEqual(record["seq"], 5)
        self.assertEqual(record["valid"], False)
        self.assertEqual(record["reason"], "boom")
        self.assertEqual(record["objects"], [])
        self.assertEqual(record["objectsTotal"], 0)
        json.dumps(record)  # must be serializable as one line

    def test_reason_is_bounded(self):
        record = failed_frame_record(seq=1, acquired_ms=0.0, emitted_ms=0.0, skipped_since_last=0, reason="x" * 10_000)
        self.assertLessEqual(len(record["reason"]), 200)


class EnvelopeRecordTests(unittest.TestCase):
    def test_hello_record_shape(self):
        record = hello_record(source="replay", manifest_path="m.json", frame_count=10, rate_hz=5.0,
                               calibration={"width": 640}, model={"checkpointName": "x"}, stereo={"backend": "sgbm"},
                               score_threshold=0.25, max_objects=8, max_line_bytes=4000, epoch_anchor_ms=123.0)
        self.assertEqual(record["schema"], SCHEMA)
        self.assertEqual(record["type"], "hello")
        self.assertEqual(record["thresholds"], {"scoreThreshold": 0.25, "maxObjects": 8, "maxLineBytes": 4000})
        json.dumps(record)  # must be serializable as one line

    def test_bye_record_shape(self):
        record = bye_record(processed=5, skipped_total=2, frame_errors=1, truncated_frames=0, reason="end_of_replay")
        self.assertEqual(record["schema"], SCHEMA)
        self.assertEqual(record["type"], "bye")
        self.assertEqual(record["reason"], "end_of_replay")
        json.dumps(record)


class DominantColorTests(unittest.TestCase):
    def test_names_a_saturated_region(self):
        image = np.zeros((10, 10, 3), np.uint8)
        image[:] = (0, 0, 200)  # BGR pure-ish red
        mask = np.ones((10, 10), bool)
        self.assertEqual(dominant_color_name(image, mask, (0, 0, 10, 10)), "red")

    def test_low_saturation_is_neutral(self):
        image = np.zeros((10, 10, 3), np.uint8)
        image[:] = (30, 30, 30)  # dark, low-saturation
        mask = np.ones((10, 10), bool)
        self.assertEqual(dominant_color_name(image, mask, (0, 0, 10, 10)), "black")

    def test_falls_back_to_the_box_when_the_mask_is_empty(self):
        image = np.zeros((10, 10, 3), np.uint8)
        image[2:8, 2:8] = (0, 200, 0)  # green box region
        mask = np.zeros((10, 10), bool)
        self.assertEqual(dominant_color_name(image, mask, (2, 2, 8, 8)), "green")

    def test_returns_none_for_a_degenerate_empty_box(self):
        image = np.zeros((10, 10, 3), np.uint8)
        mask = np.zeros((10, 10), bool)
        self.assertIsNone(dominant_color_name(image, mask, (5, 5, 5, 5)))


if __name__ == "__main__":
    unittest.main()

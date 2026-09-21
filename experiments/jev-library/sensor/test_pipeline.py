"""CPU-only, deterministic: decode -> detect -> stereo -> mask-median range -> bearing, driven by
fake Detector/StereoBackend doubles and tiny synthetic images (see testing.py). No GPU, no model
weights, no network.
"""
from __future__ import annotations

import math
import tempfile
import unittest
from pathlib import Path

import numpy as np

from sensor.pipeline import FrameProcessingError, SensorPipeline
from sensor.testing import FakeDetector, FakeStereoBackend, make_detection, make_mask, write_fixture_frame


class SensorPipelineTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.sample = write_fixture_frame(Path(self._tmp.name), "frame-0")

    def test_a_below_threshold_detection_never_becomes_an_object(self):
        detector = FakeDetector(detections=[make_detection(confidence=0.1)], masks=make_mask(30, 40)[None])
        pipeline = SensorPipeline(detector, FakeStereoBackend(), score_threshold=0.25, max_objects=8)
        outcome = pipeline.process(self.sample["leftPath"], self.sample["rightPath"], self.sample["calibrationPath"])
        self.assertEqual(outcome.objects, [])
        self.assertEqual(outcome.objects_total, 0)

    def test_a_valid_detection_produces_one_object_with_a_measured_range_and_bearing(self):
        box = (5.0, 5.0, 20.0, 20.0)
        detector = FakeDetector(detections=[make_detection(confidence=0.9, box=box)], masks=make_mask(30, 40, box)[None])
        depth = np.full((30, 40), 8.0, np.float32)
        stereo = FakeStereoBackend(depth=depth, valid=np.ones((30, 40), bool))
        pipeline = SensorPipeline(detector, stereo, score_threshold=0.25, max_objects=8)
        outcome = pipeline.process(self.sample["leftPath"], self.sample["rightPath"], self.sample["calibrationPath"])
        self.assertEqual(len(outcome.objects), 1)
        obj = outcome.objects[0]
        self.assertEqual(obj["class"], "car")
        self.assertTrue(obj["rangeValid"])
        self.assertIsNotNone(obj["surfaceRangeM"])
        self.assertGreaterEqual(obj["surfaceRangeM"], 8.0)  # radial range from an axial depth of 8m is >= 8m off-axis
        self.assertNotIn("rangeReason", obj)
        self.assertEqual(obj["rangeSource"], "stereo:fake-stereo+mask_median")
        self.assertTrue(math.isfinite(obj["bearingRightRad"]))
        self.assertTrue(math.isfinite(obj["bearingUpRad"]))
        self.assertEqual(obj["maskPixels"], int(make_mask(30, 40, box).sum()))
        self.assertEqual(len(obj["boxNorm"]), 4)
        for value in obj["boxNorm"]:
            self.assertGreaterEqual(value, 0.0)
            self.assertLessEqual(value, 1.0)

    def test_no_valid_depth_gives_a_null_range_with_a_reason_never_a_guess(self):
        box = (5.0, 5.0, 20.0, 20.0)
        detector = FakeDetector(detections=[make_detection(confidence=0.9, box=box)], masks=make_mask(30, 40, box)[None])
        stereo = FakeStereoBackend(depth=np.full((30, 40), np.nan, np.float32), valid=np.zeros((30, 40), bool))
        pipeline = SensorPipeline(detector, stereo, score_threshold=0.25, max_objects=8)
        outcome = pipeline.process(self.sample["leftPath"], self.sample["rightPath"], self.sample["calibrationPath"])
        obj = outcome.objects[0]
        self.assertFalse(obj["rangeValid"])
        self.assertIsNone(obj["surfaceRangeM"])
        self.assertIn("rangeReason", obj)
        self.assertIsInstance(obj["rangeReason"], str)

    def test_objects_are_sorted_by_score_descending_before_capping(self):
        boxes = [(2.0, 2.0, 10.0, 10.0), (12.0, 12.0, 20.0, 20.0), (22.0, 2.0, 30.0, 10.0)]
        detections = [make_detection(confidence=c, box=b, detection_id=f"d{i}") for i, (c, b) in enumerate(zip((0.3, 0.9, 0.6), boxes))]
        masks = np.stack([make_mask(30, 40, b) for b in boxes])
        detector = FakeDetector(detections=detections, masks=masks)
        pipeline = SensorPipeline(detector, FakeStereoBackend(), score_threshold=0.25, max_objects=8)
        outcome = pipeline.process(self.sample["leftPath"], self.sample["rightPath"], self.sample["calibrationPath"])
        scores = [o["score"] for o in outcome.objects]
        self.assertEqual(scores, sorted(scores, reverse=True))

    def test_reports_a_truncation_when_more_detections_exist_than_max_objects(self):
        boxes = [(i, i, i + 3, i + 3) for i in range(0, 20, 4)]  # 5 tiny non-overlapping boxes
        detections = [make_detection(confidence=0.9 - 0.01 * i, box=b, detection_id=f"d{i}") for i, b in enumerate(boxes)]
        masks = np.stack([make_mask(30, 40, b) for b in boxes])
        detector = FakeDetector(detections=detections, masks=masks)
        pipeline = SensorPipeline(detector, FakeStereoBackend(), score_threshold=0.25, max_objects=2)
        outcome = pipeline.process(self.sample["leftPath"], self.sample["rightPath"], self.sample["calibrationPath"])
        self.assertEqual(len(outcome.objects), 2)
        self.assertEqual(outcome.objects_total, 5)

    def test_timing_stages_are_all_present_and_nonnegative(self):
        detector = FakeDetector(detections=[make_detection()], masks=make_mask(30, 40)[None])
        pipeline = SensorPipeline(detector, FakeStereoBackend(), score_threshold=0.25, max_objects=8)
        outcome = pipeline.process(self.sample["leftPath"], self.sample["rightPath"], self.sample["calibrationPath"])
        self.assertEqual(set(outcome.timing_ms), {"decode", "detect", "stereo", "aggregate", "total"})
        for value in outcome.timing_ms.values():
            self.assertGreaterEqual(value, 0.0)

    def test_missing_image_file_raises_frame_processing_error_not_a_crash(self):
        detector = FakeDetector()
        pipeline = SensorPipeline(detector, FakeStereoBackend(), score_threshold=0.25, max_objects=8)
        with self.assertRaises(FrameProcessingError):
            pipeline.process("does-not-exist-left.png", "does-not-exist-right.png", self.sample["calibrationPath"])

    def test_geometry_is_cached_across_frames_with_identical_calibration(self):
        detector = FakeDetector(detections=[make_detection()], masks=make_mask(30, 40)[None])
        pipeline = SensorPipeline(detector, FakeStereoBackend(), score_threshold=0.25, max_objects=8)
        pipeline.process(self.sample["leftPath"], self.sample["rightPath"], self.sample["calibrationPath"])
        pipeline.process(self.sample["leftPath"], self.sample["rightPath"], self.sample["calibrationPath"])
        self.assertEqual(len(pipeline._geometries), 1)

    def test_geometry_cache_is_bounded(self):
        import json as _json
        from sensor.pipeline import _MAX_CACHED_GEOMETRIES
        detector = FakeDetector(detections=[make_detection()], masks=make_mask(30, 40)[None])
        pipeline = SensorPipeline(detector, FakeStereoBackend(), score_threshold=0.25, max_objects=8)
        raw = _json.loads(Path(self.sample["calibrationPath"]).read_text(encoding="utf-8"))
        for i in range(_MAX_CACHED_GEOMETRIES + 5):
            # Same image dimensions every time (so masks stay valid); only fx varies, so each
            # iteration is still a genuinely distinct calibration -> a distinct cache entry.
            varied = {**raw, "fx": raw["fx"] + i}
            calibration_path = Path(self._tmp.name) / f"cal{i}.json"
            calibration_path.write_text(_json.dumps(varied), encoding="utf-8")
            pipeline.process(self.sample["leftPath"], self.sample["rightPath"], str(calibration_path))
        self.assertLessEqual(len(pipeline._geometries), _MAX_CACHED_GEOMETRIES)

    def test_an_unexpected_aggregation_error_is_wrapped_not_left_to_crash_the_process(self):
        # A calibration whose declared width/height does not match the image (the scenario a real
        # archived Round 3 mismatch could produce) makes mask_median's shape check raise deep
        # inside aggregation; this must surface as FrameProcessingError, not a raw exception.
        detector = FakeDetector(detections=[make_detection()], masks=make_mask(30, 40)[None])
        pipeline = SensorPipeline(detector, FakeStereoBackend(), score_threshold=0.25, max_objects=8)
        mismatched = dict(self.sample)
        bad_calibration_path = Path(self._tmp.name) / "mismatched-calibration.json"
        import json as _json
        raw = _json.loads(Path(self.sample["calibrationPath"]).read_text(encoding="utf-8"))
        raw["width"], raw["height"] = 999, 999
        bad_calibration_path.write_text(_json.dumps(raw), encoding="utf-8")
        mismatched["calibrationPath"] = str(bad_calibration_path)
        with self.assertRaises(FrameProcessingError):
            pipeline.process(mismatched["leftPath"], mismatched["rightPath"], mismatched["calibrationPath"])


class CrossClassMergeTests(unittest.TestCase):
    """Real live data showed the reused, unmodified detector frequently labelling one physical
    object as 2-3 overlapping detections under different classes (e.g. car/truck/bus for one car)
    — see docs/jev-live-sensor-results.md, "Failures and repairs". These tests regress the fix."""
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.sample = write_fixture_frame(Path(self._tmp.name), "frame-0")

    def test_two_overlapping_detections_of_different_classes_merge_into_one_object_with_altclasses(self):
        box = (5.0, 5.0, 20.0, 20.0)
        mask = make_mask(30, 40, box)
        detections = [
            make_detection(class_name="car", confidence=0.9, box=box, detection_id="d0"),
            make_detection(class_name="truck", confidence=0.5, box=box, detection_id="d1"),
        ]
        masks = np.stack([mask, mask])  # identical masks: IoU == 1.0
        detector = FakeDetector(detections=detections, masks=masks)
        pipeline = SensorPipeline(detector, FakeStereoBackend(), score_threshold=0.25, max_objects=8)
        outcome = pipeline.process(self.sample["leftPath"], self.sample["rightPath"], self.sample["calibrationPath"])
        self.assertEqual(outcome.objects_total, 1, "one physical object, not two")
        self.assertEqual(len(outcome.objects), 1)
        obj = outcome.objects[0]
        self.assertEqual(obj["class"], "car")  # highest score wins as the primary label
        self.assertEqual(obj["altClasses"], [{"class": "truck", "score": 0.5}])

    def test_non_overlapping_detections_of_different_classes_stay_separate(self):
        box_a, box_b = (2.0, 2.0, 10.0, 10.0), (25.0, 2.0, 33.0, 10.0)
        detections = [
            make_detection(class_name="car", confidence=0.9, box=box_a, detection_id="d0"),
            make_detection(class_name="truck", confidence=0.8, box=box_b, detection_id="d1"),
        ]
        masks = np.stack([make_mask(30, 40, box_a), make_mask(30, 40, box_b)])
        detector = FakeDetector(detections=detections, masks=masks)
        pipeline = SensorPipeline(detector, FakeStereoBackend(), score_threshold=0.25, max_objects=8)
        outcome = pipeline.process(self.sample["leftPath"], self.sample["rightPath"], self.sample["calibrationPath"])
        self.assertEqual(outcome.objects_total, 2)
        self.assertNotIn("altClasses", outcome.objects[0])
        self.assertNotIn("altClasses", outcome.objects[1])

    def test_three_way_overlap_keeps_the_two_lower_scores_as_altclasses_highest_score_first(self):
        box = (5.0, 5.0, 20.0, 20.0)
        mask = make_mask(30, 40, box)
        detections = [
            make_detection(class_name="bus", confidence=0.4, box=box, detection_id="d0"),
            make_detection(class_name="car", confidence=0.9, box=box, detection_id="d1"),
            make_detection(class_name="truck", confidence=0.6, box=box, detection_id="d2"),
        ]
        masks = np.stack([mask, mask, mask])
        detector = FakeDetector(detections=detections, masks=masks)
        pipeline = SensorPipeline(detector, FakeStereoBackend(), score_threshold=0.25, max_objects=8)
        outcome = pipeline.process(self.sample["leftPath"], self.sample["rightPath"], self.sample["calibrationPath"])
        self.assertEqual(outcome.objects_total, 1)
        obj = outcome.objects[0]
        self.assertEqual(obj["class"], "car")
        self.assertEqual(obj["altClasses"], [{"class": "truck", "score": 0.6}, {"class": "bus", "score": 0.4}])

    def test_a_detection_below_score_threshold_never_gets_merged_in_as_an_altclass(self):
        box = (5.0, 5.0, 20.0, 20.0)
        mask = make_mask(30, 40, box)
        detections = [
            make_detection(class_name="car", confidence=0.9, box=box, detection_id="d0"),
            make_detection(class_name="truck", confidence=0.1, box=box, detection_id="d1"),  # below 0.25 threshold
        ]
        masks = np.stack([mask, mask])
        detector = FakeDetector(detections=detections, masks=masks)
        pipeline = SensorPipeline(detector, FakeStereoBackend(), score_threshold=0.25, max_objects=8)
        outcome = pipeline.process(self.sample["leftPath"], self.sample["rightPath"], self.sample["calibrationPath"])
        self.assertEqual(outcome.objects_total, 1)
        self.assertNotIn("altClasses", outcome.objects[0])


if __name__ == "__main__":
    unittest.main()

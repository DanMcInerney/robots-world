import tempfile
import unittest
from pathlib import Path

import numpy as np

from measurement import (bearing, calibration_from_json, color_evidence, compare_arms,
                         radial_ranges)
from run import load_sample, process


class MeasurementTests(unittest.TestCase):
    def setUp(self):
        self.cal = {"width": 40, "height": 30, "fx": 1000, "fy": 1000,
                    "cx": 20, "cy": 15, "baselineM": 0.2, "doffsPx": 0}

    def test_radial_conversion_uses_both_axes(self):
        cal = {**self.cal, "fx": 2, "fy": 4, "cx": 0, "cy": 0}
        ranges = radial_ranges(np.full((3, 3), 3.0), cal)
        self.assertAlmostEqual(ranges[0, 0], 3)
        self.assertAlmostEqual(ranges[2, 2], 4.5)

    def test_background_majority_and_foreground_mask(self):
        depth = np.full((30, 40), 18.0)
        depth[10:20, 10:20] = 8
        mask = np.zeros(depth.shape, bool)
        mask[10:20, 10:20] = True
        arms, _ = compare_arms(depth, np.ones(depth.shape, bool), [0, 0, 40, 30], mask, self.cal)
        self.assertGreater(arms["bboxMedian"]["estimateM"], 17)
        self.assertAlmostEqual(arms["maskForegroundCluster"]["estimateM"], 8, places=2)

    def test_nearest_is_not_dominated_by_isolated_near_outlier(self):
        depth = np.full((30, 40), 18.0)
        depth[10:20, 10:20] = 8
        depth[1, 1] = 0.1
        mask = np.ones(depth.shape, bool)
        arms, selected = compare_arms(depth, np.ones(depth.shape, bool), [0, 0, 40, 30], mask, self.cal)
        self.assertAlmostEqual(arms["maskForegroundCluster"]["estimateM"], 8, places=2)
        self.assertFalse(selected[1, 1])

    def test_insufficient_coverage_remains_unknown(self):
        depth = np.full((30, 40), 8.0)
        valid = np.zeros(depth.shape, bool)
        valid[10:15, 10:15] = True
        arms, _ = compare_arms(depth, valid, [0, 0, 40, 30], np.ones(depth.shape, bool), self.cal)
        for arm in arms.values():
            self.assertEqual(arm["status"], "unknown")
            self.assertIsNone(arm["estimateM"])
            self.assertEqual(arm["unknownReason"], "insufficient-valid-coverage")

    def test_missing_mask_does_not_invent_foreground(self):
        depth = np.full((30, 40), 8.0)
        arms, _ = compare_arms(depth, np.ones(depth.shape, bool), [0, 0, 40, 30],
                               np.zeros(depth.shape, bool), self.cal)
        self.assertEqual(arms["bboxMedian"]["status"], "measured")
        self.assertEqual(arms["maskForegroundCluster"]["unknownReason"], "empty-region")

    def test_nonfinite_depth_never_becomes_support(self):
        depth = np.full((30, 40), np.nan)
        depth[0:10] = np.inf
        depth[10:20] = -1
        arms, _ = compare_arms(depth, np.ones(depth.shape, bool), [0, 0, 40, 30],
                               np.ones(depth.shape, bool), self.cal)
        self.assertEqual(arms["bboxMedian"]["validPixels"], 0)

    def test_calibration_rejects_invalid_or_mismatched_input(self):
        for mutation in ({"width": 41}, {"fx": 0}, {"baselineM": -1}, {"fy": float("nan")}):
            with self.assertRaises(ValueError):
                calibration_from_json({**self.cal, **mutation}, (30, 40))
        result = calibration_from_json({**self.cal, "evaluatorTargetPosition": [1, 2, 3]}, (30, 40))
        self.assertNotIn("evaluatorTargetPosition", result)

    def test_blue_evidence_and_bearing_are_pixel_only(self):
        image = np.zeros((30, 40, 3), dtype=np.uint8)
        image[20:30, 25:35] = [255, 0, 0]
        mask = np.zeros((30, 40), bool)
        mask[20:30, 25:35] = True
        self.assertTrue(color_evidence(image, mask)["blueSupported"])
        observation = bearing([25, 20, 35, 30], mask, self.cal)
        self.assertGreater(observation["azimuthDeg"], 0)
        self.assertLess(observation["elevationDeg"], 0)

    def test_renderer_half_pixel_coordinates_and_snake_baseline(self):
        raw = {key: value for key, value in self.cal.items() if key != "baselineM"}
        raw.update(baseline_m=0.2, pixel_coordinates="u=column+0.5,v=row+0.5; top-left origin")
        cal = calibration_from_json(raw, (30, 40))
        self.assertEqual(cal["pixelCenterOffset"], 0.5)
        self.assertEqual(cal["baselineM"], 0.2)
        ranges = radial_ranges(np.ones((30, 40)), cal)
        self.assertAlmostEqual(ranges[15, 20], np.sqrt(1+2*(0.5/1000)**2))
        with self.assertRaises(ValueError):
            calibration_from_json({**raw, "pixel_coordinates": "unknown"}, (30, 40))
        with self.assertRaises(ValueError):
            calibration_from_json({**raw, "rectified": False}, (30, 40))

    def test_median_and_nearest_proxy_are_distinct_statistics(self):
        depth = np.full((30, 40), 8.0)
        depth[0:10] = 6
        arms, _ = compare_arms(depth, np.ones(depth.shape, bool), [0, 0, 40, 30],
                               np.ones(depth.shape, bool), self.cal)
        self.assertGreater(arms["bboxMedian"]["estimateM"] - arms["bboxMedian"]["robustNearestProxyM"], 1.9)

    def test_perception_input_rejects_evaluator_paths(self):
        with self.assertRaisesRegex(ValueError, "ONLY"):
            load_sample({"id": "sample", "leftPath": "left.png", "rightPath": "right.png",
                         "calibrationPath": "calibration.json", "truthPath": "evaluator.json"}, Path.cwd())

    def test_completed_sample_cannot_trigger_inference_again(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            (output / "sample").mkdir()
            (output / "sample/result.json").write_text("{}", encoding="utf-8")
            with self.assertRaisesRegex(FileExistsError, "rerun"):
                process({"id": "sample"}, Path.cwd(), output, None)

    def test_sample_id_cannot_escape_destination(self):
        with self.assertRaisesRegex(ValueError, "Unsafe"):
            process({"id": "../elsewhere"}, Path.cwd(), Path.cwd(), None)


if __name__ == "__main__":
    unittest.main()

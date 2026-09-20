"""CPU-only procedural qualification; no detector, renderer, or held-out data."""
import importlib.util
import math
from pathlib import Path
import unittest

import numpy as np

from geometry import Geometry, mask_median
from stereo_cached import CachedStereo


def load_reference(name, relative):
    path = Path(__file__).resolve().parents[1] / relative
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


measurement = load_reference("jev_library_test_round3_measurement", "jev-round3/perception/measurement.py")
matching = load_reference("jev_library_test_frozen_matching", "jev-spatial-text/stereo/matching.py")


def calibration(shape=(30, 40), **changes):
    height, width = shape
    return {"width": width, "height": height, "fx": 137.3, "fy": 191.7,
            "cx": width/2 + 0.13, "cy": height/2 - 0.29,
            "baselineM": 0.24, "doffsPx": 0, "pixelCenterOffset": 0.5, **changes}


def stereo_fixture(shape=(96, 384), shift=12, seed=1, occlusion=False):
    rng = np.random.default_rng(seed)
    left = rng.integers(0, 256, shape, dtype=np.uint8)
    right = rng.integers(0, 256, shape, dtype=np.uint8)
    right[:, :-shift] = left[:, shift:]
    if occlusion:
        right[20:70, 155:180] = 0
    return left, right


class GeometryTests(unittest.TestCase):
    def test_ranges_match_reference_with_unequal_focal_lengths_and_pixel_offsets(self):
        rng = np.random.default_rng(4)
        depth = rng.uniform(0.1, 40, (30, 40)).astype(np.float32)
        for offset in (0, 0.5):
            cal = calibration(pixelCenterOffset=offset)
            with self.subTest(offset=offset):
                actual = Geometry(cal).radial_ranges(depth)
                expected = measurement.radial_ranges(depth, cal)
                np.testing.assert_allclose(actual, expected, rtol=5e-15, atol=0)

    def test_declared_half_pixel_is_added_to_both_axes(self):
        cal = calibration((3, 3), fx=2, fy=4, cx=0.5, cy=0.5)
        ranges = Geometry(cal).radial_ranges(np.full((3, 3), 3.0))
        self.assertEqual(ranges[0, 0], 3)
        self.assertEqual(ranges[2, 2], 4.5)

    def test_bearing_matches_reference_for_asymmetric_mask_and_empty_mask(self):
        mask = np.zeros((30, 40), bool)
        mask[3:12, 4:9] = True
        mask[18, 22] = True
        box = [1.3, 2.7, 28.1, 26.4]
        for offset in (0, 0.5):
            cal = calibration(pixelCenterOffset=offset)
            geometry = Geometry(cal)
            for region in (mask, np.zeros_like(mask)):
                actual = geometry.bearing(box, region)
                expected = measurement.bearing(box, region, cal)
                for key in ("azimuthDeg", "elevationDeg"):
                    self.assertAlmostEqual(actual.pop(key), expected.pop(key), places=12)
                self.assertEqual(actual, expected)

    def test_bearing_axis_signs_and_empty_mask_midpoint_are_explicit(self):
        cal = calibration((5, 5), fx=2, fy=3, cx=2.5, cy=2.5)
        mask = np.zeros((5, 5), bool)
        mask[2, 2] = True
        geometry = Geometry(cal)
        center = geometry.bearing([0, 0, 5, 5], mask)
        self.assertEqual(center["pixel"], [2.5, 2.5])
        self.assertEqual(center["azimuthDeg"], 0)
        self.assertEqual(center["elevationDeg"], 0)
        mask[2, 2], mask[0, 4] = False, True
        upper_right = geometry.bearing([0, 0, 5, 5], mask)
        self.assertGreater(upper_right["azimuthDeg"], 0)
        self.assertGreater(upper_right["elevationDeg"], 0)
        empty = geometry.bearing([1, 0, 5, 4], np.zeros_like(mask))
        self.assertEqual(empty["pixel"], [3, 2])  # No additional +0.5 for an xyxy midpoint.
        self.assertEqual(empty["source"], "box midpoint")

    def test_raw_calibration_preserves_declared_half_pixel_and_discards_metadata(self):
        cal = calibration()
        del cal["pixelCenterOffset"]
        cal["baseline_m"] = cal.pop("baselineM")
        cal["pixel_coordinates"] = "u=column+0.5,v=row+0.5; top-left origin"
        cal["evaluatorTruth"] = [1, 2, 3]
        geometry = Geometry(cal)
        self.assertEqual(geometry.calibration["pixelCenterOffset"], 0.5)
        self.assertEqual(geometry.calibration["baselineM"], 0.24)
        self.assertNotIn("evaluatorTruth", geometry.calibration)
        self.assertIn("baseline_m", cal)

    def test_calibration_and_aligned_shapes_are_checked(self):
        for changes in ({"fx": 0}, {"fy": math.inf}, {"baselineM": -1}, {"width": 0},
                        {"height": 2.2}, {"cx": 100}, {"pixelCenterOffset": 0.25},
                        {"rectified": False}, {"distortion": [0, 0.1]},
                        {"pixel_coordinates": "u=column,v=row; top-left origin"}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                Geometry(calibration(**changes))
        geometry = Geometry(calibration())
        with self.assertRaisesRegex(ValueError, "dimensions"):
            geometry.radial_ranges(np.ones((31, 40)))
        with self.assertRaisesRegex(ValueError, "dimensions"):
            geometry.bearing([0, 0, 4, 4], np.ones((20, 30), bool))

    def test_cached_calibration_is_detached_from_caller(self):
        cal = calibration()
        geometry = Geometry(cal)
        depth = np.ones((30, 40))
        before = geometry.radial_ranges(depth)
        cal["fx"] = 1
        np.testing.assert_array_equal(geometry.radial_ranges(depth), before)


class MaskMedianTests(unittest.TestCase):
    def test_matches_old_summary_after_box_and_mask_intersection(self):
        cal = calibration()
        depth = np.linspace(1, 15, 1200).reshape(30, 40)
        mask = np.ones(depth.shape, bool)
        mask[10:15, 12:20] = False
        valid = np.ones_like(mask)
        valid[0:8] = False
        box = [8.2, 4.5, 26.1, 23.4]
        region = mask & measurement.box_region(box, depth.shape)
        expected = measurement.summarize(measurement.radial_ranges(depth, cal), valid, region)
        actual = mask_median(depth, valid, box, mask, cal, Geometry(cal))
        self.assertEqual(actual.keys(), expected.keys())
        for key in actual:
            if isinstance(actual[key], (int, float, list)):
                np.testing.assert_allclose(actual[key], expected[key], rtol=5e-15, atol=0)
            else:
                self.assertEqual(actual[key], expected[key])

    def test_median_does_not_select_the_nearest_cluster(self):
        cal = calibration((10, 12), fx=10000, fy=10000)
        depth = np.full((10, 12), 10.0)
        depth[0] = 2
        mask = np.ones_like(depth, bool)
        result = mask_median(depth, mask, [0, 0, 12, 10], mask, cal)
        self.assertEqual(result["status"], "measured")
        self.assertAlmostEqual(result["estimateM"], 10, places=5)
        self.assertEqual(result["supportPixels"], 120)
        self.assertIsNone(result["cluster"])

    def test_exact_minimum_pixel_and_coverage_thresholds_are_preserved(self):
        cal = calibration((11, 12))
        depth = np.full((11, 12), 8.0)
        mask = np.zeros_like(depth, bool)
        mask[:10] = True
        valid = np.zeros_like(mask)
        valid[0] = True
        args = (depth, valid, [0, 0, 12, 11], mask, cal)
        result = mask_median(*args)
        self.assertEqual(result["status"], "measured")
        self.assertEqual(result["validCoverage"], 0.1)
        valid[0, 0] = False
        self.assertEqual(mask_median(*args)["unknownReason"], "insufficient-valid-pixels")
        valid[0, 0] = True
        mask[10, 0] = True
        self.assertEqual(mask_median(*args)["unknownReason"], "insufficient-valid-coverage")

    def test_missing_or_outside_mask_is_unknown_without_bbox_fallback(self):
        cal = calibration()
        depth = np.full((30, 40), 8.0)
        valid = np.ones_like(depth, bool)
        mask = np.zeros_like(valid)
        for box in ([0, 0, 40, 30], [100, 100, 105, 105]):
            result = mask_median(depth, valid, box, mask, cal)
            self.assertEqual(result["unknownReason"], "empty-region")
            self.assertIsNone(result["estimateM"])
        mask[:5, :5] = True
        self.assertEqual(mask_median(depth, valid, [10, 10, 20, 20], mask, cal)["regionPixels"], 0)

    def test_nonfinite_nonpositive_and_invalid_depth_never_supply_support(self):
        cal = calibration()
        depth = np.full((30, 40), np.nan)
        depth[:5], depth[5:10], depth[10:15], depth[15:20], depth[20:] = np.inf, -1, 0, 8, 3
        valid = np.ones_like(depth, bool)
        valid[20:] = False
        result = mask_median(depth, valid, [0, 0, 40, 30], np.ones_like(valid), cal)
        self.assertEqual(result["supportPixels"], 200)
        self.assertEqual(result["validPixels"], 200)
        self.assertEqual(result["status"], "measured")
        depth[15:20] = np.nan
        result = mask_median(depth, valid, [0, 0, 40, 30], np.ones_like(valid), cal)
        self.assertEqual(result["supportPixels"], 0)
        self.assertIsNone(result["diagnosticSelectedQuantilesM"])

    def test_mask_alignment_bad_box_and_stale_cached_calibration_are_rejected(self):
        cal = calibration()
        depth = np.ones((30, 40))
        valid = np.ones_like(depth, bool)
        with self.assertRaisesRegex(ValueError, "align"):
            mask_median(depth, valid, [0, 0, 40, 30], np.ones((30, 39), bool), cal)
        with self.assertRaisesRegex(ValueError, "four finite"):
            mask_median(depth, valid, [0, math.nan, 40, 30], valid, cal)
        with self.assertRaisesRegex(ValueError, "calibration differ"):
            mask_median(depth, valid, [0, 0, 40, 30], valid, {**cal, "fx": 140}, Geometry(cal))


class StereoTests(unittest.TestCase):
    def assert_same_stereo(self, actual, expected):
        self.assertEqual(actual.keys(), expected.keys())
        for key, value in expected.items():
            if key in ("initializationMs", "estimateMs"):
                self.assertGreaterEqual(actual[key], 0)
                self.assertTrue(math.isfinite(actual[key]))
            elif key == "invalidMasks":
                self.assertEqual(actual[key].keys(), value.keys())
                for reason in value:
                    np.testing.assert_array_equal(actual[key][reason], value[reason])
            else:
                self.assertEqual(actual[key].dtype, value.dtype)
                np.testing.assert_array_equal(actual[key], value)

    def test_frozen_stereo_is_exact_across_reuse_shape_and_calibration_changes(self):
        stereo = CachedStereo()
        fixtures = [stereo_fixture(), stereo_fixture(shift=23, seed=2, occlusion=True),
                    stereo_fixture((120, 320), shift=7, seed=3), stereo_fixture()]
        for index, (left, right) in enumerate(fixtures):
            with self.subTest(index=index):
                cal = calibration(left.shape, fx=301.7, fy=199.3, doffsPx=1.25 if index % 2 else 0)
                expected = matching.estimate(left, right, cal)
                actual = stereo.estimate(left, right, cal)
                self.assertGreater(int(actual["valid"].sum()), 100)
                self.assert_same_stereo(actual, expected)
                # A second acquisition also proves matcher reuse cannot retain stale outputs.
                self.assert_same_stereo(stereo.estimate(left, right, cal), expected)

    def test_flat_images_remain_invalid_low_texture(self):
        left = np.full((96, 320), 127, np.uint8)
        cal = calibration(left.shape)
        actual = CachedStereo().estimate(left, left, cal)
        self.assert_same_stereo(actual, matching.estimate(left, left, cal))
        self.assertFalse(actual["valid"].any())
        self.assertTrue(actual["invalidMasks"]["lowTexture"].all())

    def test_nonpositive_disparity_denominator_preserves_nan_and_invalid_status(self):
        left, right = stereo_fixture()
        cal = calibration(left.shape, doffsPx=-200)
        actual = CachedStereo().estimate(left, right, cal)
        self.assert_same_stereo(actual, matching.estimate(left, right, cal))
        self.assertTrue(np.isnan(actual["depth"]).all())
        self.assertFalse(actual["valid"].any())
        self.assertFalse(actual["rawValid"].any())

    def test_repeated_calls_do_not_mutate_previous_results_or_input(self):
        left, right = stereo_fixture()
        old_left, old_right = left.copy(), right.copy()
        cal = calibration(left.shape)
        stereo = CachedStereo()
        previous = stereo.estimate(left, right, cal)
        depth, raw, valid = (previous[name].copy() for name in ("depth", "rawLeft", "valid"))
        changed_left, changed_right = stereo_fixture(seed=20)
        stereo.estimate(changed_left, changed_right, cal)
        for name, expected in (("depth", depth), ("rawLeft", raw), ("valid", valid)):
            np.testing.assert_array_equal(previous[name], expected)
        np.testing.assert_array_equal(left, old_left)
        np.testing.assert_array_equal(right, old_right)

    def test_invalid_stereo_shapes_are_rejected(self):
        stereo = CachedStereo()
        for left, right in ((np.zeros((20, 30)), np.zeros((21, 30))),
                            (np.zeros((20, 30, 3)), np.zeros((20, 30, 3)))):
            with self.assertRaisesRegex(ValueError, "grayscale"):
                stereo.estimate(left, right, calibration())


if __name__ == "__main__":
    unittest.main()

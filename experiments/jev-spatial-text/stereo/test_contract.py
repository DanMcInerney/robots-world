"""Executable S08/mechanical boundary tests; no Jev or external network."""
import unittest

import cv2
import numpy as np

from matching import depthai_quality_fixture, depth_from_disparity, distance_bin, fixed_point_disparity, make_regions


class StereoContract(unittest.TestCase):
    def test_fixed_point_and_nonzero_minimum_sentinel(self):
        disparity, valid = fixed_point_disparity(np.array([-16, 0, 16, 160], np.int16))
        np.testing.assert_array_equal(disparity, [-1, 0, 1, 10])
        np.testing.assert_array_equal(valid, [False, True, True, True])
        _, valid = fixed_point_disparity(np.array([0, 32, 48, 64], np.int16), 3)
        np.testing.assert_array_equal(valid, [False, False, True, True])

    def test_calibration_offsets_baseline_units_and_invalid_denominator(self):
        calibration = {"fx": 400, "baselineM": .06, "doffsPx": 2}
        depth = depth_from_disparity(np.array([-3, -2, 0, 10], np.float32), calibration)
        self.assertTrue(np.isnan(depth[0]) and np.isnan(depth[1]))
        np.testing.assert_array_equal(depth[2:], [12, 2])

    def test_depthai_zero_and_opposite_quality_direction(self):
        depth, valid, quality = depthai_quality_fixture([0, 1000, 2000], [0, 127.5, 255])
        self.assertTrue(np.isnan(depth[0]))
        np.testing.assert_array_equal(valid, [False, True, True])
        np.testing.assert_allclose(quality, [1, .5, 0])

    def test_unknown_is_not_far_or_clear(self):
        self.assertEqual(distance_bin(None), "unknown")
        self.assertEqual(distance_bin([1.4, 1.6]), "boundary")
        self.assertEqual(distance_bin([1.5, 2.99]), "mid")
        self.assertEqual(distance_bin([3, 4]), "far")
        shape = (20, 90)
        result = dict(depth=np.ones(shape, np.float32), valid=np.zeros(shape, bool), invalidMasks={"lowTexture": np.ones(shape, bool)})
        regions = make_regions(result, dict(fx=400, baselineM=.06, cx=45))
        self.assertEqual(len(regions), 9)
        self.assertTrue(all(x["depthBin"] == "unknown" and not x["wholeSectorClearCertified"] for x in regions))

    def test_isolated_depth_speckle_does_not_replace_supported_wall(self):
        shape = (20, 90)
        depth = np.full(shape, 4, np.float32)
        depth[10,45] = 1
        result = dict(depth=depth, valid=np.ones(shape, bool), invalidMasks={})
        regions = make_regions(result, dict(fx=400, baselineM=.06, cx=45))
        self.assertEqual(regions[4]["depthBin"], "far")
        self.assertLess(regions[4]["nearestSupportedCluster"]["pixels"], 200)

    def test_connected_thin_near_return_survives_robust_summary(self):
        shape = (20, 90)
        depth = np.full(shape, 4, np.float32)
        depth[:,45] = 1
        result = dict(depth=depth, valid=np.ones(shape, bool), invalidMasks={})
        regions = make_regions(result, dict(fx=400, baselineM=.06, cx=45))
        self.assertEqual(regions[4]["depthBin"], "near")
        self.assertEqual(regions[4]["nearestSupportedCluster"]["pixels"], 20)


if __name__ == "__main__":
    unittest.main(verbosity=2)

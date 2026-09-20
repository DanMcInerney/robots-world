"""Deterministic tests of real BoT-SORT; no neural-model execution/downloads."""
import unittest

import numpy as np

from tracker import TargetBinding, Tracker


def fixture(boxes, confidences=None):
    confidences = confidences or [0.9] * len(boxes)
    detections = [{"detectionId": f"detection-{i:03d}", "classId": 2,
        "className": "car", "confidence": c, "boxXyxy": list(box),
        "blueCarCandidate": True, "maskAvailable": True}
        for i, (box, c) in enumerate(zip(boxes, confidences))]
    masks = np.zeros((len(boxes), 120, 160), bool)
    for mask, (x0, y0, x1, y1) in zip(masks, boxes):
        mask[y0:y1, x0:x1] = True
    # Fixed visual features exercise the actual sparse-flow GMC path on CPU.
    image = np.random.default_rng(81).integers(0, 256, (120, 160, 3), dtype=np.uint8)
    return detections, masks, image


class TrackerTests(unittest.TestCase):
    def test_current_box_and_mask_stay_measured_after_motion(self):
        tracker = Tracker()
        first, _, _ = tracker.update(*fixture([(20, 20, 50, 50)]))
        source = fixture([(24, 21, 55, 52)])
        observed, masks, info = tracker.update(*source)
        self.assertEqual(observed[0]["trackId"], first[0]["trackId"])
        self.assertEqual(observed[0]["boxXyxy"], source[0][0]["boxXyxy"])
        np.testing.assert_array_equal(masks, source[1])
        self.assertTrue(observed[0]["measured"])
        self.assertEqual(info["predictedMeasurementsReturned"], 0)

    def test_missing_frame_reports_lost_without_synthetic_measurement(self):
        tracker = Tracker()
        first, _, _ = tracker.update(*fixture([(20, 20, 50, 50)]))
        rows, masks, info = tracker.update(*fixture([]))
        self.assertEqual(rows, [])
        self.assertEqual(masks.shape, (0, 120, 160))
        self.assertEqual(info["lostTrackIds"], [first[0]["trackId"]])
        returned, _, _ = tracker.update(*fixture([(21, 20, 51, 50)]))
        self.assertEqual(returned[0]["trackId"], first[0]["trackId"])

    def test_low_confidence_association_preserves_full_input_index(self):
        tracker = Tracker()
        first, _, _ = tracker.update(*fixture([(20, 20, 50, 50)]))
        rows, masks, _ = tracker.update(*fixture([(105, 20, 135, 50), (21, 20, 51, 50)], [0.9, 0.15]))
        self.assertEqual(rows[1]["trackId"], first[0]["trackId"])
        self.assertIsNone(rows[0]["trackId"])
        self.assertTrue(masks[1, 25, 25])
        self.assertFalse(masks[1, 25, 110])

    def test_route_reset_clears_lost_state_and_first_frame_ids(self):
        tracker = Tracker()
        first, _, _ = tracker.update(*fixture([(20, 20, 50, 50)]))
        tracker.update(*fixture([]))
        tracker.reset()
        current, _, info = tracker.update(*fixture([(100, 20, 130, 50)]))
        self.assertEqual(current[0]["trackId"], first[0]["trackId"])
        self.assertEqual(info["frameIndex"], 1)
        self.assertEqual(info["lostTrackIds"], [])

    def test_separate_instances_do_not_consume_each_others_ids(self):
        left, right = Tracker(), Tracker()
        a, _, _ = left.update(*fixture([(20, 20, 50, 50)]))
        b, _, _ = right.update(*fixture([(90, 20, 120, 50)]))
        self.assertEqual(a[0]["trackId"], b[0]["trackId"])
        right.reset()
        a2, _, _ = left.update(*fixture([(21, 20, 51, 50), (100, 20, 130, 50)]))
        self.assertEqual(a2[0]["trackId"], a[0]["trackId"])
        a3, _, _ = left.update(*fixture([(22, 20, 52, 50), (101, 20, 131, 50)]))
        self.assertNotEqual(a3[0]["trackId"], a3[1]["trackId"])

    def test_invalid_mask_alignment_fails(self):
        source = fixture([(20, 20, 50, 50)])
        with self.assertRaises(ValueError):
            Tracker().update(source[0], source[1][:, :-1], source[2])


class BindingTests(unittest.TestCase):
    @staticmethod
    def detection(track_id, name="one", measured=True):
        return {"trackId": track_id, "detectionId": name,
                "blueCarCandidate": True, "measured": measured}

    def test_initial_ambiguity_abstains(self):
        binding = TargetBinding()
        state = binding.update([self.detection(1), self.detection(2, "two")])
        self.assertEqual(state["status"], "ambiguous")
        self.assertIsNone(state["boundTrackId"])

    def test_hold_bound_id_during_ambiguity_and_abstain_when_lost(self):
        binding = TargetBinding()
        self.assertEqual(binding.update([self.detection(1)])["status"], "acquired")
        state = binding.update([self.detection(2, "lookalike"), self.detection(1, "original")])
        self.assertEqual(state["selectedDetectionId"], "original")
        state = binding.update([self.detection(2, "lookalike")])
        self.assertEqual(state["status"], "lost")
        self.assertEqual(state["boundTrackId"], 1)
        self.assertIsNone(state["selectedDetectionId"])

    def test_untracked_or_predicted_candidates_cannot_bind(self):
        binding = TargetBinding()
        self.assertEqual(binding.update([self.detection(None)])["status"], "untracked")
        self.assertEqual(binding.update([self.detection(1, measured=False)])["status"], "missing")

    def test_expired_real_track_never_substitutes(self):
        tracker, binding = Tracker(), TargetBinding()
        rows, _, _ = tracker.update(*fixture([(20, 20, 50, 50)]))
        original = binding.update(rows)["boundTrackId"]
        for _ in range(32):
            rows, _, _ = tracker.update(*fixture([]))
            binding.update(rows)
        for _ in range(2):
            rows, _, _ = tracker.update(*fixture([(100, 20, 130, 50)]))
            state = binding.update(rows)
        self.assertNotEqual(rows[0]["trackId"], original)
        self.assertEqual(state["boundTrackId"], original)
        self.assertEqual(state["status"], "lost")
        binding.reset()
        self.assertEqual(binding.update(rows)["status"], "acquired")


if __name__ == "__main__":
    unittest.main()

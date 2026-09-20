"""Small independent fixtures keep truth, detector recall and selection distinct."""
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from evaluate import (aggregate, analyze, indexed, load_arms, score_record,
                      summarize_arm, tracking_summary, verify_sealed_file, web_path)


REFERENCE = {"visibleBox": [0, 0, 10, 10], "visiblePixels": 100, "medianVisibleRangeM": 10}


def detection(identity="target", box=None, estimate=10, status="measured"):
    return {"detectionId": identity, "boxXyxy": box or [0, 0, 10, 10], "blueCarCandidate": True,
            "arms": {"maskMedian": {"status": status, "estimateM": estimate}}}


def record(identity="frame", detections=None, selected="target", status="single"):
    return {"id": identity, "detections": [detection()] if detections is None else detections,
            "selectedDetectionId": selected, "selectionStatus": status, "input": {}}


def scored(value, reference=None, frame_index=0, route="route"):
    reference = reference or REFERENCE
    return {**score_record(value, reference, "maskMedian"), "evaluator": reference,
            "family": "fixture", "split": "confirmation", "routeId": route, "frameIndex": frame_index}


class EvaluationTests(unittest.TestCase):
    @unittest.skipUnless(os.name == 'nt', 'Windows extended-path alias fixture')
    def test_replay_link_accepts_existing_windows_extended_path(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            artifact = root / 'arrays' / 'mask.npz'
            artifact.parent.mkdir()
            artifact.write_bytes(b'preserved mask')
            self.assertEqual(web_path('\\\\?\\' + str(artifact.resolve()), root, root), 'arrays/mask.npz')

    def test_wrong_selection_and_unknowns_remain_in_fixed_population(self):
        rows = [scored(record("correct")),
                scored(record("wrong", [detection("lookalike", [30, 30, 40, 40], 14)], "lookalike")),
                scored(record("missing", [], None, "missing")),
                scored(record("ambiguous", [detection(), detection("lookalike", [30, 30, 40, 40])], None, "ambiguous")),
                scored(record("depth-unknown", [detection(estimate=None, status="unknown")]))]
        result = aggregate(rows)
        self.assertEqual(result["frames"], 5)
        self.assertEqual(result["acceptedRanges"], 2)
        self.assertEqual(result["acceptedWrongAssociations"], 1)
        self.assertEqual(result["correctUsableRanges"], 1)
        self.assertEqual(result["unknownRanges"], 3)
        self.assertEqual(result["errorDenominator"], 2)
        self.assertEqual(result["meanAbsoluteErrorM"], 2)
        self.assertAlmostEqual(result["p95AbsoluteErrorM"], 3.8)
        self.assertEqual(result["absoluteErrorsOver2M"], 1)
        self.assertEqual(result["falseFarOver2M"], 1)
        self.assertEqual(result["detectorRecall"], .6)
        self.assertEqual(result["ambiguousCandidateFrames"], 1)

    def test_raw_detector_recall_independent_of_selection_and_depth(self):
        candidates = [detection(estimate=None, status="unknown"), detection("wrong", [30, 30, 40, 40], 7)]
        row = scored(record(detections=candidates, selected="wrong", status="observed"))
        self.assertTrue(row["grade"]["detectorCorrectCandidate"])
        self.assertFalse(row["grade"]["associationCorrect"])
        self.assertTrue(row["grade"]["falseNearOver2M"])
        ambiguous = scored(record(detections=candidates, selected=None, status="ambiguous"))
        self.assertTrue(ambiguous["grade"]["detectorCorrectCandidate"])
        self.assertFalse(ambiguous["grade"]["accepted"])

    def test_partial_box_below_threshold_counts_as_wrong(self):
        result = aggregate([scored(record(detections=[detection(box=[0, 0, 4, 10])]))])
        self.assertEqual(result["acceptedWrongAssociations"], 1)
        self.assertEqual(result["correctUsableRanges"], 0)
        self.assertEqual(result["meanAbsoluteErrorM"], 0)
        self.assertEqual(result["detectorRecall"], 0)

    def test_unknown_reference_does_not_invent_zero_error(self):
        ref = {"visiblePixels": 0, "visibleBox": None, "medianVisibleRangeM": None}
        result = aggregate([scored(record(), ref)])
        self.assertEqual(result["acceptedRanges"], 1)
        self.assertEqual(result["acceptedWrongAssociations"], 1)
        self.assertEqual(result["acceptedWithoutReferenceRange"], 1)
        self.assertEqual(result["errorDenominator"], 0)
        self.assertIsNone(result["meanAbsoluteErrorM"])
        self.assertIsNone(result["detectorRecall"])

    def test_range_bands_partition_boundaries_without_losing_unknowns(self):
        frames = [scored(record(str(index)), {**REFERENCE, "medianVisibleRangeM": value})
                  for index, value in enumerate((7.9, 8, 12, 12.1, None))]
        bands = summarize_arm(frames)["rangeBands"]["oldConfirmation400"]
        self.assertEqual([bands[key]["frames"] for key in ("below8M", "8To12M", "above12M", "unknownReference")], [1, 2, 1, 1])

    def test_tracker_binding_and_losses_reset_at_route_boundary(self):
        frames = []
        for route, index, bound, observed in [("a", 0, 5, True), ("a", 1, 5, False),
                                             ("a", 2, 6, True), ("b", 0, 6, True)]:
            row = scored(record(selected="target" if observed else None), frame_index=index, route=route)
            row["tracking"] = {"target": {"boundTrackId": bound, "measured": observed}}
            frames.append(row)
        summary = tracking_summary(frames)
        self.assertEqual(summary["bindingAcquisitions"], 2)
        self.assertEqual(summary["boundIdChanges"], 1)
        self.assertEqual(summary["currentObservationLosses"], 1)
        self.assertEqual(summary["currentObservationFrames"], 3)

    def test_missing_or_duplicate_frame_is_an_error(self):
        with self.assertRaisesRegex(ValueError, "incomplete frame population"):
            indexed([record("a")], "test arm", {"a", "b"})
        with self.assertRaisesRegex(ValueError, "duplicate"):
            indexed([record("a"), record("a")], "test arm", {"a", "b"})

    def test_complete_arm_manifest_rejects_missing_frame_and_changed_input(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "arms/test").mkdir(parents=True)
            (root / "manifest.json").write_text(json.dumps({"expectedFrames": 2, "arms": [{"arm": "test", "status": "complete"}]}))
            originals = {"a": record("a"), "b": record("b")}
            path = root / "arms/test/results.json"
            data = {"arm": "test", "records": [record("a")], "measurementKey": "maskMedian"}
            path.write_text(json.dumps(data))
            with self.assertRaisesRegex(ValueError, "incomplete frame population"):
                load_arms(root, originals, originals)
            data["records"].append(record("b"))
            data["records"][1]["input"] = {"tampered": True}
            path.write_text(json.dumps(data))
            with self.assertRaisesRegex(ValueError, "input path/hash mismatch"):
                load_arms(root, originals, originals)

    def test_unavailable_arm_requires_explicit_reason(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            manifest = {"expectedFrames": 1, "arms": [{"arm": "unsupported", "status": "unavailable"}]}
            (root / "manifest.json").write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, "explicit reason"):
                load_arms(root, {"a"}, {})
            manifest["arms"][0]["reason"] = "Backend export failed; retained failure evidence."
            (root / "manifest.json").write_text(json.dumps(manifest))
            with patch('evaluate.verify_predictions'):
                _, arms, unavailable = load_arms(root, {"a"}, {})
            self.assertFalse(arms)
            self.assertIn("unsupported", unavailable)

    def test_invalid_selected_id_and_nonfinite_measurement_fail(self):
        with self.assertRaisesRegex(ValueError, "Selected detection absent"):
            scored(record(selected="invented"))
        with self.assertRaisesRegex(ValueError, "must be finite"):
            scored(record(detections=[detection(estimate=float("nan"))]))

    def test_existing_analysis_is_never_overwritten(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            sentinel = root / "summary.json"
            sentinel.write_text("preserved")
            with self.assertRaises(FileExistsError):
                analyze(root, root.parent / "baseline-does-not-exist")
            self.assertEqual(sentinel.read_text(), "preserved")

    def test_reference_must_match_archived_seal(self):
        with TemporaryDirectory() as folder:
            path = Path(folder) / "reference.json"
            path.write_text("changed")
            with self.assertRaisesRegex(ValueError, "changed sealed evidence"):
                verify_sealed_file(path, {"files": [{"path": str(path), "sha256": "0" * 64}]})


if __name__ == "__main__":
    unittest.main()

import unittest
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import numpy as np
from evaluate import reference, gate, iou, promotion, select_arm
from integrity import sha256, verify_manifest, verify_prediction_input


class EvaluationTests(unittest.TestCase):
    def test_radial_range_uses_renderer_pixel_centres_and_visible_pixels_only(self):
        depth = np.array([[4., 400.], [4., 400.]])
        mask = np.array([[True, False], [True, False]])
        cal = {'fx': 1, 'fy': 1, 'cx': .5, 'cy': .5,
               'pixel_coordinates': 'u=column+0.5,v=row+0.5; top-left origin'}
        measured = reference(depth, mask, cal)
        self.assertAlmostEqual(measured['medianVisibleRangeM'], (4 + 4*np.sqrt(2))/2)
        self.assertEqual(measured['nearestVisibleRangeM'], 4)
        self.assertEqual(measured['visiblePixels'], 2)

    def test_gate_rejects_abstention_and_wrong_identity_even_with_perfect_returned_ranges(self):
        summary = {'frames': 100, 'correctAssociations': 100, 'correctUsableRanges': 1,
                   'p95AbsoluteErrorM': 0, 'acceptedWrongAssociations': 0,
                   'falseFarOver2M': 0, 'falseNearOver2M': 0}
        self.assertFalse(gate(summary, 30)['pass'])
        summary['correctUsableRanges'] = 100
        self.assertTrue(gate(summary, 30)['pass'])
        summary['acceptedWrongAssociations'] = 1
        self.assertFalse(gate(summary, 30)['pass'])
        self.assertEqual(iou([0, 0, 4, 4], [8, 8, 12, 12]), 0)

    def test_promotion_rejects_stress_route_coverage_loss_and_keeps_box_fallback(self):
        box = {'frames': 400, 'correctUsableRanges': 400,
               'meanAbsoluteErrorM': .5, 'meanSelectedBackgroundFraction': .8}
        mask = {**box, 'correctUsableRanges': 100, 'meanAbsoluteErrorM': .1,
                'meanSelectedBackgroundFraction': .1}
        result = promotion(box, mask, True)
        self.assertFalse(result['pass'])
        self.assertFalse(result['coverageWithinFivePercentagePoints'])
        self.assertEqual(select_arm({'bbox': {'pass': True}}, result), 'bbox')
        self.assertIsNone(select_arm({'bbox': {'pass': False}}, result))
        with self.assertRaises(ValueError):
            promotion({**box, 'frames': 100}, mask, True)

    def test_promotion_recognizes_background_improvement_with_equal_error(self):
        box = {'frames': 400, 'correctUsableRanges': 400,
               'meanAbsoluteErrorM': .5, 'meanSelectedBackgroundFraction': .8}
        mask = {**box, 'correctUsableRanges': 380, 'meanSelectedBackgroundFraction': .1}
        result = promotion(box, mask, True)
        self.assertTrue(result['pass'])
        self.assertFalse(result['lowerMAE'])
        self.assertEqual(select_arm({'bbox': {'pass': True}}, result), 'mask')
        self.assertFalse(promotion(box, {**mask, 'correctUsableRanges': 379}, True)['pass'])
        self.assertFalse(promotion(box, mask, False)['pass'])

    def test_seals_reject_changed_dependency_trajectory_prediction_and_handoff(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            for name in ['world-core.ts', 'trajectory.json', 'measurements.npz', 'perception-handoff.json']:
                with self.subTest(name=name):
                    evidence = root / name
                    evidence.write_bytes(b'original evidence')
                    manifest = root / 'seal.json'
                    manifest.write_text(json.dumps({'files': [{'path': str(evidence), 'sha256': sha256(evidence)}]}))
                    verify_manifest(manifest)
                    evidence.write_bytes(b'changed evidence')
                    with self.assertRaisesRegex(ValueError, 'Frozen evidence changed'):
                        verify_manifest(manifest)

    def test_join_rejects_wrong_id_path_or_input_bytes(self):
        with TemporaryDirectory() as folder:
            sample, prediction = {'id': 'frame-1'}, {'id': 'frame-1', 'input': {}}
            for key in ['leftPath', 'rightPath', 'calibrationPath']:
                path = Path(folder) / key
                path.write_bytes(key.encode())
                sample[key] = str(path)
                prediction['input'][key] = {'path': str(path), 'sha256': sha256(path)}
            verify_prediction_input(sample, prediction)
            with self.assertRaisesRegex(ValueError, 'identity mismatch'):
                verify_prediction_input(sample, {**prediction, 'id': 'frame-2'})
            original = prediction['input']['leftPath']['path']
            prediction['input']['leftPath']['path'] = sample['rightPath']
            with self.assertRaisesRegex(ValueError, 'frozen input'):
                verify_prediction_input(sample, prediction)
            prediction['input']['leftPath']['path'] = original
            Path(sample['leftPath']).write_bytes(b'changed image')
            with self.assertRaisesRegex(ValueError, 'frozen input'):
                verify_prediction_input(sample, prediction)


if __name__ == '__main__':
    unittest.main()

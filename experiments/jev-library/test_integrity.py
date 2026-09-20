"""CPU-only regression fixtures for the independent preflight evidence finding."""
import copy
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from integrity import (ARMS, amend_source, context, entry, read, save_new, seal_analysis, seal_arm,
                       seal_ffs, seal_predictions, verify_analysis, verify_arm,
                       verify_ffs, verify_predictions)
from evaluate import load_arms


class IntegrityTests(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.baseline = self.root / 'archived'
        self.baseline.mkdir()
        for name in ('input-freeze.json', 'prediction-seal.json', 'analysis-seal.json'):
            save_new(self.baseline / name, {'files': []})
        self.raw = self.baseline / 'raw.npz'
        self.raw.write_bytes(b'original arrays')
        save_new(self.root / 'perception-inputs.json', {'samples': [{'id': 'frame'}]})
        source = self.root / 'integrity.py'
        source.write_text('frozen source')
        save_new(self.root / 'source-freeze.json', {
            'files': [entry(source)], 'baselineRoot': str(self.baseline),
            'baseline': {key: entry(self.baseline / name)['sha256'] for name, key in (
                ('input-freeze.json', 'inputSealSha256'), ('prediction-seal.json', 'predictionSealSha256'),
                ('analysis-seal.json', 'analysisSealSha256'))},
            'perceptionInputs': entry(self.root / 'perception-inputs.json')})
        self.originals = {'frame': {'id': 'frame', 'input': {'calibrationPath': {'sha256': 'a' * 64}},
            'calibration': {'fx': 100}, 'detections': [{'detectionId': 'd0', 'boxXyxy': [0, 0, 10, 10]}],
            'artifacts': {'rawMeasurements': str(self.raw)}}}

    def arm(self, mode='detector', arm='yolo26'):
        result = self.root / 'arms' / arm / 'results.json'
        row = copy.deepcopy(self.originals['frame'])
        row['artifacts'] = dict.fromkeys(('baselineMeasurements', 'detectorMasks', 'stereoMeasurements'), str(self.raw))
        row['selectedDetectionId'], row['selectionStatus'] = 'd0', 'single'
        if mode == 'detector':
            mask = result.parent / 'arrays/frame.npz'
            mask.parent.mkdir(parents=True)
            mask.write_bytes(b'new detector mask bytes')
            row['artifacts']['detectorMasks'] = str(mask)
        metadata = {'mode': mode, 'provenance': context(self.root),
                    'detector': {'checkpointSha256': 'b' * 64}}
        data = {'arm': arm, 'metadata': metadata, 'records': [row], 'measurementKey': 'maskMedian'}
        save_new(result, data)
        save_new(result.parent / 'started.json', metadata)
        save_new(result.parent / 'records/frame.json', row)
        return result

    def manifest(self, complete=()):
        save_new(self.root / 'manifest.json', {'expectedFrames': 1, 'arms': [
            {'arm': arm, 'status': 'complete' if arm in complete else 'unavailable',
             'reason': 'Fixture backend unavailable'} for arm in ARMS]})

    def mutate_json(self, path, update):
        import json
        value = read(path)
        update(value)
        path.write_text(json.dumps(value))

    def ffs(self):
        index = self.root / 'ffs/scored/index.json'
        arrays = index.parent / 'arrays/frame.npz'
        arrays.parent.mkdir(parents=True)
        arrays.write_bytes(b'learned depth bytes')
        row = {key: copy.deepcopy(self.originals['frame'][key]) for key in ('id', 'input', 'calibration')}
        row.update(arraysPath=str(arrays), arraysSha256=entry(arrays)['sha256'])
        manifest = self.root / 'perception-inputs.json'
        save_new(index, {'records': [row], 'metadata': {'checkpointSha256': 'c' * 64},
                         'manifestPath': str(manifest), 'manifestSha256': entry(manifest)['sha256']})
        (index.parent / 'progress.jsonl').write_text('progress preserved')
        return index

    def test_complete_arm_roundtrip_and_exclusive_completion(self):
        result = self.arm()
        seal_arm(self.root, result, self.originals)
        self.assertEqual(verify_arm(self.root, result, self.originals)['arm'], 'yolo26')
        with self.assertRaises(FileExistsError):
            seal_arm(self.root, result, self.originals)

    def test_evaluator_rejects_missing_completion(self):
        self.arm()
        self.manifest(['yolo26'])
        with self.assertRaisesRegex(ValueError, 'Missing completion'):
            load_arms(self.root, self.originals, self.originals)

    def test_evaluator_rejects_old_invalid_completion_hash(self):
        result = self.arm()
        save_new(result.parent / 'complete.json', {'resultsSha256': '0' * 64})
        self.manifest(['yolo26'])
        with self.assertRaisesRegex(ValueError, 'provenance mismatch'):
            load_arms(self.root, self.originals, self.originals)

    def test_changed_result_bytes_rejected(self):
        result = self.arm()
        seal_arm(self.root, result, self.originals)
        with result.open('a') as stream:
            stream.write(' ')
        with self.assertRaisesRegex(ValueError, 'changed sealed evidence'):
            verify_arm(self.root, result, self.originals)

    def test_changed_mask_bytes_rejected(self):
        result = self.arm()
        seal_arm(self.root, result, self.originals)
        (result.parent / 'arrays/frame.npz').write_bytes(b'changed mask, same frame ID')
        with self.assertRaisesRegex(ValueError, 'changed sealed evidence'):
            verify_arm(self.root, result, self.originals)

    def test_missing_mask_rejected_by_evaluator(self):
        result = self.arm()
        seal_arm(self.root, result, self.originals)
        (result.parent / 'arrays/frame.npz').unlink()
        self.manifest(['yolo26'])
        with self.assertRaisesRegex(ValueError, 'Missing or changed'):
            load_arms(self.root, self.originals, self.originals)

    def test_missing_record_rejected(self):
        result = self.arm()
        seal_arm(self.root, result, self.originals)
        (result.parent / 'records/frame.json').unlink()
        with self.assertRaisesRegex(ValueError, 'Missing or changed'):
            verify_arm(self.root, result, self.originals)

    def test_cached_detection_cannot_be_substituted_under_same_id(self):
        result = self.arm('cached', 'mask_median')
        self.mutate_json(result, lambda data: data['records'][0]['detections'][0].update(boxXyxy=[20, 20, 30, 30]))
        with self.assertRaisesRegex(ValueError, 'Substituted detection'):
            seal_arm(self.root, result, self.originals)

    def test_artifact_cannot_be_substituted_under_same_id(self):
        result = self.arm('cached', 'mask_median')
        self.mutate_json(result, lambda data: data['records'][0]['artifacts'].update(detectorMasks='other.npz'))
        with self.assertRaisesRegex(ValueError, 'Substituted artifact'):
            seal_arm(self.root, result, self.originals)

    def test_ffs_seal_preserves_and_checks_calibration_input_array_hashes(self):
        index = self.ffs()
        seal_ffs(self.root, index, self.originals)
        self.assertEqual(verify_ffs(self.root, index, self.originals)['records'][0]['calibration'], {'fx': 100})
        (index.parent / 'arrays/frame.npz').write_bytes(b'changed depth')
        with self.assertRaisesRegex(ValueError, 'changed sealed evidence'):
            verify_ffs(self.root, index, self.originals)

    def test_ffs_calibration_mismatch_rejected(self):
        index = self.ffs()
        self.mutate_json(index, lambda data: data['records'][0]['calibration'].update(fx=200))
        with self.assertRaisesRegex(ValueError, 'calibration provenance mismatch'):
            seal_ffs(self.root, index, self.originals)

    def test_combined_join_requires_exact_sealed_detector_masks(self):
        detector = self.arm()
        seal_arm(self.root, detector, self.originals)
        stereo = self.ffs()
        seal_ffs(self.root, stereo, self.originals)
        combined = self.arm('combined', 'combined_yolo26_ffs_tracking')
        def join(data):
            data['metadata'].update(detectionIndex=entry(detector), stereoIndex=entry(stereo))
            data['records'][0]['artifacts'].update(
                detectorMasks=str(detector.parent / 'arrays/frame.npz'),
                stereoMeasurements=str(stereo.parent / 'arrays/frame.npz'))
        self.mutate_json(combined, join)
        row_path = combined.parent / 'records/frame.json'
        import json
        row_path.write_text(json.dumps(read(combined)['records'][0]))
        seal_arm(self.root, combined, self.originals)
        verify_arm(self.root, combined, self.originals)
        (detector.parent / 'arrays/frame.npz').write_bytes(b'substituted mask')
        with self.assertRaisesRegex(ValueError, 'changed sealed evidence'):
            verify_arm(self.root, combined, self.originals)

    def test_root_seal_binds_ffs_raw_and_complete_arms(self):
        result = self.arm()
        seal_arm(self.root, result, self.originals)
        index = self.ffs()
        seal_ffs(self.root, index, self.originals)
        self.manifest(['yolo26'])
        seal_predictions(self.root, self.originals)
        verify_predictions(self.root, self.originals)
        (index.parent / 'arrays/frame.npz').unlink()
        with self.assertRaisesRegex(ValueError, 'Missing or changed'):
            verify_predictions(self.root, self.originals)

    def test_final_analysis_outputs_and_chain_are_sealed(self):
        self.manifest()
        seal_predictions(self.root, self.originals)
        for name in ('summary.json', 'replay.json', 'index.html'):
            (self.root / name).write_text('final output')
        seal_analysis(self.root, self.originals)
        verify_analysis(self.root, self.originals)
        (self.root / 'replay.json').write_text('changed analysis')
        with self.assertRaisesRegex(ValueError, 'changed sealed evidence'):
            verify_analysis(self.root, self.originals)

    def test_changed_source_refuses_arm_completion(self):
        result = self.arm()
        (self.root / 'integrity.py').write_text('new source')
        with self.assertRaisesRegex(ValueError, 'changed sealed evidence'):
            seal_arm(self.root, result, self.originals)

    @unittest.skipUnless(os.name == 'nt', 'Windows extended-path alias fixture')
    def test_windows_extended_path_alias_preserves_original_record(self):
        result = self.arm()
        mask = result.parent / 'arrays/frame.npz'
        alias = '\\\\?\\' + str(mask.resolve())
        self.assertTrue(Path(alias).samefile(mask))
        self.mutate_json(result, lambda data: data['records'][0]['artifacts'].update(detectorMasks=alias))
        self.mutate_json(result.parent / 'records/frame.json', lambda row: row['artifacts'].update(detectorMasks=alias))
        before = entry(result)
        seal_arm(self.root, result, self.originals)
        self.assertEqual(verify_arm(self.root, result, self.originals)['records'][0]['artifacts']['detectorMasks'], alias)
        self.assertEqual(entry(result), before)

    def test_distinct_mask_file_with_identical_bytes_is_still_substitution(self):
        result = self.arm()
        other = result.parent / 'arrays/other.npz'
        other.write_bytes((result.parent / 'arrays/frame.npz').read_bytes())
        self.mutate_json(result, lambda data: data['records'][0]['artifacts'].update(detectorMasks=str(other)))
        with self.assertRaisesRegex(ValueError, 'Substituted artifact'):
            seal_arm(self.root, result, self.originals)

    def test_append_only_amendment_preserves_old_seals_and_marks_future_arms(self):
        old = self.arm()
        seal_arm(self.root, old, self.originals)
        old_complete = entry(old.parent / 'complete.json')
        frozen = entry(self.root / 'source-freeze.json')
        (self.root / 'integrity.py').write_text('bookkeeping compatibility correction')
        amendment = amend_source(self.root, 'Windows path alias compatibility; neural settings unchanged')
        verify_arm(self.root, old, self.originals)
        self.assertEqual(entry(old.parent / 'complete.json'), old_complete)
        self.assertEqual(entry(self.root / 'source-freeze.json'), frozen)
        new = self.arm('cached', 'mask_median')
        seal_arm(self.root, new, self.originals)
        self.assertEqual(read(new)['metadata']['provenance']['sourceAmendments'], [entry(amendment)])
        verify_arm(self.root, new, self.originals)
        self.manifest(['yolo26', 'mask_median'])
        seal_predictions(self.root, self.originals)
        verify_predictions(self.root, self.originals)
        with self.assertRaisesRegex(ValueError, 'unsealed campaign'):
            amend_source(self.root, 'Cannot revise after sealing')

    def test_amendment_can_complete_existing_results_without_rewriting_them(self):
        result = self.arm()
        before = entry(result)
        (self.root / 'integrity.py').write_text('corrected seal comparison')
        amend_source(self.root, 'Completion-only compatibility correction')
        seal_arm(self.root, result, self.originals)
        verify_arm(self.root, result, self.originals)
        self.assertEqual(entry(result), before)
        self.assertNotIn('sourceAmendments', read(result)['metadata']['provenance'])

    def test_changed_amendment_or_snapshot_is_rejected(self):
        (self.root / 'integrity.py').write_text('bookkeeping correction')
        amendment = amend_source(self.root, 'Required compatibility correction')
        saved = read(amendment)
        Path(saved['changes'][0]['snapshot']['path']).write_text('changed snapshot')
        with self.assertRaisesRegex(ValueError, 'changed sealed evidence'):
            context(self.root)

    def test_amendment_refuses_non_bookkeeping_code(self):
        detector = self.root / 'detector.py'
        detector.write_text('original model settings')
        self.mutate_json(self.root / 'source-freeze.json', lambda value: value['files'].append(entry(detector)))
        detector.write_text('changed neural settings')
        with self.assertRaisesRegex(ValueError, 'Only explicit'):
            amend_source(self.root, 'Not an allowed bookkeeping correction')


if __name__ == '__main__':
    unittest.main()

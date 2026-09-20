"""Comparison utilities; perception inputs contain no evaluator references."""
from __future__ import annotations

import importlib.util
from pathlib import Path

from integrity import read, save_new, sha, verify_entries

ROOT = Path(__file__).resolve().parents[2]
BASELINE = ROOT / '.runtime/experiments/jev-round3-v1'
OUTPUT = ROOT / '.runtime/experiments/jev-library-v1'


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


measurement = module('library_baseline_measurement', ROOT / 'experiments/jev-round3/perception/measurement.py')
matching = module('library_baseline_matching', ROOT / 'experiments/jev-spatial-text/stereo/matching.py')


def population(baseline=BASELINE):
    samples, predictions = [], {}
    sealed = {str(Path(item['path']).resolve()): item for item in read(baseline / 'prediction-seal.json')['files']}
    for split in ['development', 'confirmation']:
        samples.extend(read(baseline / f'{split}-perception-inputs.json')['samples'])
        result = baseline / 'perception/scored' / split / 'results.json'
        verify_entries([sealed[str(result.resolve())]])
        for record in read(result)['results']:
            if record['id'] in predictions:
                raise ValueError('Duplicate baseline prediction')
            predictions[record['id']] = record
    if len(samples) != 1200 or {s['id'] for s in samples} != set(predictions):
        raise ValueError('Expected exact 1200-frame paired population')
    if any(set(s) != {'id', 'leftPath', 'rightPath', 'calibrationPath'} for s in samples):
        raise ValueError('Perception manifest fields must be image/calibration only')
    return samples, predictions


def selected(detections):
    candidates = [d for d in detections if d['blueCarCandidate']]
    return (candidates[0]['detectionId'], 'single') if len(candidates) == 1 else \
        (None, 'ambiguous' if candidates else 'missing')

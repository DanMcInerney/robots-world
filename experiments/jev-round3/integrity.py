"""File-evidence checks shared by orchestration and evaluator, never perception."""
import hashlib
import json
from pathlib import Path


def sha256(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024*1024), b''):
            value.update(chunk)
    return value.hexdigest()


def verify_manifest(path):
    manifest = json.loads(Path(path).read_text(encoding='utf-8-sig'))
    for entry in manifest['files']:
        if sha256(entry['path']) != entry['sha256']:
            raise ValueError('Frozen evidence changed: ' + entry['path'])
    return manifest


def verify_prediction_input(sample, prediction):
    if sample['id'] != prediction['id']:
        raise ValueError('Prediction/sample identity mismatch')
    for key in ['leftPath', 'rightPath', 'calibrationPath']:
        recorded = prediction['input'][key]
        if Path(recorded['path']).resolve() != Path(sample[key]).resolve() or sha256(sample[key]) != recorded['sha256']:
            raise ValueError('Prediction does not match its frozen input: ' + key)

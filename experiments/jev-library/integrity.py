"""One evidence-chain owner; streaming hashes, exclusive seals, no inference imports."""
from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path

MAX_FRAMES = 1200
BOOKKEEPING_FILES = ('integrity.py', 'campaign.py', 'test_integrity.py', 'evaluate.py', 'test_evaluate.py')
ARMS = ('mask_median', 'botsort', 'yolo11_current', 'yolo26', 'tensorrt_fp16',
        'ffs_mask', 'combined_yolo26_ffs_tracking')


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def save_new(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x', encoding='utf-8') as stream:
        json.dump(value, stream, indent=2, allow_nan=False)
        stream.write('\n')


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def entry(path):
    return {'path': str(Path(path).resolve()), 'sha256': sha(path)}


def verify_entries(entries):
    if len(entries) > 30000:
        raise ValueError('Unbounded evidence file list')
    seen = set()
    for item in entries:
        path = str(Path(item['path']).resolve())
        if path in seen or not isinstance(item['sha256'], str) or len(item['sha256']) != 64:
            raise ValueError('Duplicate path or invalid evidence hash')
        seen.add(path)
        if not Path(path).is_file() or sha(path) != item['sha256']:
            raise ValueError('Missing or changed sealed evidence: ' + path)


def frames(records, expected):
    ids = [row['id'] for row in records]
    if len(ids) > MAX_FRAMES or len(ids) != len(set(ids)) or set(ids) != set(expected):
        raise ValueError('Duplicate or incomplete frame population')
    return {row['id']: row for row in records}


def same_file(left, right):
    """Existing file identity handles Windows extended paths without changing evidence."""
    try:
        return Path(left).samefile(right)
    except (OSError, ValueError):
        return False


def existing_path(path):
    """Canonical display path after existence/realpath checks, including Windows UNC."""
    resolved = str(Path(path).resolve(strict=True))
    if os.name == 'nt':
        if resolved.startswith('\\\\?\\UNC\\'):
            resolved = '\\\\' + resolved[8:]
        elif resolved.startswith('\\\\?\\'):
            resolved = resolved[4:]
    return Path(resolved)


def source_state(root, verify_current=True):
    root = Path(root)
    frozen = read(root / 'source-freeze.json')
    effective = {item['path']: item for item in frozen['files']}
    previous = entry(root / 'source-freeze.json')
    amendments = sorted((root / 'source-amendments').glob('*.json'))
    if len(amendments) > 20:
        raise ValueError('Too many source amendments')
    links = []
    for index, path in enumerate(amendments, 1):
        amendment = read(path)
        if (path.name != f'{index:04d}.json' or amendment.get('previous') != previous
                or amendment.get('schemaVersion') != 'jev-library-source-amendment-v1'
                or not amendment.get('reason') or not amendment.get('changes')):
            raise ValueError('Invalid source amendment chain')
        seen = set()
        for change in amendment['changes']:
            name = change['path']
            if (name in seen or name not in effective
                    or change['beforeSha256'] != effective[name]['sha256']
                    or Path(name).name not in BOOKKEEPING_FILES):
                raise ValueError('Invalid or non-bookkeeping source amendment')
            seen.add(name)
            verify_entries([change['snapshot']])
            if change['snapshot']['sha256'] != change['sha256']:
                raise ValueError('Source amendment snapshot mismatch')
            effective[name] = {'path': name, 'sha256': change['sha256']}
        previous = entry(path)
        links.append(previous)
    if verify_current:
        verify_entries(list(effective.values()))
    return frozen, links, effective


def amend_source(root, reason):
    """Prospective bookkeeping correction, forbidden after prediction/analysis sealing."""
    root = Path(root)
    if not reason.strip() or any((root / name).exists() for name in ('prediction-seal.json', 'analysis-seal.json')):
        raise ValueError('Source amendment needs a reason and an unsealed campaign')
    _, links, effective = source_state(root, verify_current=False)
    changes = [item for item in effective.values() if sha(item['path']) != item['sha256']]
    if not changes or any(Path(item['path']).name not in BOOKKEEPING_FILES for item in changes):
        raise ValueError('Only explicit integrity/campaign/replay/test bookkeeping changes may be amended')
    sequence = len(links) + 1
    snapshots = root / 'source-amendments' / f'{sequence:04d}-files'
    snapshots.mkdir(parents=True, exist_ok=False)
    recorded = []
    for index, item in enumerate(changes):
        source = Path(item['path'])
        snapshot = snapshots / f'{index:04d}-{source.name}'
        with snapshot.open('xb') as stream:
            stream.write(source.read_bytes())
        recorded.append({'path': item['path'], 'beforeSha256': item['sha256'],
                         'sha256': sha(source), 'snapshot': entry(snapshot)})
    destination = root / 'source-amendments' / f'{sequence:04d}.json'
    save_new(destination, {'schemaVersion': 'jev-library-source-amendment-v1',
        'at': datetime.now(timezone.utc).isoformat(), 'reason': reason,
        'scope': 'Bookkeeping compatibility only; original predictions and neural parameters unchanged',
        'previous': links[-1] if links else entry(root / 'source-freeze.json'), 'changes': recorded})
    source_state(root)
    return destination


def context(root):
    """Check small frozen links, not all 15,000 archived files on each arm."""
    root = Path(root)
    frozen, amendments, _ = source_state(root)
    verify_entries([frozen['perceptionInputs']])
    baseline = Path(frozen['baselineRoot'])
    for name, key in [('input-freeze.json', 'inputSealSha256'),
                      ('prediction-seal.json', 'predictionSealSha256'),
                      ('analysis-seal.json', 'analysisSealSha256')]:
        verify_entries([{'path': str(baseline / name), 'sha256': frozen['baseline'][key]}])
    result = {'sourceFreeze': entry(root / 'source-freeze.json'),
              'perceptionInputs': frozen['perceptionInputs'], 'baseline': frozen['baseline']}
    if amendments:
        result['sourceAmendments'] = amendments
    return result


def verify_context(root, recorded):
    current = context(root)
    chain = current.pop('sourceAmendments', [])
    recorded = dict(recorded)
    prefix = recorded.pop('sourceAmendments', [])
    if recorded != current or len(prefix) > len(chain) or prefix != chain[:len(prefix)]:
        raise ValueError('Arm source/input provenance mismatch')


def _seal(path, kind, records, expected, paths, provenance, dependencies=()):
    ids = sorted(frames(records, expected))
    unique = sorted({str(Path(p).resolve()) for p in paths})
    save_new(path, {'schemaVersion': 'jev-library-seal-v1', 'kind': kind,
                   'frames': len(ids), 'frameIds': ids, 'provenance': provenance,
                   'dependencies': list(dependencies), 'files': [entry(p) for p in unique]})


def _verify(path, kind, expected, paths, provenance, dependencies=()):
    if not Path(path).is_file():
        raise ValueError('Missing completion/seal: ' + str(path))
    seal = read(path)
    if (seal.get('schemaVersion') != 'jev-library-seal-v1' or seal.get('kind') != kind
            or seal.get('frameIds') != sorted(expected) or seal.get('frames') != len(expected)
            or seal.get('provenance') != provenance or seal.get('dependencies') != list(dependencies)):
        raise ValueError('Completion population or provenance mismatch: ' + str(path))
    if {str(Path(p).resolve()) for p in paths} != {item['path'] for item in seal['files']}:
        raise ValueError('Completion artifact coverage mismatch')
    verify_entries(seal['files'])
    verify_entries(seal['dependencies'])
    return seal


def ffs_files(root, index, originals):
    batch = read(index)
    rows = frames(batch['records'], originals)
    manifest = Path(root) / 'perception-inputs.json'
    if batch['manifestSha256'] != sha(manifest) or Path(batch['manifestPath']).resolve() != manifest.resolve():
        raise ValueError('Learned stereo input manifest mismatch')
    if not batch.get('metadata', {}).get('checkpointSha256'):
        raise ValueError('Missing learned stereo model metadata')
    paths = [index, Path(index).parent / 'progress.jsonl']
    for identity, row in rows.items():
        original = originals[identity]
        if row['input'] != original['input'] or row['calibration'] != original['calibration']:
            raise ValueError('Learned stereo RGB/calibration provenance mismatch')
        array = Path(row['arraysPath'])
        if not array.is_absolute():
            array = Path(index).parent / array
        if array.resolve() != (Path(index).parent / 'arrays' / (identity + '.npz')).resolve():
            raise ValueError('Learned stereo array path mismatch')
        verify_entries([{'path': str(array), 'sha256': row['arraysSha256']}])
        paths.append(array)
    return batch, paths


def seal_ffs(root, index, originals):
    provenance = context(root)
    batch, paths = ffs_files(root, index, originals)
    _seal(Path(index).parent / 'complete.json', 'ffs', batch['records'], originals, paths, provenance)


def verify_ffs(root, index, originals):
    completion = Path(index).parent / 'complete.json'
    provenance = read(completion)['provenance']
    verify_context(root, provenance)
    batch, paths = ffs_files(root, index, originals)
    _verify(completion, 'ffs', originals, paths, provenance)
    return batch


def arm_files(root, result, originals):
    result = Path(result)
    batch = read(result)
    records = frames(batch['records'], originals)
    if batch['arm'] != result.parent.name:
        raise ValueError('Arm identity mismatch')
    metadata = batch['metadata']
    verify_context(root, metadata['provenance'])
    mode = metadata['mode']
    if mode not in ('cached', 'tracker', 'detector', 'stereo', 'combined'):
        raise ValueError('Unknown arm mode')
    if mode == 'detector' and not metadata.get('detector', {}).get('checkpointSha256'):
        raise ValueError('Missing detector model metadata')
    dependencies, stereo, detector = [], {}, {}
    if mode in ('stereo', 'combined'):
        source = metadata['stereoIndex']
        verify_entries([source])
        stereo = frames(verify_ffs(root, Path(source['path']), originals)['records'], originals)
        dependencies.append(entry(Path(source['path']).parent / 'complete.json'))
    if mode == 'combined':
        source = metadata['detectionIndex']
        verify_entries([source])
        source_path = Path(source['path'])
        if source_path.resolve() == result.resolve():
            raise ValueError('Self-referential detector dependency')
        source_batch = read(source_path)
        if source_batch['metadata']['mode'] != 'detector':
            raise ValueError('Combined input must be a sealed detector arm')
        detector = frames(verify_arm(root, source_path, originals)['records'], originals)
        dependencies.append(entry(source_path.parent / 'complete.json'))
    paths = [result, result.parent / 'started.json']
    for identity, row in records.items():
        original = originals[identity]
        if row['input'] != original['input'] or row['calibration'] != original['calibration']:
            raise ValueError('Frozen input/calibration mismatch: ' + identity)
        archived = original['artifacts']['rawMeasurements']
        expected = {'baselineMeasurements': archived, 'detectorMasks': archived, 'stereoMeasurements': archived}
        if mode in ('stereo', 'combined'):
            expected['stereoMeasurements'] = stereo[identity]['arraysPath']
        if mode == 'combined':
            expected['detectorMasks'] = detector[identity]['artifacts']['detectorMasks']
        if mode == 'detector':
            expected['detectorMasks'] = str((result.parent / 'arrays' / (identity + '.npz')).resolve())
            paths.append(expected['detectorMasks'])
        if (set(row['artifacts']) != set(expected)
                or any(not same_file(row['artifacts'][key], path) for key, path in expected.items())):
            raise ValueError('Substituted artifact under frame ID: ' + identity)
        if mode != 'detector':
            source_rows = detector[identity]['detections'] if mode == 'combined' else original['detections']
            source_detections = {d['detectionId']: d for d in source_rows}
            for detection in row['detections']:
                source = source_detections.get(detection['detectionId'])
                keys = ('classId', 'className', 'confidence', 'boxXyxy', 'blueCarCandidate', 'colorEvidence')
                if source is None or any(detection.get(key) != source.get(key) for key in keys):
                    raise ValueError('Substituted detection under frame ID: ' + identity)
            if mode in ('cached', 'stereo') and len(row['detections']) != len(source_rows):
                raise ValueError('Cached detector population changed')
        record_path = result.parent / 'records' / (identity + '.json')
        if read(record_path) != row:
            raise ValueError('Record/index mismatch: ' + identity)
        paths.append(record_path)
    return batch, paths, dependencies


def seal_arm(root, result, originals):
    batch, paths, dependencies = arm_files(root, result, originals)
    _seal(Path(result).parent / 'complete.json', 'arm', batch['records'], originals,
          paths, batch['metadata']['provenance'], dependencies)


def verify_arm(root, result, originals):
    # Reject the review's missing/invalid completion case before opening arrays.
    completion = Path(result).parent / 'complete.json'
    if not completion.is_file():
        raise ValueError('Missing completion/seal: ' + str(completion))
    verify_entries(read(completion).get('files', []))
    batch, paths, dependencies = arm_files(root, result, originals)
    _verify(completion, 'arm', originals, paths, batch['metadata']['provenance'], dependencies)
    return batch


def prediction_files(root, originals):
    root = Path(root)
    manifest = read(root / 'manifest.json')
    declarations = manifest['arms']
    if (manifest['expectedFrames'] != len(originals) or len(declarations) != len(ARMS)
            or {d['arm'] for d in declarations} != set(ARMS)):
        raise ValueError('Manifest must declare the complete preselected arm population')
    paths = [root / 'manifest.json', root / 'source-freeze.json', root / 'perception-inputs.json']
    paths.extend(Path(link['path']) for link in context(root).get('sourceAmendments', []))
    completed = set()
    for declaration in declarations:
        arm, status = declaration['arm'], declaration['status']
        if status == 'complete':
            verify_arm(root, root / 'arms' / arm / 'results.json', originals)
            paths.append(root / 'arms' / arm / 'complete.json')
            completed.add(arm)
        elif status not in ('unavailable', 'benchmark-only') or not declaration.get('reason'):
            raise ValueError('Incomplete arm declaration: ' + arm)
    discovered = {path.parent.name for path in (root / 'arms').glob('*/complete.json')}
    if discovered != completed:
        raise ValueError('Completed arms differ from manifest')
    raw = root / 'ffs/scored/index.json'
    if raw.exists():
        verify_ffs(root, raw, originals)
        paths.append(raw.parent / 'complete.json')
    # Snapshot resolved environment/export/setup metadata, never huge weight copies.
    for folder in (root / 'detector/setup', root / 'ffs'):
        if folder.exists():
            paths.extend(folder.glob('*.json'))
            paths.extend(folder.glob('*packages*.txt'))
            paths.extend(folder.glob('requirements*.txt'))
    return paths


def seal_predictions(root, originals):
    paths = prediction_files(root, originals)
    _seal(Path(root) / 'prediction-seal.json', 'predictions', list(originals.values()), originals,
          paths, context(root))


def verify_predictions(root, originals):
    paths = prediction_files(root, originals)
    return _verify(Path(root) / 'prediction-seal.json', 'predictions', originals, paths, context(root))


def analysis_files(root):
    return [Path(root) / name for name in ('summary.json', 'replay.json', 'index.html',
                                         'manifest.json', 'prediction-seal.json', 'source-freeze.json')]


def seal_analysis(root, originals):
    verify_predictions(root, originals)
    _seal(Path(root) / 'analysis-seal.json', 'analysis', list(originals.values()), originals,
          analysis_files(root), context(root), [entry(Path(root) / 'prediction-seal.json')])


def verify_analysis(root, originals):
    verify_predictions(root, originals)
    return _verify(Path(root) / 'analysis-seal.json', 'analysis', originals, analysis_files(root),
                   context(root), [entry(Path(root) / 'prediction-seal.json')])

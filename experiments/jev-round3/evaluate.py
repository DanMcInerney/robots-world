"""Evaluator-only joins. This module is never imported by image perception."""
import argparse
import json
import math
from pathlib import Path
import shutil
import cv2
import numpy as np
from integrity import verify_manifest, verify_prediction_input, sha256

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / '.runtime/experiments/jev-round3-v1'
ARMS = {'bbox': 'bboxMedian', 'mask': 'maskForegroundCluster'}


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def lines(path):
    return [json.loads(line) for line in Path(path).read_text(encoding='utf-8-sig').splitlines() if line.strip()]


def save(path, value):
    Path(path).write_text(json.dumps(value, indent=2, allow_nan=False) + '\n', encoding='utf-8')


def relative(path):
    return Path(path).resolve().relative_to(OUT.resolve()).as_posix()


def bbox(mask):
    y, x = np.nonzero(mask)
    return [int(x.min()), int(y.min()), int(x.max()) + 1, int(y.max()) + 1] if len(x) else None


def iou(a, b):
    if a is None or b is None:
        return 0.0
    intersection = max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1]))
    union = (a[2]-a[0])*(a[3]-a[1]) + (b[2]-b[0])*(b[3]-b[1]) - intersection
    return float(intersection / union) if union > 0 else 0.0


def reference(depth, mask, calibration):
    if mask.shape != depth.shape:
        raise ValueError('Evaluator mask/depth mismatch')
    # Renderer explicitly declares coordinates at physical pixel centres.
    if calibration.get('pixel_coordinates') != 'u=column+0.5,v=row+0.5; top-left origin':
        raise ValueError('Unknown evaluator pixel convention')
    y, x = np.indices(depth.shape)
    radial = depth * np.sqrt(1 + ((x + .5 - calibration['cx']) / calibration['fx'])**2
                            + ((y + .5 - calibration['cy']) / calibration['fy'])**2)
    valid = mask & np.isfinite(radial) & (radial > 0)
    values = radial[valid]
    return {'medianVisibleRangeM': float(np.median(values)) if len(values) else None,
            'nearestVisibleRangeM': float(values.min()) if len(values) else None,
            'p10VisibleRangeM': float(np.quantile(values, .1)) if len(values) else None,
            'visiblePixels': int(valid.sum()), 'visibleBox': bbox(valid),
            'audience': 'evaluator-only; never delivered to perception or Jev'}


def finite(value):
    return isinstance(value, (float, int)) and not isinstance(value, bool) and math.isfinite(value)


def percentile(values, q):
    return float(np.quantile(values, q)) if values else None


def score_frame(sample, truth, prediction):
    verify_prediction_input(sample, prediction)
    depth = np.load(truth['depthLeftPath'])
    raw_mask = cv2.imread(truth['targetMaskLeftPath'], cv2.IMREAD_GRAYSCALE)
    if raw_mask is None:
        raise ValueError('Missing evaluator target mask')
    mask = raw_mask > 127
    ref = reference(depth, mask, read(sample['calibrationPath']))
    candidates = [d for d in prediction['detections'] if d['blueCarCandidate']]
    selected = candidates[0] if len(candidates) == 1 else None
    overlap = iou(selected['boxXyxy'], ref['visibleBox']) if selected else 0.0
    association_correct = selected is not None and overlap >= .5
    arms, grades = {}, {}
    arrays = np.load(prediction['artifacts']['rawMeasurements'])
    for short, key in ARMS.items():
        if selected is None:
            observed = {'status': 'unknown', 'unknownReason': 'missing-blue-car' if not candidates else 'ambiguous-blue-cars',
                        'estimateM': None, 'robustNearestProxyM': None, 'validCoverage': 0.0}
        else:
            observed = dict(selected['arms'][key])
        observed['validFraction'] = observed['validCoverage']
        arms[short] = observed
        estimate, near = observed['estimateM'], observed['robustNearestProxyM']
        accepted = selected is not None and observed['status'] == 'measured' and finite(estimate)
        error = estimate - ref['medianVisibleRangeM'] if accepted and finite(ref['medianVisibleRangeM']) else None
        near_error = near - ref['nearestVisibleRangeM'] if accepted and finite(near) and finite(ref['nearestVisibleRangeM']) else None
        inside = None
        if selected is not None:
            index = prediction['detections'].index(selected)
            if short == 'mask':
                support = arrays['selectedClusterMasks'][index].astype(bool)
            else:
                support = np.zeros(mask.shape, bool)
                x0, y0, x1, y1 = selected['boxXyxy']
                support[max(0, math.floor(y0)):min(mask.shape[0], math.ceil(y1)),
                        max(0, math.floor(x0)):min(mask.shape[1], math.ceil(x1))] = True
            support &= arrays['valid'].astype(bool)
            inside = float((support & mask).sum() / support.sum()) if support.any() else None
        grades[short] = {'accepted': accepted, 'associationCorrect': association_correct,
            'correctUsable': accepted and association_correct, 'errorM': error,
            'absoluteErrorM': abs(error) if error is not None else None,
            'nearestProxyErrorM': near_error, 'selectedStereoInsideTargetFraction': inside,
            'acceptedWrongAssociation': accepted and not association_correct,
            'falseFarOver2M': error is not None and error > 2,
            'falseNearOver2M': error is not None and error < -2}
    arrays.close()
    return {'id': sample['id'], 'atMs': sample['atMs'], 'frameIndex': sample['frameIndex'],
            'left': relative(sample['leftPath']), 'right': relative(sample['rightPath']),
            'overlay': relative(prediction['artifacts']['maskOverlay']),
            'depth': relative(prediction['artifacts']['depthPreview']),
            'evaluator': {**ref, 'selectedDetectionIoU': overlap},
            'perception': {'targetStatus': 'single' if selected else 'missing' if not candidates else 'ambiguous',
                'bearingDeg': selected['bearing']['azimuthDeg'] if selected else None,
                'arms': arms, 'timingMs': prediction['timing'],
                'candidateCount': len(candidates), 'detections': prediction['detections']},
            'grades': grades}


def aggregate(frames, arm):
    grades = [f['grades'][arm] for f in frames]
    errors = [g['absoluteErrorM'] for g in grades if g['absoluteErrorM'] is not None]
    near_errors = [abs(g['nearestProxyErrorM']) for g in grades if g['nearestProxyErrorM'] is not None]
    contamination = [1-g['selectedStereoInsideTargetFraction'] for g in grades if g['selectedStereoInsideTargetFraction'] is not None]
    return {'arm': arm, 'frames': len(frames), 'visibleReferenceFrames': sum(f['evaluator']['visiblePixels'] > 0 for f in frames),
            'correctAssociations': sum(g['associationCorrect'] for g in grades),
            'acceptedRanges': sum(g['accepted'] for g in grades), 'correctUsableRanges': sum(g['correctUsable'] for g in grades),
            'unknownRanges': sum(not g['accepted'] for g in grades),
            'acceptedWrongAssociations': sum(g['acceptedWrongAssociation'] for g in grades),
            'falseFarOver2M': sum(g['falseFarOver2M'] for g in grades),
            'falseNearOver2M': sum(g['falseNearOver2M'] for g in grades),
            'meanAbsoluteErrorM': float(np.mean(errors)) if errors else None,
            'p95AbsoluteErrorM': percentile(errors, .95),
            'nearestProxyMeanAbsoluteErrorM': float(np.mean(near_errors)) if near_errors else None,
            'meanSelectedBackgroundFraction': float(np.mean(contamination)) if contamination else None,
            'errorDenominator': len(errors), 'contaminationDenominator': len(contamination)}


def gate(summary, band_frames):
    conditions = {
        'all100NominalFramesPresent': summary['frames'] == 100,
        'correctSingleAssociationAtLeast90': summary['correctAssociations'] >= 90,
        'correctUsableRangesAtLeast90': summary['correctUsableRanges'] >= 90,
        'p95AbsoluteMedianRangeErrorAtMost1M': summary['p95AbsoluteErrorM'] is not None and summary['p95AbsoluteErrorM'] <= 1,
        'noAcceptedWrongAssociations': summary['acceptedWrongAssociations'] == 0,
        'noFalseFarOrNearOver2M': summary['falseFarOver2M'] == 0 and summary['falseNearOver2M'] == 0,
        'atLeast20ReferenceFramesAt8To12M': band_frames >= 20,
    }
    return {'pass': all(conditions.values()), 'conditions': conditions}


def promotion(box, mask, mask_nominal_pass):
    if box['frames'] != 400 or mask['frames'] != 400:
        raise ValueError('Promotion requires the fixed400-frame confirmation population')
    coverage_ok = mask['correctUsableRanges'] / 400 >= box['correctUsableRanges'] / 400 - .05 - 1e-12
    error_better = mask['meanAbsoluteErrorM'] is not None and box['meanAbsoluteErrorM'] is not None and mask['meanAbsoluteErrorM'] < box['meanAbsoluteErrorM']
    background_better = mask['meanSelectedBackgroundFraction'] is not None and box['meanSelectedBackgroundFraction'] is not None and mask['meanSelectedBackgroundFraction'] < box['meanSelectedBackgroundFraction']
    return {'pass': bool(mask_nominal_pass and coverage_ok and (error_better or background_better)),
            'populationFrames': 400, 'coverageWithinFivePercentagePoints': coverage_ok,
            'lowerMAE': error_better, 'lowerMeanSelectedBackgroundFraction': background_better,
            'box': box, 'mask': mask}


def select_arm(gates, promotion_result):
    return 'mask' if promotion_result['pass'] else 'bbox' if gates['bbox']['pass'] else None


def analyze():
    for name in ['source-freeze.json', 'input-freeze.json', 'development-seal.json', 'prediction-seal.json']:
        verify_manifest(OUT / name)
    prediction_seal = read(OUT / 'prediction-seal.json')
    for field, name in [('sourceFreezeSha256', 'source-freeze.json'), ('inputFreezeSha256', 'input-freeze.json'), ('developmentSealSha256', 'development-seal.json')]:
        if prediction_seal[field] != sha256(OUT / name):
            raise ValueError('Prediction seal chain mismatch: ' + field)
    samples = lines(OUT / 'inputs.jsonl')
    truths = lines(OUT / 'evaluator.jsonl')
    predictions = []
    for split in ['development', 'confirmation']:
        predictions.extend(read(OUT / 'perception/scored' / split / 'results.json')['results'])
    by_id = {p['id']: p for p in predictions}
    truth_by_id = {t['id']: t for t in truths}
    expected = {s['id'] for s in samples}
    if len(expected) != 1200 or len(by_id) != len(predictions) or expected != set(by_id) or expected != set(truth_by_id):
        raise ValueError('Expected exact 1200-frame one-to-one RGB/prediction/truth join')
    routes = {}
    for sample in samples:
        route = routes.setdefault(sample['routeId'], {'id': sample['routeId'], 'family': sample['family'], 'split': sample['split'], 'frames': []})
        route['frames'].append(score_frame(sample, truth_by_id[sample['id']], by_id[sample['id']]))
    for route in routes.values():
        route['frames'].sort(key=lambda f: f['frameIndex'])
        if [f['frameIndex'] for f in route['frames']] != list(range(100)):
            raise ValueError('Each route requires exact zero-based frame indices0..99')
    groups = []
    for split in ['development', 'confirmation']:
        for family in ['nominal-range', 'wall-pole', 'occlusion-lookalike', 'moving-target-ego']:
            frames = [f for r in routes.values() if r['split'] == split and r['family'] == family for f in r['frames']]
            for arm in ARMS:
                groups.append({'split': split, 'family': family, **aggregate(frames, arm)})
    nominal = next(r['frames'] for r in routes.values() if r['split'] == 'confirmation' and r['family'] == 'nominal-range')
    band = [f for f in nominal if finite(f['evaluator']['medianVisibleRangeM']) and 8 <= f['evaluator']['medianVisibleRangeM'] <= 12]
    gates = {arm: gate(aggregate(nominal, arm), len(band)) for arm in ARMS}
    confirmation = [f for r in routes.values() if r['split'] == 'confirmation' for f in r['frames']]
    promotion_result = promotion(aggregate(confirmation, 'bbox'), aggregate(confirmation, 'mask'), gates['mask']['pass'])
    selected = select_arm(gates, promotion_result)
    timings = [p['timing'] for p in predictions]
    timing_summary = {}
    for key in sorted(set().union(*(set(t) for t in timings))):
        values = [t[key] for t in timings if finite(t.get(key))]
        if values:
            timing_summary[key] = {'n': len(values), 'medianMs': percentile(values, .5), 'p95Ms': percentile(values, .95)}
    summary = {'routes': len(routes), 'frames': len(samples), 'armMeasurements': len(samples)*2,
               'statisticalUnit': '12 correlated scripted routes; 1200 frames are not independent trials',
               'perception': groups, 'nominalConfirmationGates': gates,
               'confirmation8To12M': [aggregate(band, arm) for arm in ARMS],
               'selectedForNextStage': selected, 'maskPromotion': promotion_result,
               'perRoute': [{'id': r['id'], 'family': r['family'], 'split': r['split'], **aggregate(r['frames'], arm)} for r in routes.values() for arm in ARMS],
               'timing': timing_summary,
               'nextStage': 'range-wording probes eligible' if selected else 'blocked: neither perception arm qualified',
               'limitations': ['Synthetic single car asset; no real-camera transfer qualification',
                    'Scripted actual physics poses rendered offline, no Jev flight or real-time loop yet',
                    'Primary range is median visible surface; nearest-range proxy scored separately',
                    'No local-geometry/obstacle-avoidance qualification in this association test']}
    if (OUT / 'analysis-seal.json').exists():
        raise RuntimeError('Analysis is already sealed; preserve prior evidence')
    save(OUT / 'summary.json', summary)
    scope = 'Actual3D RGB-derived car perception on scripted Robots World trajectories. No Jev flight; evaluator truth is labeled separately.'
    replay = {'title': 'Round 3 · 3D stereo perception', 'status': 'perception-completed', 'scope': scope,
              'summary': summary, 'routes': list(routes.values()),
              'provenance': {'plan': '../../../docs/jev-round3-plan.md', 'sourceFreeze': 'source-freeze.json', 'inputFreeze': 'input-freeze.json', 'inputs': 'inputs.jsonl', 'evaluation': 'evaluator.jsonl'}}
    save(OUT / 'perception-handoff.json', replay)
    save(OUT / 'analysis-seal.json', {'files': [{'path': str(OUT / name), 'sha256': sha256(OUT / name)}
        for name in ['summary.json', 'perception-handoff.json', 'source-freeze.json', 'input-freeze.json', 'prediction-seal.json', 'development-seal.json']],
        'note': 'Immutable perception-to-probe handoff; display replay may append decisions separately'})
    save(OUT / 'replay.json', replay)
    shutil.copyfile(ROOT / 'experiments/jev-round3/replay.html', OUT / 'index.html')
    print(json.dumps({'frames': len(samples), 'gates': gates, 'selectedForNextStage': selected}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--analyze', action='store_true', required=True)
    parser.parse_args()
    analyze()

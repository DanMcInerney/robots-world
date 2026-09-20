"""Paired original/optimized real serial compute; diagnostics recorded separately."""
from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path
import sys
import time

import cv2
import numpy as np

from artifacts import ArtifactWriter
from common import BASELINE, OUTPUT, ROOT, measurement, module, population, save_new, sha
from geometry import Geometry
from run import associate
from stereo_cached import CachedStereo

sys.path.insert(0, str(ROOT / 'experiments/jev-round3/perception'))
original = module('library_original_runner', ROOT / 'experiments/jev-round3/perception/run.py')


def diagnostic(destination, left, stereo, masks, detections):
    start = time.perf_counter()
    destination.mkdir(parents=True, exist_ok=False)
    overlay = left.copy()
    for mask, detection in zip(masks, detections):
        overlay[mask] = (0.6 * overlay[mask] + 0.4 * np.array([255, 170, 0])).astype(np.uint8)
        x0, y0, x1, y1 = [int(round(v)) for v in detection['boxXyxy']]
        cv2.rectangle(overlay, (x0, y0), (x1, y1), (255, 170, 0), 1)
    cv2.imwrite(str(destination / 'overlay.png'), overlay)
    with (destination / 'measurements.npz').open('xb') as stream:
        np.savez_compressed(stream, axialDepthM=stereo['depth'], valid=stereo['valid'],
                            disparity=stereo['disparity'], detectorMasks=masks,
                            rawLeft=stereo['rawLeft'], rawRight=stereo['rawRight'])
    save_new(destination / 'complete.json', {'workMs': (time.perf_counter()-start)*1000,
        'rawSha256': sha(destination / 'measurements.npz'), 'overlaySha256': sha(destination / 'overlay.png')})


def optimized(sample, detector, stereo_backend, geometries, writer, destination):
    start = time.perf_counter()
    left, right, cal, _ = original.load_sample(sample, ROOT)
    decoded = time.perf_counter()
    detections, masks, detector_time = detector.predict(left)
    stereo_start = time.perf_counter()
    stereo = stereo_backend.estimate(cv2.cvtColor(left, cv2.COLOR_BGR2GRAY), cv2.cvtColor(right, cv2.COLOR_BGR2GRAY), cal)
    stereo_end = time.perf_counter()
    key = json.dumps(cal, sort_keys=True)
    if key not in geometries:
        geometries[key] = Geometry(cal)
    associate(detections, masks, stereo['depth'], stereo['valid'], cal, geometries[key], left)
    measured = time.perf_counter()
    writer.submit(diagnostic, destination / sample['id'], left, stereo, masks, copy.deepcopy(detections))
    queued = time.perf_counter()
    return {'timing': {'decodeMs': (decoded-start)*1000, **detector_time,
            'stereoWallMs': (stereo_end-stereo_start)*1000,
            'associationMs': (measured-stereo_end)*1000,
            'decodeThroughMeasurementMs': (measured-start)*1000,
            'queueAdmissionMs': (queued-measured)*1000},
            'stereo': stereo, 'calibration': cal, 'detections': detections}


def summarize(records, label):
    keys = ['detectorPredictWallMs', 'stereoWallMs', 'decodeThroughMeasurementMs', 'artifactWriteAndHashMs', 'queueAdmissionMs']
    result = {}
    for key in keys:
        values = [r[label].get(key) for r in records if r[label].get(key) is not None]
        if values:
            result[key] = {'n': len(values), 'medianMs': float(np.median(values)), 'p95Ms': float(np.quantile(values, .95))}
    return result


def main(args):
    destination = args.output / 'benchmark'
    destination.mkdir(parents=True, exist_ok=False)
    samples, _ = population(args.baseline)
    samples = [sample for sample in samples if int(sample['id'].rsplit('-', 1)[1]) % 20 == 0]
    if len(samples) != 60:
        raise ValueError('Expected predetermined 60-frame sample')
    detector = original.Detector(args.baseline / 'perception/models/yolo11s-seg.pt', '0', destination)
    save_new(destination / 'started.json', {'warmup': detector.warmup(), 'ids': [s['id'] for s in samples],
        'scope': 'same original detector/environment; baseline all original arms+overlay, optimized mask median+cached geometry/stereo; acquisition/Jev excluded'})
    stereo_backend, geometries, records = CachedStereo(), {}, []
    started = time.perf_counter()
    with ArtifactWriter(capacity=2) as writer:
        for index, sample in enumerate(samples):
            # Alternate order to reduce systematic warmup/thermal ordering bias.
            if index % 2:
                new = optimized(sample, detector, stereo_backend, geometries, writer, destination / 'optimized')
                old = original.process(sample, ROOT, destination / 'original', detector)
            else:
                old = original.process(sample, ROOT, destination / 'original', detector)
                new = optimized(sample, detector, stereo_backend, geometries, writer, destination / 'optimized')
            with np.load(old['artifacts']['rawMeasurements']) as arrays:
                depth_equal = np.array_equal(arrays['axialDepthM'], new['stereo']['depth'], equal_nan=True)
                valid_equal = np.array_equal(arrays['valid'], new['stereo']['valid'])
            if not depth_equal or not valid_equal:
                raise AssertionError('Cached SGBM changed the measurement on ' + sample['id'])
            records.append({'id': sample['id'], 'original': old['timing'], 'optimized': new['timing'],
                            'stereoDepthExactlyEqual': depth_equal, 'stereoValidityExactlyEqual': valid_equal})
            if (index + 1) % 10 == 0:
                print(json.dumps({'benchmarkFrames': index+1}), flush=True)
    result = {'frames': len(records), 'original': summarize(records, 'original'),
              'optimized': summarize(records, 'optimized'), 'records': records,
              'artifacts': {'flushed': True, 'capacity': writer.capacity, 'peakPending': writer.peak_pending,
                            'backpressureMs': writer.blocked_ms},
              'totalWallMsIncludingDiagnostics': (time.perf_counter()-started)*1000,
              'limitations': ['Compute comparison intentionally removes foreground clustering and overlay work from the control path',
                'Background diagnostics contend for CPU/IO and may affect compute; bounded queue wait is separately reported',
                'Old diagnostic payload is richer; this is a pipeline configuration comparison, not an equal-work storage benchmark',
                'Same recorded images; no live camera, Jev or actuator timing']}
    save_new(destination / 'results.json', result)
    print(json.dumps({k: result[k] for k in ['frames', 'original', 'optimized', 'artifacts']}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--baseline', type=Path, default=BASELINE)
    parser.add_argument('--output', type=Path, default=OUTPUT)
    main(parser.parse_args())

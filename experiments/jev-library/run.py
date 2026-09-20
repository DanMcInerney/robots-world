"""Isolated quality ablations on preserved image-derived Round 3 observations.

No renderer/evaluator data is imported. Reusing recorded stereo makes these
quality comparisons deliberately distinct from a live-pipeline benchmark.
"""
from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path
import time

import cv2
import numpy as np

from artifacts import ArtifactWriter
from common import BASELINE, OUTPUT, measurement, population, read, save_new, selected, sha
from geometry import Geometry, mask_median
from integrity import context, seal_arm, verify_arm, verify_ffs


def associate(detections, masks, depth, valid, calibration, geometry, image=None):
    if masks.shape != (len(detections), *depth.shape) or valid.shape != depth.shape:
        raise ValueError('Image, mask and stereo arrays must align')
    ranges = geometry.radial_ranges(depth)
    for detection, mask in zip(detections, masks):
        if image is not None:
            detection['colorEvidence'] = measurement.color_evidence(image, mask)
            detection['blueCarCandidate'] = detection['className'] == 'car' and detection['colorEvidence']['blueSupported']
        detection['maskPixels'] = int(mask.sum())
        detection['bearing'] = geometry.bearing(detection['boxXyxy'], mask)
        detection['arms'] = {
            'maskMedian': mask_median(depth, valid, detection['boxXyxy'], mask, calibration, geometry),
            'bboxMedian': measurement.summarize(ranges, valid, measurement.box_region(detection['boxXyxy'], depth.shape)),
        }


def write_masks(path, masks):
    # Exclusive creation prevents accidental replacement of a completed artifact.
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('xb') as stream:
        np.savez_compressed(stream, detectorMasks=masks)


def run(args):
    destination = args.output / 'arms' / args.arm
    if destination.exists():
        raise FileExistsError('Arm already exists; retain it and choose an explicit new attempt name')
    destination.mkdir(parents=True)
    samples, baseline = population(args.baseline)
    metadata = {'mode': args.mode, 'retrospective': True, 'frames': len(samples),
                'provenance': context(args.output),
                'baseline': str(args.baseline.resolve()), 'recordedConfidenceCutoff': 0.25,
                'timingScope': 'quality replay; recorded stereo load is not live stereo inference'}
    detector = tracker = binding = None
    if args.mode == 'detector':
        from detector import Detector
        detector = Detector(args.checkpoint, device='0', runtime_root=args.output / 'detector', half=args.half)
        metadata['detector'] = detector.metadata
        metadata['warmup'] = detector.warmup()
    elif args.mode in ['tracker', 'combined']:
        from tracker import Tracker, TargetBinding
        tracker, binding = Tracker(), TargetBinding()
        metadata['tracker'] = getattr(tracker, 'metadata', {})
        metadata['binding'] = 'first sole visible blue-car track; retain ID; no automatic target substitution'
    stereo_index = {}
    if args.mode in ['stereo', 'combined']:
        raw_index = verify_ffs(args.output, args.stereo_index, baseline)
        entries = raw_index.get('records', raw_index.get('results', []))
        stereo_index = {row['id']: row for row in entries}
        if set(stereo_index) != {s['id'] for s in samples}:
            raise ValueError('Stereo output population mismatch')
        metadata['stereoIndex'] = {'path': str(args.stereo_index.resolve()), 'sha256': sha(args.stereo_index)}
        metadata['stereoMetadata'] = raw_index.get('metadata')
    detection_index = {}
    if args.mode == 'combined':
        batch = verify_arm(args.output, args.detection_index, baseline)
        if batch['metadata']['mode'] != 'detector':
            raise ValueError('Combined input must be a completed detector arm')
        detection_index = {row['id']: row for row in batch['records']}
        if set(detection_index) != {s['id'] for s in samples}:
            raise ValueError('Combined detector population mismatch')
        metadata['detectionIndex'] = {'path': str(args.detection_index.resolve()), 'sha256': sha(args.detection_index)}
    save_new(destination / 'started.json', metadata)
    geometry = None
    old_calibration = old_route = None
    records = []
    cv2.setNumThreads(1)
    with ArtifactWriter(capacity=2) as writer:
        for index, sample in enumerate(samples):
            original = baseline[sample['id']]
            calibration = original['calibration']
            if calibration != old_calibration:
                geometry = Geometry(calibration)
                old_calibration = dict(calibration)
            load_start = time.perf_counter()
            with np.load(original['artifacts']['rawMeasurements']) as arrays:
                depth, valid = arrays['axialDepthM'], arrays['valid'].astype(bool)
                masks = arrays['detectorMasks'].astype(bool)
            detections = copy.deepcopy(original['detections'])
            timing = {'recordedArrayLoadMs': (time.perf_counter()-load_start)*1000}
            if args.mode == 'combined':
                detection_record = detection_index[sample['id']]
                if detection_record['input'] != original['input']:
                    raise ValueError('Combined detector input mismatch')
                detections = copy.deepcopy(detection_record['detections'])
                with np.load(detection_record['artifacts']['detectorMasks']) as arrays:
                    masks = arrays['detectorMasks'].astype(bool)
            if args.mode in ['stereo', 'combined']:
                stereo_record = stereo_index[sample['id']]
                if stereo_record['input'] != original['input'] or stereo_record['calibration'] != calibration:
                    raise ValueError('Learned stereo RGB/calibration provenance mismatch')
                array_path = Path(stereo_record['arraysPath'])
                if not array_path.is_absolute():
                    array_path = args.stereo_index.parent / array_path
                if sha(array_path) != stereo_record['arraysSha256']:
                    raise ValueError('Learned stereo array bytes changed')
                with np.load(array_path) as arrays:
                    depth, valid = arrays['depth'], arrays['valid'].astype(bool)
                timing['learnedStereo'] = stereo_record.get('timing', {})
            image = None
            if detector is not None or tracker is not None:
                image = cv2.imread(sample['leftPath'])
                if image is None:
                    raise ValueError('Missing RGB image')
            if detector is not None:
                detections, masks, detector_timing = detector.predict(image)
                timing.update(detector_timing)
            start = time.perf_counter()
            associate(detections, masks, depth, valid, calibration, geometry, image if detector else None)
            timing['associationMs'] = (time.perf_counter()-start)*1000
            tracking = None
            if tracker is not None:
                route = sample['id'].rsplit('-', 1)[0]
                if route != old_route:
                    tracker.reset()
                    binding.reset()
                    old_route = route
                start = time.perf_counter()
                detections, masks, tracking = tracker.update(detections, masks, image)
                target = binding.update(detections)
                tracking['target'] = target
                selected_id, status = target['selectedDetectionId'], target['status']
                timing['trackingAndBindingMs'] = (time.perf_counter()-start)*1000
            else:
                selected_id, status = selected(detections)
            artifacts = {'baselineMeasurements': original['artifacts']['rawMeasurements'],
                         'detectorMasks': original['artifacts']['rawMeasurements'],
                         'stereoMeasurements': original['artifacts']['rawMeasurements']}
            if args.mode in ['stereo', 'combined']:
                artifacts['stereoMeasurements'] = str(array_path.resolve())
            if args.mode == 'combined':
                artifacts['detectorMasks'] = detection_record['artifacts']['detectorMasks']
            if detector is not None:
                mask_path = destination / 'arrays' / (sample['id'] + '.npz')
                writer.submit(write_masks, mask_path, masks.copy())
                artifacts['detectorMasks'] = str(mask_path.resolve())
            record = {'id': sample['id'], 'detections': detections, 'selectedDetectionId': selected_id,
                      'selectionStatus': status, 'tracking': tracking, 'timing': timing,
                      'input': original['input'], 'calibration': calibration, 'artifacts': artifacts}
            save_new(destination / 'records' / (sample['id'] + '.json'), record)
            records.append(record)
            if (index + 1) % 100 == 0:
                print(json.dumps({'arm': args.arm, 'completed': index + 1}), flush=True)
    metadata['artifacts'] = {'capacity': writer.capacity, 'peakPending': writer.peak_pending,
                             'backpressureMs': writer.blocked_ms, 'flushed': True}
    result = {'arm': args.arm, 'metadata': metadata, 'measurementKey': 'maskMedian', 'records': records}
    save_new(destination / 'results.json', result)
    seal_arm(args.output, destination / 'results.json', baseline)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--mode', choices=['cached', 'tracker', 'detector', 'stereo', 'combined'], required=True)
    parser.add_argument('--arm', required=True)
    parser.add_argument('--baseline', type=Path, default=BASELINE)
    parser.add_argument('--output', type=Path, default=OUTPUT)
    parser.add_argument('--checkpoint', type=Path)
    parser.add_argument('--half', action='store_true')
    parser.add_argument('--stereo-index', type=Path)
    parser.add_argument('--detection-index', type=Path)
    args = parser.parse_args()
    if args.mode == 'detector' and not args.checkpoint:
        parser.error('Detector mode requires checkpoint')
    if args.mode in ['stereo', 'combined'] and not args.stereo_index:
        parser.error('Stereo mode requires stereo index')
    if args.mode == 'combined' and not args.detection_index:
        parser.error('Combined mode requires detector index')
    run(args)

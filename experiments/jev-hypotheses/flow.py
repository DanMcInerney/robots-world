"""Optional offline OpenCV qualification. Only saved RGB/gray pixels enter flow."""
import cv2, json, pathlib, sys, time, numpy as np
root = pathlib.Path(sys.argv[1])
report = json.loads((root / 'report.json').read_text())
rows = []
for sequence in report['sequences']:
    previous = None
    points = None
    frames = []
    for frame in sequence['frames']:
        image = cv2.imread(str(root / 'vision' / frame['file']), cv2.IMREAD_GRAYSCALE)
        started = time.perf_counter()
        tracked, error, median_flow = 0, None, None
        if previous is not None and points is not None:
            next_points, status, errors = cv2.calcOpticalFlowPyrLK(previous, image, points, None)
            if status is not None:
                valid = status.reshape(-1).astype(bool)
                tracked = int(valid.sum())
                if tracked:
                    delta = (next_points - points).reshape(-1, 2)[valid]
                    median_flow = np.median(delta, axis=0).tolist()
                    error = float(np.median(errors.reshape(-1)[valid]))
        points = cv2.goodFeaturesToTrack(image, maxCorners=80, qualityLevel=.01, minDistance=5)
        frames.append({'file':frame['file'],'detectedCorners':0 if points is None else len(points),'trackedFromPrevious':tracked,'medianFlowPixels':median_flow,'medianLKError':error,'processingMs':1000*(time.perf_counter()-started)})
        previous = image
    rows.append({'variant':sequence['variant'],'frames':frames})
result = {'opencv':cv2.__version__,'numpy':np.__version__,'inputs':'Grayscale PNG pixels only. No simulator geometry, goal, class IDs, calibration depth or recommended controls.', 'limits':'Texture corners and flow, not semantic objects, depth, clear space or a navigation policy. LK may report correspondences through occlusion; status is not truth. Desktop timings only. Not supplied to Jev flights in this round.', 'sequences':rows}
(root / 'opencv-flow.json').write_text(json.dumps(result,indent=2))
print(json.dumps({'opencv':cv2.__version__,'sequences':len(rows),'grayFramesWithCorners':sum(f['detectedCorners']>0 for r in rows if r['variant']=='gray' for f in r['frames'])}))

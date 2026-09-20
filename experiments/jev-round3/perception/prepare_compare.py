"""Explicitly authorized, bounded nano/small comparison on three setup images.

No scored inputs, no thresholds sweep, no automatic model promotion.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import time
import urllib.request
from pathlib import Path

import cv2
import numpy as np

from measurement import color_evidence
from run import DEFAULT_OUTPUT, DETECTOR, ROOT, write_json


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--camera-smoke-root", type=Path,
        default=ROOT / ".runtime/experiments/jev-round3-v1/camera/smoke")
    parser.add_argument("--output", type=Path,
        default=DEFAULT_OUTPUT / "setup/capacity-comparison")
    args = parser.parse_args()
    os.environ["YOLO_CONFIG_DIR"] = str(DEFAULT_OUTPUT / "setup/ultralytics")
    import torch
    from ultralytics import YOLO
    torch.set_num_threads(DETECTOR["torchCpuThreads"])
    torch.backends.cudnn.benchmark = False
    output = args.output
    output.mkdir(parents=True, exist_ok=True)
    if (output / "results.json").exists():
        raise FileExistsError("Capacity comparison already completed; retain it without rerunning")
    paths = [args.camera_smoke_root / f"range-{distance}/rgb/left.png"
             for distance in [6, 10, 14]]
    results = []
    for name in ["yolo11n-seg", "yolo11s-seg"]:
        checkpoint = DEFAULT_OUTPUT / f"models/{name}.pt"
        url = f"https://github.com/ultralytics/assets/releases/download/v8.3.0/{name}.pt"
        if not checkpoint.exists():
            urllib.request.urlretrieve(url, checkpoint)
        load_start = time.perf_counter()
        model = YOLO(str(checkpoint))
        load_ms = (time.perf_counter()-load_start)*1000
        settings = {key: DETECTOR[key] for key in ["imgsz", "conf", "iou", "max_det", "retina_masks", "half", "augment"]}
        settings.update(device="0", verbose=False, save=False)
        warmup = []
        for _ in range(3):
            torch.cuda.synchronize()
            start = time.perf_counter()
            model.predict(np.zeros((360, 640, 3), np.uint8), **settings)
            torch.cuda.synchronize()
            warmup.append((time.perf_counter()-start)*1000)
        rows = []
        for path, distance in zip(paths, [6, 10, 14]):
            bgr = cv2.imread(str(path), cv2.IMREAD_COLOR)
            torch.cuda.synchronize()
            start = time.perf_counter()
            result = model.predict(bgr, **settings)[0]
            torch.cuda.synchronize()
            elapsed = (time.perf_counter()-start)*1000
            boxes = result.boxes.xyxy.cpu().numpy()
            classes = result.boxes.cls.cpu().numpy()
            confidences = result.boxes.conf.cpu().numpy()
            masks = result.masks.data.cpu().numpy() > .5 if result.masks is not None else np.zeros((0, 360, 640), bool)
            hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
            blue_pixels = (hsv[:, :, 0] >= 95) & (hsv[:, :, 0] <= 135) & (hsv[:, :, 1] >= 70) & (hsv[:, :, 2] >= 35)
            detections = [{"rawClassId": int(cls), "className": result.names[int(cls)],
                "confidence": float(conf), "boxXyxy": list(map(float, box)),
                "maskPixels": int(masks[index].sum()), "colorEvidence": color_evidence(bgr, masks[index])}
                for index, (box, cls, conf) in enumerate(zip(boxes, classes, confidences))]
            artifact = output / f"{name}-range-{distance}-overlay.jpg"
            cv2.imwrite(str(artifact), result.plot())
            rows.append({"preparationRangeLabel": distance, "inputPath": str(path),
                "inputSha256": hashlib.sha256(path.read_bytes()).hexdigest(), "inputShape": list(bgr.shape),
                "inputEncoding": "OpenCV IMREAD_COLOR BGR ndarray, Ultralytics ndarray contract",
                "wholeImageBluePixelCount": int(blue_pixels.sum()),
                "meanBgrAmongBluePixels": list(map(float, bgr[blue_pixels].mean(axis=0))) if blue_pixels.any() else None,
                "detections": detections, "predictWallMs": elapsed, "internalMs": result.speed,
                "overlayPath": str(artifact)})
        results.append({"model": name, "checkpointPath": str(checkpoint), "url": url,
            "checkpointSha256": hashlib.sha256(checkpoint.read_bytes()).hexdigest(),
            "loadMs": load_ms, "blankWarmupsMs": warmup, "settings": settings,
            "carClassId": [key for key, value in model.names.items() if value == "car"], "results": rows})
    write_json(output / "results.json", {"purpose": "bounded authorized engineering smoke capacity comparison; not scored results",
        "automaticPromotion": False, "ultralyticsVersion": DETECTOR["ultralyticsVersion"], "models": results})
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()

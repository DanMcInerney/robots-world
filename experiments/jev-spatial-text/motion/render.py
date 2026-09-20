"""Evaluator-owned ENU pinhole stereo renderer; poses never enter estimation."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import cv2
import numpy as np

CALIBRATION = dict(width=640, height=360, fx=400.0, fy=400.0, cx=319.5, cy=179.5,
                   baselineM=.12, doffsPx=0.0, rectified=True)
BASE_ROTATION = np.array([[1, 0, 0], [0, 0, 1], [0, -1, 0]], dtype=float)


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, allow_nan=False)+"\n", encoding="utf-8")


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def specs():
    return [
        dict(name="development-translation", split="development", seed=101, count=11, mode="translate"),
        dict(name="translation", split="evaluation", seed=201, count=21, mode="translate"),
        dict(name="pure-rotation", split="evaluation", seed=202, count=21, mode="rotate"),
        dict(name="return", split="evaluation", seed=203, count=21, mode="return"),
        dict(name="announced-reset", split="evaluation", seed=204, count=21, mode="translate", resetAt=10),
        dict(name="dynamic-outlier", split="evaluation", seed=205, count=21, mode="translate", dynamic=True),
        dict(name="visual-dropout", split="evaluation", seed=206, count=21, mode="translate", blackout=[8,9,10]),
    ]


def pose(spec, index):
    position = np.array([0., 0., 1.5])
    yaw = 0.
    if spec["mode"] == "translate":
        position += [index*.04, index*.015, 0]
    elif spec["mode"] == "rotate":
        yaw = np.deg2rad(index)
    else:
        position += [min(index, spec["count"]-1-index)*.05, 0, 0]
    rotation = np.array([[np.cos(yaw), -np.sin(yaw), 0], [np.sin(yaw), np.cos(yaw), 0], [0,0,1]]) @ BASE_ROTATION
    transform = np.eye(4)
    transform[:3,:3], transform[:3,3] = rotation, position
    return transform


def surfaces(spec, index):
    # Each rectangle fixes one ENU coordinate; bounds cover the other axes.
    planes = [
        dict(axis=1, value=6.0, axes=[0,2], bounds=[-5,5,-.5,4], texture=0),
        dict(axis=2, value=0.0, axes=[0,1], bounds=[-5,5,-2,8], texture=1),
        dict(axis=0, value=-3.0, axes=[1,2], bounds=[-2,8,0,4], texture=2),
        dict(axis=0, value=3.0, axes=[1,2], bounds=[-2,8,0,4], texture=3),
        dict(axis=1, value=3.0, axes=[0,2], bounds=[-.95,-.35,.7,2.3], texture=4),
        dict(axis=1, value=4.2, axes=[0,2], bounds=[.65,1.4,.4,2.4], texture=5),
    ]
    if spec.get("dynamic"):
        motion = .50*np.sin(index*.4)
        planes += [dict(axis=1, value=2.0, axes=[0,2], bounds=[-.7+motion,.7+motion,.65,2.35], texture=6, offset=motion, dynamic=True)]
    return planes


def render_sequence(root: Path, spec, sequence_index):
    directory = root/"inputs"/f"sequence-{sequence_index:02d}"
    directory.mkdir(parents=True, exist_ok=False)
    rng = np.random.default_rng(spec["seed"])
    textures = [cv2.GaussianBlur(rng.integers(15, 240, (1536,1536), dtype=np.uint8), (3,3), .6) for _ in range(7)]
    # Disjoint seeds alter surface texture; layout variants alter supported geometry.
    yy, xx = np.indices((CALIBRATION["height"], CALIBRATION["width"]), np.float32)
    camera_rays = np.stack([(xx-CALIBRATION["cx"])/CALIBRATION["fx"],
                            (yy-CALIBRATION["cy"])/CALIBRATION["fy"], np.ones_like(xx)], axis=-1)
    frames, truth = [], []
    for index in range(spec["count"]):
        transform = pose(spec, index)
        rotation, position = transform[:3,:3], transform[:3,3]
        rays = camera_rays @ rotation.T
        planes = surfaces(spec,index)
        paths, left_data = {}, None
        for camera, offset in (("left", 0), ("right", CALIBRATION["baselineM"])):
            camera_position = position+rotation[:,0]*offset
            image = np.full(xx.shape, 8, np.uint8)
            nearest = np.full(xx.shape, np.inf, np.float32)
            labels = np.full(xx.shape, -1, np.int16)
            for plane_index, plane in enumerate(planes):
                axis = plane["axis"]
                with np.errstate(divide="ignore", invalid="ignore"):
                    depth = (plane["value"]-camera_position[axis])/rays[:,:,axis]
                    points = camera_position + rays*depth[:,:,None]
                a,b = plane["axes"]
                amin,amax,bmin,bmax = plane["bounds"]
                visible = (depth>0) & (depth<nearest) & (points[:,:,a]>=amin) & (points[:,:,a]<amax) & (points[:,:,b]>=bmin) & (points[:,:,b]<bmax)
                u = np.nan_to_num((points[:,:,a]-plane.get("offset",0))*180+768, nan=-1e4, posinf=-1e4, neginf=-1e4).astype(np.float32)
                v = np.nan_to_num(points[:,:,b]*180+768, nan=-1e4, posinf=-1e4, neginf=-1e4).astype(np.float32)
                values = cv2.remap(textures[plane["texture"]], u, v, cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP)
                image[visible], nearest[visible], labels[visible] = values[visible], depth[visible], plane_index
            if index in spec.get("blackout", []):
                image[:] = 0
            path = directory/f"frame-{index:03d}-{camera}.png"
            cv2.imwrite(str(path),image)
            paths[camera] = str(path)
            if camera == "left":
                left_data = nearest,labels
        gt_path = directory/f"frame-{index:03d}-evaluator-only.npz"
        np.savez_compressed(gt_path, depth=left_data[0], labels=left_data[1], dynamic=left_data[1]==6)
        # Public reset is a frame-boundary sensor/estimator event, not a pose.
        frames.append(dict(id=f"sequence-{sequence_index:02d}-frame-{index:03d}", acquisitionMs=index*100,
                           leftImage=paths["left"], rightImage=paths["right"],
                           sourceSha256={name:sha(Path(path)) for name,path in paths.items()},
                           resetEpoch=index == spec.get("resetAt",-1)))
        truth.append(dict(frameId=frames[-1]["id"], worldFromCamera=transform.tolist(), truthPath=str(gt_path)))
    write_json(directory/"calibration.json",CALIBRATION)
    write_json(directory/"sensor-sequence.json",dict(id=f"sequence-{sequence_index:02d}",frames=frames,calibration=CALIBRATION))
    write_json(directory/"evaluator-only.json",dict(spec=spec,worldFrame="ENU metres",cameraFrame="optical: x right, y down, z forward",truth=truth))
    return directory

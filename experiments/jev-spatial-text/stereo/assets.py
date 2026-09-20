"""Recorded source acquisition and deterministic stereo image synthesis.

The renderer may read geometry; the matcher never receives that geometry or GT.
"""
from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path
import re
import time
import urllib.request
import zipfile

import cv2
import numpy as np

BASE = "https://vision.middlebury.edu/stereo/data/scenes2014/datasets/"
DOWNLOAD_CAP = 200_000_000


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def download(root: Path) -> dict:
    manifest_path = root / "download-manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {
        "source": BASE, "capBytes": DOWNLOAD_CAP, "files": []}
    by_path = {item["path"]: item for item in manifest["files"]}
    # Individual PNG/PFM URLs return 403. The officially linked public archives
    # support byte ranges: fetch needed members, not the 100MB full archives.
    class RemoteArchive(io.RawIOBase):
        def __init__(self, url):
            self.url, self.position = url, 0
            with urllib.request.urlopen(urllib.request.Request(url, method="HEAD"), timeout=60) as response:
                self.length = int(response.headers["Content-Length"])
        def seekable(self):
            return True
        def tell(self):
            return self.position
        def seek(self, offset, whence=0):
            self.position = offset + (self.length if whence == 2 else self.position if whence == 1 else 0)
            return self.position
        def read(self, size=-1):
            size = self.length - self.position if size < 0 else min(size, self.length-self.position)
            if not size:
                return b""
            consumed = manifest.get("archiveTransferBytes", 0) + sum(item["bytes"] for item in manifest["files"] if not item.get("archiveMember"))
            if consumed + size > DOWNLOAD_CAP:
                raise ValueError("Download cap would be exceeded")
            request = urllib.request.Request(self.url, headers={"Range": f"bytes={self.position}-{self.position+size-1}"})
            with urllib.request.urlopen(request, timeout=60) as response:
                if response.status != 206:
                    raise ValueError("Server did not honor range; refusing full download")
                data = response.read(size+1)
            if len(data) != size:
                raise ValueError("Truncated or overlong archive range")
            manifest["archiveTransferBytes"] = manifest.get("archiveTransferBytes", 0) + len(data)
            manifest.setdefault("archiveRanges", []).append(dict(url=self.url, start=self.position, bytes=len(data), sha256=hashlib.sha256(data).hexdigest()))
            write_json(manifest_path, manifest)
            self.position += size
            return data
    for scene in ("Adirondack", "Motorcycle", "Pipes"):
        names = ["calib.txt", "im0.png", "im1.png", "disp0.pfm"]
        if scene == "Motorcycle":
            names += ["im1E.png"]
        archive_url = f"https://vision.middlebury.edu/stereo/data/scenes2014/zip/{scene}-perfect.zip"
        archive = zipfile.ZipFile(RemoteArchive(archive_url))
        for name in names:
            relative = f"sources/{scene}-perfect/{name}"
            path = root / relative
            if relative in by_path:
                if not path.exists() or sha(path) != by_path[relative]["sha256"]:
                    raise ValueError(f"Retained source differs: {path}")
                continue
            if path.exists():
                raise ValueError(f"Refusing unmanifested existing file: {path}")
            path.parent.mkdir(parents=True, exist_ok=True)
            started = time.time()
            member = f"{scene}-perfect/{name}"
            data = archive.read(member)
            metadata = {"url": archive_url, "archiveMember": member, "path": relative, "bytes": len(data),
                        "downloadedAtUnix": started, "sha256": hashlib.sha256(data).hexdigest()}
            path.write_bytes(data)
            manifest["files"].append(metadata)
            by_path[relative] = metadata
            write_json(manifest_path, manifest)
            print(f"downloaded {relative}: {len(data)} bytes", flush=True)
    manifest["totalBytes"] = manifest.get("archiveTransferBytes", 0) + sum(item["bytes"] for item in manifest["files"] if not item.get("archiveMember"))
    write_json(manifest_path, manifest)
    return manifest


def read_pfm(path: Path) -> np.ndarray:
    with path.open("rb") as stream:
        if stream.readline().strip() != b"Pf":
            raise ValueError("Expected one-channel PFM")
        width, height = map(int, stream.readline().split())
        scale = float(stream.readline())
        data = np.frombuffer(stream.read(), dtype="<f4" if scale < 0 else ">f4")
        return np.flipud(data.reshape(height, width)).copy()


def calibrated_recorded(root: Path, name: str, exposure=False) -> dict:
    source = root / "sources" / f"{name}-perfect"
    lines = dict(line.split("=", 1) for line in (source / "calib.txt").read_text().splitlines())
    matrix = list(map(float, re.findall(r"[-+]?\d*\.?\d+", lines["cam0"])))
    width, height = int(lines["width"]), int(lines["height"])
    output_width = 768
    output_height = round(height * output_width / width)
    sx, sy = output_width / width, output_height / height
    calibration = {"fx": matrix[0] * sx, "fy": matrix[4] * sy,
                   "cx": (matrix[2] + 0.5) * sx - 0.5, "cy": (matrix[5] + 0.5) * sy - 0.5,
                   "baselineM": float(lines["baseline"]) / 1000,
                   "doffsPx": float(lines["doffs"]) * sx,
                   "width": output_width, "height": output_height,
                   "rectified": True, "sourceNdisp": int(lines["ndisp"]),
                   "sourceScaleXY": [sx, sy]}
    scene_id = "middlebury-" + name.lower() + ("-exposure" if exposure else "")
    directory = root / "inputs" / scene_id
    directory.mkdir(parents=True, exist_ok=False)
    for camera, filename in [("left", "im0.png"), ("right", "im1E.png" if exposure else "im1.png")]:
        image = cv2.imread(str(source / filename), cv2.IMREAD_GRAYSCALE)
        if image is None:
            raise ValueError(f"Unreadable image: {filename}")
        cv2.imwrite(str(directory / f"{camera}.png"), cv2.resize(image, (output_width, output_height), interpolation=cv2.INTER_AREA))
    # Nearest-neighbor sampling preserves invalid GT and never mixes foreground/background.
    gt_disparity = cv2.resize(read_pfm(source / "disp0.pfm"), (output_width, output_height), interpolation=cv2.INTER_NEAREST) * sx
    valid_gt = np.isfinite(gt_disparity) & (gt_disparity > 0)
    gt_depth = np.full(gt_disparity.shape, np.nan, np.float32)
    gt_depth[valid_gt] = calibration["fx"] * calibration["baselineM"] / (gt_disparity[valid_gt] + calibration["doffsPx"])
    np.savez_compressed(directory / "evaluator-only.npz", depth=gt_depth, disparity=gt_disparity, valid=valid_gt)
    write_json(directory / "calibration.json", calibration)
    return {"id": scene_id, "split": "development" if name == "Adirondack" else "evaluation",
            "sourceType": "recorded-middlebury2014", "tests": ["S01", "S03", "S04", "S06"],
            "sourceFiles": [str(source / filename) for filename in ("calib.txt", "im0.png", "im1E.png" if exposure else "im1.png", "disp0.pfm")],
            "inputDirectory": str(directory), "captureTimeKnown": False,
            "metadata": {"scene": name, "exposureVariant": exposure, "resolution": [output_width, output_height]}}


def synthetic_specs() -> list[dict]:
    cases = []
    for split, seeds in [("development", [110]), ("evaluation", [220, 330])]:
        for seed in seeds:
            for depth in (1.0, 2.0, 4.0):
                cases.append(dict(label=f"ladder-{depth:g}", split=split, seed=seed, wall=depth, tests=["S01"]))
    for label, kwargs in [
        ("blank", dict(texture="blank", tests=["S04"])),
        ("repeated-stripes", dict(texture="stripes", tests=["S04"])),
        ("twins", dict(twins=True, tests=["S02"])),
        ("twins-swapped", dict(twins=True, swapped=True, tests=["S02"])),
        ("exposure-low", dict(exposure=0.35, tests=["S04", "S05"])),
        ("exposure-high", dict(exposure=1.8, tests=["S04", "S05"])),
        ("blur", dict(blur=7, tests=["S04", "S05"])),
        ("vertical-misalignment", dict(verticalOffset=2, tests=["S05"])),
    ]:
        cases.append(dict(label=label, split="evaluation", seed=440, wall=4.0, **kwargs))
    for width in (1, 2, 4, 8, 16):
        for center in (0.0, 0.24):
            cases.append(dict(label=f"pole-{width}px-at-{center}", split="evaluation", seed=550,
                              wall=4.0, poleWidthPx=width, poleCenterM=center, tests=["S03"]))
    for skew in (0, 5, 20, 50):
        cases.append(dict(label=f"skew-{skew}ms", split="evaluation", seed=660, wall=4.0,
                          moving=True, skewMs=skew, tests=["S05"]))
    for baseline, depth, scale in [(0.03, 4, 1), (0.12, 4, 1), (0.06, 0.15, 1), (0.06, 12, 1), (0.06, 4, 0.5)]:
        cases.append(dict(label=f"range-b{baseline}-z{depth}-scale{scale}", split="evaluation", seed=770,
                          wall=depth, baseline=baseline, scale=scale, tests=["S06"]))
    return cases


def render_synthetic(root: Path, spec: dict) -> dict:
    scale = spec.get("scale", 1)
    width, height = int(640 * scale), int(360 * scale)
    fx = 400 * scale
    baseline = spec.get("baseline", 0.06)
    calibration = dict(fx=fx, fy=fx, cx=(width - 1) / 2, cy=(height - 1) / 2,
                       baselineM=baseline, doffsPx=0, width=width, height=height, rectified=True)
    rng = np.random.default_rng(spec["seed"])
    textures = [cv2.GaussianBlur(rng.integers(25, 230, (1024, 1024), dtype=np.uint8), (3, 3), 0.65) for _ in range(4)]
    planes = [dict(z=spec["wall"], bounds=None, texture=0, style=spec.get("texture", "textured"))]
    if "poleWidthPx" in spec:
        z = 1.0
        half_width = spec["poleWidthPx"] * z / fx / 2
        center = spec["poleCenterM"]
        planes += [dict(z=z, bounds=[center-half_width, center+half_width, -0.8, 0.8], texture=1, style="textured")]
    if spec.get("twins"):
        distances = (3.6, 1.1) if spec.get("swapped") else (1.1, 3.6)
        for index, (side, z) in enumerate(zip((-1, 1), distances)):
            cx = side * 0.35 * z
            planes += [dict(z=z, bounds=[cx-0.08*z, cx+0.08*z, -0.12*z, 0.12*z], texture=index+1, style="textured")]
    if spec.get("moving"):
        planes += [dict(z=2.0, bounds=[-0.25, 0.25, -0.3, 0.3], texture=2, style="textured", moving=True)]
    yy, xx = np.indices((height, width), np.float32)
    outputs = []
    for camera, camera_x in enumerate((0, baseline)):
        image = np.zeros((height, width), np.uint8)
        depth = np.full((height, width), np.inf, np.float32)
        labels = np.zeros((height, width), np.uint8)
        for plane_id, plane in enumerate(planes):
            z = plane["z"]
            x = (xx - calibration["cx"]) * z / fx + camera_x
            y = (yy - calibration["cy"]) * z / fx
            motion = spec.get("skewMs", 0) / 1000 if camera == 1 and plane.get("moving") else 0
            visible = z < depth
            if plane["bounds"]:
                a, b, c, d = plane["bounds"]
                visible &= (x >= a + motion) & (x < b + motion) & (y >= c) & (y < d)
            if plane["style"] == "blank":
                values = np.full((height, width), 128, np.uint8)
            elif plane["style"] == "stripes":
                values = np.where(np.sin(x * 180) > 0, 210, 40).astype(np.uint8)
            else:
                values = cv2.remap(textures[plane["texture"]], ((x-motion)*220+512).astype(np.float32),
                                   (y*220+512).astype(np.float32), cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP)
            image[visible] = values[visible]
            depth[visible] = z
            labels[visible] = plane_id
        if camera == 1:
            image = np.clip(image.astype(float) * spec.get("exposure", 1), 0, 255).astype(np.uint8)
            if spec.get("blur"):
                image = cv2.GaussianBlur(image, (spec["blur"], spec["blur"]), 2)
            if spec.get("verticalOffset"):
                image = cv2.warpAffine(image, np.float32([[1, 0, 0], [0, 1, spec["verticalOffset"]]]), (width, height))
        outputs.append((image, depth, labels))
    scene_id = f"synthetic-{spec['label']}-{spec['seed']}"
    directory = root / "inputs" / scene_id
    directory.mkdir(parents=True, exist_ok=False)
    cv2.imwrite(str(directory / "left.png"), outputs[0][0])
    cv2.imwrite(str(directory / "right.png"), outputs[1][0])
    np.savez_compressed(directory / "evaluator-only.npz", depth=outputs[0][1], labels=outputs[0][2], valid=np.isfinite(outputs[0][1]))
    write_json(directory / "calibration.json", calibration)
    write_json(directory / "renderer-spec-evaluator-only.json", spec)
    return dict(id=scene_id, split=spec["split"], sourceType="synthetic-calibrated-render",
                tests=spec["tests"], inputDirectory=str(directory), sourceFiles=[], captureTimeKnown=True,
                metadata={"syntheticAcquisitionTimeMs": [0, spec.get("skewMs", 0)], "spec": spec})

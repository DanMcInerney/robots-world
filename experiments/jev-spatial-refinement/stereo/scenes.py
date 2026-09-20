"""Fresh evaluator-owned supersampled plane renderer; output matching receives only PNG/calibration."""
from __future__ import annotations
import itertools
import cv2
import numpy as np

CALIBRATION = dict(fx=400., fy=400., cx=319.5, cy=179.5, baselineM=.06,
                   doffsPx=0., width=640, height=360, rectified=True,
                   convention="camera-forward axial depth in metres; not ray distance")
SUPERSAMPLING = 4


def specs():
    cases = []
    for width, phase, bg in itertools.product((3, 6), (.125, .625), (4.4,)):
        cases.append(dict(split="development", family="thin", widthPx=width, phasePx=phase,
                          backgroundM=bg, nearM=1.11, skewMs=0, seed=89131))
    cases += [dict(split="development", family="skew", widthPx=6, phasePx=.125,
                   backgroundM=4.4, nearM=1.11, skewMs=skew, speedMps=1., seed=89132) for skew in (0, 10)]
    cases += [dict(split="development", family="plane", backgroundM=2.1, seed=89133),
              dict(split="development", family="blank", backgroundM=4.4, seed=89134)]
    for width, phase, bg in itertools.product((1, 2, 4, 8), (0., .25, .5), (3.6, 5.2, 7.3)):
        cases.append(dict(split="confirmation", family="thin", widthPx=width, phasePx=phase,
                          backgroundM=bg, nearM=1.17, skewMs=0, seed=99141))
    for width, skew in itertools.product((4, 8), (0, 5, 20, 50)):
        cases.append(dict(split="confirmation", family="skew", widthPx=width, phasePx=.25,
                          backgroundM=5.2, nearM=1.17, skewMs=skew, speedMps=1., seed=99142))
    cases += [dict(split="confirmation", family="plane", backgroundM=depth, seed=99143)
              for depth in (1.17, 2.3, 5.2)]
    cases += [dict(split="confirmation", family="blank", backgroundM=5.2, seed=99144)]
    return [dict(id=f"pair-{i:03d}", **case) for i, case in enumerate(cases)]


def render(spec):
    c, ss = CALIBRATION, SUPERSAMPLING
    h, w = c["height"], c["width"]
    yy, xx = np.indices((h*ss, w*ss), dtype=np.float32)
    xx, yy = (xx+.5)/ss-.5, (yy+.5)/ss-.5
    rng = np.random.default_rng(spec["seed"])
    textures = [cv2.GaussianBlur(rng.integers(20, 236, (1024, 1024), dtype=np.uint8), (3, 3), .55)
                for _ in range(2)]
    images, coverage = [], []
    for eye, camera_x in enumerate((0., c["baselineM"])):
        def values(z, texture, motion=0):
            x = (xx-c["cx"])*z/c["fx"] + camera_x
            y = (yy-c["cy"])*z/c["fy"]
            image = cv2.remap(texture, ((x-motion)*240+512).astype(np.float32),
                             (y*240+512).astype(np.float32), cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP)
            return x, y, image
        _, _, image = values(spec["backgroundM"], textures[0])
        if spec["family"] == "blank":
            image[:] = 128
        mask = np.zeros(image.shape, bool)
        if "widthPx" in spec:
            z = spec["nearM"]
            motion = eye * spec["skewMs"]/1000 * spec.get("speedMps", 0)
            x, y, pole = values(z, textures[1], motion)
            center = (320.+spec["phasePx"]-c["cx"])*z/c["fx"]
            half = spec["widthPx"]*z/c["fx"]/2
            mask = (x >= center-half+motion) & (x < center+half+motion) & (np.abs(y) < 90*z/c["fy"])
            image[mask] = pole[mask]
        images.append(np.rint(image.reshape(h, ss, w, ss).mean(axis=(1, 3))).astype(np.uint8))
        coverage.append(mask.reshape(h, ss, w, ss).mean(axis=(1, 3)).astype(np.float32))
    fraction = coverage[0]
    depth = np.full((h, w), spec["backgroundM"], np.float32)
    if "nearM" in spec:
        depth[fraction > 0] = spec["nearM"]
    # Every pixel with any rendered hazard footprint counts as a hazard. Mixed
    # edge pixels have no single optical depth: exclude them only from depth
    # error, never from hazard miss/false-far/unknown denominators.
    return images, dict(depth=depth, hazardFraction=fraction,
                        homogeneous=(fraction == 0) | (fraction == 1))

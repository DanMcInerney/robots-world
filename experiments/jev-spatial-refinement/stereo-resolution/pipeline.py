"""Historical SGBM5, with only the search extent scaled with focal length."""
from __future__ import annotations
import copy
import baseline_matching as baseline

BASELINE_PARAMETERS=copy.deepcopy(baseline.PARAMETERS)


def parameters(scale):
    if scale not in (1,2,4):raise ValueError("Unplanned camera scale")
    return dict(BASELINE_PARAMETERS,numDisparities=64*scale)


def estimate(left,right,calibration,scale):
    # Serial, single-thread execution only. The unchanged implementation reads
    # its parameter dictionary; restore it even on failure. At scale 2 this is
    # exactly the historical 640px/128-disparity configuration.
    old=baseline.PARAMETERS
    baseline.PARAMETERS=parameters(scale)
    try:
        result=baseline.estimate(left,right,calibration)
        regions=baseline.make_regions(result,calibration)
        return result,regions
    finally:baseline.PARAMETERS=old

"""Evaluator-only metrics. No function in this file is imported by pipeline.py."""
from __future__ import annotations
import numpy as np


def pixel_metrics(result, truth, key):
    retained = result[key] & np.isfinite(result["depth"])
    depth, ref = result["depth"], truth["depth"]
    hazard = truth["hazardFraction"] > 0
    # Near-plane controls are reported separately, not counted as thin hazards.
    total = int(hazard.sum())
    measured = int((hazard & retained).sum())
    false_far = int((hazard & retained & (depth >= 3)).sum())
    near_correct = int((hazard & retained & (depth < 1.5)).sum())
    homogeneous = truth["homogeneous"] & retained
    errors = np.abs(depth[homogeneous]-ref[homogeneous])
    return dict(totalPixels=int(depth.size), retainedPixels=int(retained.sum()),
                overallCoverage=float(retained.mean()), hazardPixels=total,
                hazardRetainedPixels=measured, hazardUnknownPixels=total-measured,
                hazardFalseFarPixels=false_far, hazardNearBinPixels=near_correct,
                hazardCoverage=measured/total if total else None,
                hazardFalseFarOverAll= false_far/total if total else None,
                hazardNearOverAll=near_correct/total if total else None,
                mixedHazardPixels=int(((truth["hazardFraction"]>0)&(truth["hazardFraction"]<1)).sum()),
                homogeneousScoredPixels=int(homogeneous.sum()),
                medianAbsoluteErrorM=float(np.median(errors)) if len(errors) else None,
                p95AbsoluteErrorM=float(np.quantile(errors,.95)) if len(errors) else None)


def grade(result, regions, truth):
    hazard = truth["hazardFraction"] > 0
    sectors = []
    for r in regions:
        x0,y0,x1,y1 = r["pixelBounds"]
        count = int(hazard[y0:y1,x0:x1].sum())
        sectors.append(dict(id=r["id"], hazardPixels=count, observedBin=r["depthBin"],
                            nearToFar=bool(count >= 12 and r["depthBin"] == "far"),
                            nearToMid=bool(count >= 12 and r["depthBin"] == "mid"),
                            unknown=bool(count >= 12 and r["depthBin"] in ("unknown", "boundary"))))
    return dict(raw=pixel_metrics(result,truth,"rawValid"),
                retained=pixel_metrics(result,truth,"valid"), sectors=sectors)


def aggregate(rows):
    output = dict(pairs=len(rows))
    for key in ("raw","retained"):
        names=("totalPixels","retainedPixels","hazardPixels","hazardRetainedPixels",
               "hazardUnknownPixels","hazardFalseFarPixels","hazardNearBinPixels","mixedHazardPixels")
        sums={name:sum(row["grade"][key][name] for row in rows) for name in names}
        n=sums["hazardPixels"]
        sums.update(overallCoverage=sums["retainedPixels"]/sums["totalPixels"] if sums["totalPixels"] else None,
                    hazardCoverage=sums["hazardRetainedPixels"]/n if n else None,
                    hazardFalseFarOverAll=sums["hazardFalseFarPixels"]/n if n else None,
                    hazardNearOverAll=sums["hazardNearBinPixels"]/n if n else None)
        output[key]=sums
    sectors=[s for row in rows for s in row["grade"]["sectors"] if s["hazardPixels"]>=12]
    output["hazardSectors"] = dict(total=len(sectors), nearToFar=sum(s["nearToFar"] for s in sectors),
                                 nearToMid=sum(s["nearToMid"] for s in sectors),
                                 unknown=sum(s["unknown"] for s in sectors),
                                 correctlyNear=sum(s["observedBin"]=="near" for s in sectors))
    lat=[r["processToTextMs"] for r in rows]
    output["latencyMs"] = dict(p50=float(np.median(lat)),p95=float(np.quantile(lat,.95)),maximum=max(lat)) if lat else None
    errors=[r["grade"]["retained"]["p95AbsoluteErrorM"] for r in rows if r["grade"]["retained"]["p95AbsoluteErrorM"] is not None]
    output["perPairRetainedP95ErrorRangeM"]=[min(errors),max(errors)] if errors else None
    return output

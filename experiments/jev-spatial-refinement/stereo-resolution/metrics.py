"""Evaluator-only hazards; no hidden geometry is accepted by the estimator."""
from __future__ import annotations
import numpy as np


def grade(result,regions,truth,scale):
    hazard=truth["hazardFraction"]>0
    total=int(hazard.sum());fraction=truth["hazardFraction"]
    output={}
    for key in ("rawValid","valid"):
        valid=result[key]&np.isfinite(result["depth"])
        near=valid&(result["depth"]<1.5)&hazard
        far=valid&(result["depth"]>=3)&hazard
        unknown=~valid&hazard
        error_mask=truth["homogeneous"]&valid
        errors=np.abs(result["depth"][error_mask]-truth["depth"][error_mask])
        mixed=(fraction>0)&(fraction<1)
        def physical_mass(mask):return float(fraction[mask].sum())/(scale*scale)
        mass=physical_mass(hazard)
        output[key]=dict(totalPixels=int(hazard.size),hazardPixels=total,
                        mixedHazardPixels=int(mixed.sum()),hazardRetainedPixels=int((valid&hazard).sum()),
                        correctNearPixels=int(near.sum()),falseFarPixels=int(far.sum()),unknownPixels=int(unknown.sum()),
                        correctNearFraction=int(near.sum())/total,falseFarFraction=int(far.sum())/total,
                        unknownFraction=int(unknown.sum())/total,overallCoverage=float(valid.mean()),
                        physicalHazardFootprintBasePixelArea=mass,
                        correctNearPhysicalFraction=physical_mass(near)/mass,
                        falseFarPhysicalFraction=physical_mass(far)/mass,
                        unknownPhysicalFraction=physical_mass(unknown)/mass,
                        homogeneousDepthScoredPixels=int(error_mask.sum()),
                        p95HomogeneousDepthErrorM=float(np.quantile(errors,.95)) if len(errors) else None)
    sectors=[]
    for r in regions:
        x0,y0,x1,y1=r["pixelBounds"]
        n=int(hazard[y0:y1,x0:x1].sum())
        if n:
            sectors.append(dict(id=r["id"],hazardPixels=n,depthBin=r["depthBin"],
                                nearToFar=r["depthBin"]=="far",nearToMid=r["depthBin"]=="mid"))
    output["hazardSectors"]=sectors
    return output

"""Evaluator-only truth comparisons. Nothing here supplies matcher inputs."""
from __future__ import annotations

import cv2
import numpy as np

from matching import distance_bin


def metrics(depth, retained, truth, truth_valid, mask=None):
    population = truth_valid.copy()
    if mask is not None:
        population &= mask
    scored = population & retained & np.isfinite(depth)
    count = int(population.sum())
    sample_count = int(scored.sum())
    error = np.abs(depth[scored]-truth[scored])
    tolerance = np.maximum(.05, .05*truth[scored])
    near = population & (truth < 1.5)
    near_scored = near & scored
    false_far = near_scored & (depth >= 3)
    excessively_far = scored & (depth > truth + np.maximum(.05, .05*truth))
    return {"referencePixels": count, "retainedReferencePixels": sample_count,
            "validCoverage": sample_count/count if count else None,
            "medianAbsoluteErrorM": float(np.median(error)) if sample_count else None,
            "p95AbsoluteErrorM": float(np.quantile(error, .95)) if sample_count else None,
            "withinToleranceAmongRetained": float((error <= tolerance).mean()) if sample_count else None,
            "withinToleranceAmongAllReference": int((error <= tolerance).sum())/count if count else None,
            "nearReferencePixels": int(near.sum()), "nearRetainedPixels": int(near_scored.sum()),
            "nearInvalidPixels": int((near & ~retained).sum()), "nearFalseFarPixels": int(false_far.sum()),
            "overestimatedBeyondTolerancePixels": int(excessively_far.sum()),
            "tolerance": "max(0.05m, 5% reference axial depth)"}


def grade(scene, result, regions, evaluator_path):
    with np.load(evaluator_path) as data:
        truth, truth_valid = data["depth"], data["valid"]
        labels = data["labels"] if "labels" in data else None
    output = {"sceneId": scene["id"], "split": scene["split"], "sourceType": scene["sourceType"],
              "tests": scene["tests"], "raw": metrics(result["depth"], result["rawValid"], truth, truth_valid),
              "retained": metrics(result["depth"], result["valid"], truth, truth_valid),
              "masks": {}}
    if labels is not None and labels.max() > 0:
        foreground = labels > 0
        output["masks"]["foreground"] = metrics(result["depth"], result["valid"], truth, truth_valid, foreground)
        output["masks"]["background"] = metrics(result["depth"], result["valid"], truth, truth_valid, ~foreground)
        for radius in (2, 5):
            kernel = np.ones((2*radius+1, 2*radius+1), np.uint8)
            outer = cv2.dilate(foreground.astype(np.uint8), kernel).astype(bool)
            inner = cv2.erode(foreground.astype(np.uint8), kernel).astype(bool)
            output["masks"][f"boundary-{radius}px"] = metrics(result["depth"], result["valid"], truth, truth_valid, outer & ~inner)
            output["masks"][f"foreground-interior-{radius}px"] = metrics(result["depth"], result["valid"], truth, truth_valid, inner)
    region_grades = []
    for region in regions:
        x0, y0, x1, y1 = region["pixelBounds"]
        reference = truth[y0:y1, x0:x1]
        valid_ref = truth_valid[y0:y1, x0:x1]
        values = reference[valid_ref]
        nearest_truth = None
        # At least 12 GT pixels in a 0.2m band; catches a 1px pole without
        # giving an isolated GT sample absolute authority in public datasets.
        for candidate in np.unique(np.floor(values/.1).astype(np.int32)) if len(values) else []:
            in_band = values[(values >= candidate*.1) & (values < (candidate+2)*.1)]
            if len(in_band) >= 12:
                nearest_truth = float(np.quantile(in_band, .05))
                break
        expected = distance_bin([nearest_truth, nearest_truth]) if nearest_truth is not None else "unknown"
        observed = region["depthBin"]
        near_missed = expected == "near" and observed in ("mid", "far")
        accepted = observed not in ("unknown", "boundary")
        agreement = accepted and observed == expected
        item = {"recordId": scene["id"], "regionId": region["id"], "split": scene["split"],
                "referenceNearestDepthM": nearest_truth, "referenceNearestBin": expected,
                "observedBin": observed, "hasDepthClaim": accepted,
                "wrongBin": accepted and observed != expected, "missedNearWithDepthClaim": near_missed,
                "falseFarClaim": expected == "near" and observed == "far",
                "falseClearClaim": region["wholeSectorClearCertified"],
                "interpreterExpectedBin": observed,
                "qualifiedEvidenceEligible": agreement and region["validCoverage"] >= .2,
                "eligibilityMeaning": "post-grading subset for interpreting accurate sensor facts only; excluded regions remain in every sensing denominator",
                "exclusionReason": None if agreement else "unknown/boundary or sensor nearest-bin disagrees with reference",
                "pixelMetrics": metrics(result["depth"][y0:y1, x0:x1], result["valid"][y0:y1, x0:x1], reference, valid_ref)}
        region_grades.append(item)
    output["regionCounts"] = {"total": len(region_grades), "depthClaims": sum(x["hasDepthClaim"] for x in region_grades),
                              "wrongBins": sum(x["wrongBin"] for x in region_grades),
                              "missedNear": sum(x["missedNearWithDepthClaim"] for x in region_grades),
                              "falseFar": sum(x["falseFarClaim"] for x in region_grades),
                              "falseClear": sum(x["falseClearClaim"] for x in region_grades),
                              "qualifiedEvidence": sum(x["qualifiedEvidenceEligible"] for x in region_grades)}
    return output, region_grades

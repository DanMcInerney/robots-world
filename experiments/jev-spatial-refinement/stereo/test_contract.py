from __future__ import annotations
import inspect
import unittest
import numpy as np
import baseline_matching
import pipeline
from scenes import CALIBRATION, render, specs
from evaluation import pixel_metrics


class StereoContract(unittest.TestCase):
    def test_fixed_plan_split_and_factorial(self):
        cases=specs()
        self.assertEqual(len(cases),56)
        self.assertEqual(sum(s["split"]=="development" for s in cases),8)
        self.assertEqual(sum(s["split"]=="confirmation" and s["family"]=="thin" for s in cases),36)
        self.assertEqual(len({s["id"] for s in cases}),56)

    def test_sgbm5_exact_historical_pipeline_parity(self):
        images,_=render(specs()[0])
        old=baseline_matching.estimate(*images,CALIBRATION)
        new=pipeline.estimate("sgbm5",*images,CALIBRATION)
        for key in ("rawLeft","rawRight","disparity","depth","rawValid","valid","leftRightErrorPx","textureStd"):
            np.testing.assert_array_equal(old[key],new[key])
        self.assertEqual(baseline_matching.make_regions(old,CALIBRATION),pipeline.make_regions(new,CALIBRATION))

    def test_mixed_hazards_never_drop_from_denominator(self):
        truth=dict(depth=np.array([[1.,1.,4.]],np.float32),hazardFraction=np.array([[.25,1.,0.]]),
                   homogeneous=np.array([[False,True,True]]))
        result=dict(depth=np.array([[4.,1.,4.]]),valid=np.array([[True,False,True]]))
        score=pixel_metrics(result,truth,"valid")
        self.assertEqual(score["hazardPixels"],2)
        self.assertEqual(score["hazardFalseFarPixels"],1)
        self.assertEqual(score["hazardUnknownPixels"],1)
        self.assertEqual(score["homogeneousScoredPixels"],1)

    def test_estimator_boundary_and_depth_convention(self):
        self.assertEqual(list(inspect.signature(pipeline.estimate).parameters),["arm","left","right","calibration"])
        depths=baseline_matching.depth_from_disparity(np.array([[24.,12.,6.]],np.float32),CALIBRATION)
        np.testing.assert_array_equal(depths,np.array([[1.,2.,4.]],np.float32))

    def test_all_matchers_explicit_blank_unknown(self):
        blank=np.full((360,640),128,np.uint8)
        for arm in pipeline.PARAMETERS:
            result=pipeline.estimate(arm,blank,blank,CALIBRATION)
            self.assertEqual(int(result["valid"].sum()),0)
            self.assertTrue(all(r["depthBin"]=="unknown" for r in pipeline.make_regions(result,CALIBRATION)))


if __name__=="__main__":unittest.main()

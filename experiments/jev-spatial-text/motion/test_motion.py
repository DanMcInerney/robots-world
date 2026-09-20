"""Mechanical unknown/epoch contracts; no inference or external service."""
import unittest

import numpy as np

from estimate import Odometry
from render import CALIBRATION


class MotionContract(unittest.TestCase):
    def test_blank_pair_does_not_invent_an_anchor(self):
        engine=Odometry(CALIBRATION)
        blank=np.zeros((CALIBRATION["height"],CALIBRATION["width"]),np.uint8)
        record,_=engine.process(blank,blank,"unknown-acquisition")
        self.assertEqual(record["status"],"unknown")
        self.assertIsNone(record["pose"])
        self.assertIsNone(engine.reference)
        self.assertEqual(record["failureReason"],"insufficient-depth-supported-features-to-anchor")

    def test_epoch_reset_rejects_previous_landmark_authority(self):
        engine=Odometry(CALIBRATION)
        old_epoch=engine.epoch
        engine.landmarks["old-point"]=np.array([1.,2.,3.])
        self.assertEqual(engine.join(old_epoch,"old-point")["position"],[1.,2.,3.])
        engine.reset()
        self.assertEqual(engine.join(old_epoch,"old-point"),dict(status="stale-epoch",position=None))
        self.assertEqual(engine.join(engine.epoch,"old-point"),dict(status="unknown-id",position=None))
        self.assertEqual(engine.landmarks,{})
        self.assertEqual(engine.ids,[])
        self.assertIsNone(engine.reference)


if __name__=="__main__":
    unittest.main(verbosity=2)

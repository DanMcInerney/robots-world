"""Deterministic mechanics only; no learned model/stereo predictions."""
import json
import unittest
import cv2
import numpy as np
from common import OUT
from measurement import observe,target


class Contract(unittest.TestCase):
    def setUp(self):
        self.cal=dict(fx=400,cx=49.5,baselineM=.2,doffsPx=2)
        self.image=np.zeros((100,100,3),np.uint8);self.image[20:80,25:75]=[180,60,25]
        self.depth=np.full((100,100),10,np.float32)
        self.disparity=np.full((100,100),6,np.float32)
        self.valid=np.ones((100,100),bool)

    def test_metric_disparity_offset_and_interval_order(self):
        observation,roi=observe(self.image,self.cal,self.depth,self.valid,'stereo',self.disparity)
        self.assertEqual(observation['targetStatus'],'single')
        self.assertEqual(observation['axialDepthM'],10)
        self.assertAlmostEqual(observation['axialDepthIntervalM'][0],80/8.5)
        self.assertAlmostEqual(observation['axialDepthIntervalM'][1],80/7.5)
        self.assertEqual(int(roi.sum()),44*54)

    def test_insufficient_support_is_null(self):
        valid=self.valid.copy();valid[:55]=False
        observation,_=observe(self.image,self.cal,self.depth,valid,'monocular')
        self.assertIsNone(observation['axialDepthM'])
        self.assertIsNone(observation['axialDepthIntervalM'])

    def test_multiple_and_missing_components_abstain(self):
        for image,status in [(np.zeros_like(self.image),'missing'),(self.image.copy(),'ambiguous')]:
            if status=='ambiguous':
                image[20:80,46:54]=0
            observation,_=observe(image,self.cal,self.depth,self.valid,'monocular')
            self.assertEqual(observation['targetStatus'],status)
            self.assertIsNone(observation['axialDepthM'])

    def test_dense_mono_is_not_confidence(self):
        observation,_=observe(self.image,self.cal,self.depth,self.valid,'monocular')
        self.assertEqual(observation['axialDepthIntervalM'],[10,10])
        self.assertIn('not a confidence interval',observation['intervalMeaning'])

    def test_input_counts_and_declared_detector_status(self):
        inputs=json.loads((OUT/'input-manifest.json').read_text())
        truth={x['sceneId']:x for x in json.loads((OUT/'evaluation-truth.json').read_text())}
        self.assertEqual(len(inputs),27)
        self.assertEqual(sum(x['kind']=='synthetic' for x in inputs),24)
        for item in inputs:
            if item['kind']!='synthetic':
                continue
            from common import ROOT
            cal=json.loads((ROOT/item['calibrationPath']).read_text())
            image=cv2.imread(str(ROOT/item['leftPath']))
            expected={'ambiguous':'ambiguous','missing':'missing','dark':'missing'}.get(truth[item['id']]['family'],'single')
            self.assertEqual(target(image,cal)[0],expected,item['id'])
            self.assertEqual(image.shape,(360,640,3))


if __name__=='__main__':
    unittest.main()

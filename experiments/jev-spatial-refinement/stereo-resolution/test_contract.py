import unittest
import numpy as np
from scenes import BASE,calibration,physical_scenes,specs,render_master,equivalence
from pipeline import parameters,estimate
import baseline_matching


class Contract(unittest.TestCase):
    def test_projection_and_search_scale(self):
        self.assertEqual(len(specs()),12)
        self.assertEqual(len({s['id'] for s in specs()}),12)
        for scene in physical_scenes():
            for scale in (1,2,4):
                c=calibration(scale)
                projected=c['fx']*scene['poleWidthM']/scene['nearM']
                self.assertAlmostEqual(projected,scene['baseWidthPx']*scale)
                u=c['fx']*scene['poleCenterXM']/scene['nearM']+c['cx']
                expected=(160.+scene['basePositionPhasePx']+.5)*scale-.5
                self.assertAlmostEqual(u,expected)
                self.assertEqual(parameters(scale)['numDisparities']/c['fx'],.32)
                self.assertLess(c['fx']*c['baselineM']/scene['nearM'],parameters(scale)['numDisparities']-2)

    def test_common_sample_texture_and_hazard_equivalence(self):
        scene=physical_scenes()[1]
        images,hazard=render_master(scene)
        self.assertEqual(len(equivalence(images,hazard,scene)),3)

    def test_historical_640px_configuration(self):
        self.assertEqual(parameters(2),baseline_matching.PARAMETERS)
        blank=np.full((360,640),128,np.uint8)
        before=baseline_matching.estimate(blank,blank,calibration(2))
        after,regions=estimate(blank,blank,calibration(2),2)
        for key in ('rawLeft','rawRight','valid','depth'):
            np.testing.assert_array_equal(before[key],after[key])
        self.assertTrue(all(r['depthBin']=='unknown' for r in regions))


if __name__=='__main__':unittest.main()
